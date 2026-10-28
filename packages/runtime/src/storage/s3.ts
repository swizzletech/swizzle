import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { Readable } from "node:stream";
import type { S3Client } from "@aws-sdk/client-s3";
import { stringifyAutomationConfig } from "@swizzle/config";
import { controlEgressAgentOptions, createDisplayName } from "@swizzle/core";
import { AutomationRuntimeError } from "../errors.js";
import { createArtifactStorageNotWritableError } from "./errors.js";
import {
  collectFilesRecursively,
  createArtifactManifest,
  createArtifactStorageReadinessFailure,
  toPosixPath,
  withMaterializedSource,
} from "./files.js";
import type {
  ArtifactStorage,
  ArtifactStorageReference,
  ReadArtifactTextFileResult,
  S3ArtifactLocator,
} from "./types.js";

/** The client of one S3-backed storage and the SDK module its commands come from. */
interface S3Connection {
  readonly client: S3Client;
  readonly sdk: typeof import("@aws-sdk/client-s3");
}

export function createS3ArtifactStorage(options: {
  readonly bucket: string;
  readonly endpoint: string | null;
  readonly forcePathStyle: boolean;
  readonly prefix: string | null;
  readonly region: string;
}): ArtifactStorage {
  // The SDK's own agents, plus the control egress proxy: the Compose worker reaches no endpoint
  // outside the stack except through it.
  const agentOptions = { keepAlive: true, maxSockets: 50, ...controlEgressAgentOptions() };
  // The AWS SDK takes longer to import than the rest of the runtime, so the storage loads it on
  // first use: a local-backend install and the CLI never pay for it.
  let connection: Promise<S3Connection> | undefined;
  const connect = () =>
    (connection ??= import("@aws-sdk/client-s3").then((sdk) => ({
      client: new sdk.S3Client({
        ...(options.endpoint ? { endpoint: options.endpoint } : {}),
        forcePathStyle: options.forcePathStyle,
        region: options.region,
        requestHandler: {
          httpAgent: new http.Agent(agentOptions),
          httpsAgent: new https.Agent(agentOptions),
        },
      }),
      sdk,
    })));
  const readinessTarget = createS3ReadinessTarget(options.bucket, options.prefix);

  return {
    backend: "s3",

    async checkReadiness() {
      const s3 = await connect();
      const probeContents = randomUUID();
      const probeKey = options.prefix
        ? joinS3Key(options.prefix, ".swizzle-readiness", `${randomUUID()}.probe`)
        : joinS3Key(".swizzle-readiness", `${randomUUID()}.probe`);
      let failure: unknown;

      try {
        await s3.client.send(
          new s3.sdk.PutObjectCommand({
            Body: probeContents,
            Bucket: options.bucket,
            ContentType: "text/plain; charset=utf-8",
            Key: probeKey,
          }),
        );
        const response = await s3.client.send(
          new s3.sdk.GetObjectCommand({
            Bucket: options.bucket,
            Key: probeKey,
          }),
        );
        if ((await readS3BodyAsBuffer(response.Body)).toString("utf8") !== probeContents) {
          throw new Error("Artifact storage readiness probe returned different contents.");
        }
      } catch (error) {
        failure = error;
      }

      try {
        const deleteResponse = await s3.client.send(
          new s3.sdk.DeleteObjectsCommand({
            Bucket: options.bucket,
            Delete: { Objects: [{ Key: probeKey }], Quiet: true },
          }),
        );
        if ((deleteResponse.Errors?.length ?? 0) > 0) {
          throw new Error("Artifact storage readiness probe cleanup was rejected.");
        }
      } catch (error) {
        failure ??= error;
      }

      return failure === undefined
        ? {
            backend: "s3",
            ok: true,
            target: readinessTarget,
          }
        : createArtifactStorageReadinessFailure("s3", readinessTarget, failure);
    },

    async createDeploymentArtifacts(input) {
      const s3 = await connect();
      const relativeRootPath = toPosixPath(
        path.posix.join(createDisplayName(input.automationName), input.version, input.deploymentId),
      );
      const keyPrefix = options.prefix
        ? joinS3Key(options.prefix, relativeRootPath)
        : relativeRootPath;
      const locator: S3ArtifactLocator = {
        bucket: options.bucket,
        endpoint: options.endpoint,
        forcePathStyle: options.forcePathStyle,
        keyPrefix,
        region: options.region,
        type: "s3",
      };
      const reference = buildS3Reference(locator);

      for (const relativePath of input.includedFiles) {
        const body =
          relativePath === "config.yaml"
            ? stringifyAutomationConfig(input.config)
            : await readFile(path.join(input.automationDirectory, relativePath));
        try {
          await s3.client.send(
            new s3.sdk.PutObjectCommand({
              Body: body,
              Bucket: locator.bucket,
              ContentType: guessContentType(relativePath),
              Key: joinS3Key(locator.keyPrefix, "source", relativePath),
            }),
          );
        } catch (error) {
          throw createArtifactStorageNotWritableError("s3", readinessTarget, error);
        }
      }

      try {
        await s3.client.send(
          new s3.sdk.PutObjectCommand({
            Body: `${JSON.stringify(createArtifactManifest(input, reference), null, 2)}\n`,
            Bucket: locator.bucket,
            ContentType: "application/json",
            Key: joinS3Key(locator.keyPrefix, "deployment.json"),
          }),
        );
      } catch (error) {
        throw createArtifactStorageNotWritableError("s3", readinessTarget, error);
      }

      return reference;
    },

    async deleteAutomationArtifacts(automationName) {
      const s3 = await connect();
      const slug = createDisplayName(automationName);
      const prefix = options.prefix ? `${joinS3Key(options.prefix, slug)}/` : `${slug}/`;
      await deleteS3Prefix(s3, options.bucket, prefix);
    },

    async deleteDeploymentArtifacts(reference) {
      const s3 = await connect();
      const locator = requireS3Locator(reference);
      await deleteS3Prefix(s3, locator.bucket, `${locator.keyPrefix}/`);
    },

    async exportDeploymentBundle(reference, targetDirectory) {
      const s3 = await connect();
      const locator = requireS3Locator(reference);
      await validateS3Deployment(s3, reference);
      await rm(targetDirectory, { force: true, recursive: true });
      await mkdir(path.join(targetDirectory, "source"), { recursive: true });

      const manifestResponse = await s3.client.send(
        new s3.sdk.GetObjectCommand({
          Bucket: locator.bucket,
          Key: joinS3Key(locator.keyPrefix, "deployment.json"),
        }),
      );
      await writeFile(
        path.join(targetDirectory, "deployment.json"),
        await readS3BodyAsBuffer(manifestResponse.Body),
      );

      await copyS3PrefixToDirectory(
        s3,
        locator.bucket,
        joinS3Key(locator.keyPrefix, "source/"),
        path.join(targetDirectory, "source"),
      );

      return reference;
    },

    async exportStore(targetDirectory) {
      await mkdir(targetDirectory, { mode: 0o700 });
      const s3 = await connect();
      const prefix = options.prefix ? `${joinS3Key(options.prefix)}/` : "";

      await copyS3PrefixToDirectory(s3, options.bucket, prefix, targetDirectory);
    },

    async importDeploymentBundle(input) {
      const s3 = await connect();
      const locator = input.locator.type === "s3" ? input.locator : null;
      if (locator === null) {
        throw new AutomationRuntimeError(
          "DEPLOYMENT_ARTIFACTS_MISSING",
          "Cannot restore S3 deployment bundle without an S3 artifact locator.",
        );
      }

      for (const relativePath of await collectFilesRecursively(input.bundleDirectory)) {
        await s3.client.send(
          new s3.sdk.PutObjectCommand({
            Body: await readFile(path.join(input.bundleDirectory, relativePath)),
            Bucket: locator.bucket,
            ContentType: guessContentType(relativePath),
            Key: joinS3Key(locator.keyPrefix, relativePath),
          }),
        );
      }

      const reference = buildS3Reference(locator);
      await validateS3Deployment(s3, reference);
      return reference;
    },

    async importStore(sourceDirectory) {
      const s3 = await connect();
      await deleteS3Prefix(
        s3,
        options.bucket,
        options.prefix ? `${joinS3Key(options.prefix)}/` : "",
      );
      for (const relativePath of await collectFilesRecursively(sourceDirectory)) {
        await s3.client.send(
          new s3.sdk.PutObjectCommand({
            Body: await readFile(path.join(sourceDirectory, relativePath)),
            Bucket: options.bucket,
            ContentType: guessContentType(relativePath),
            Key: options.prefix ? joinS3Key(options.prefix, relativePath) : relativePath,
          }),
        );
      }
    },

    async withSourceDirectory(reference, use) {
      const s3 = await connect();
      const locator = requireS3Locator(reference);
      return await withMaterializedSource(
        (directory) =>
          copyS3PrefixToDirectory(
            s3,
            locator.bucket,
            joinS3Key(locator.keyPrefix, "source/"),
            directory,
          ),
        use,
      );
    },

    async readTextFile(reference, relativePath) {
      const s3 = await connect();
      const locator = requireS3Locator(reference);

      try {
        const response = await s3.client.send(
          new s3.sdk.GetObjectCommand({
            Bucket: locator.bucket,
            Key: joinS3Key(locator.keyPrefix, "source", relativePath),
          }),
        );
        return {
          content: (await readS3BodyAsBuffer(response.Body)).toString("utf8"),
          filePath: `${reference.sourceDirectory}/${toPosixPath(relativePath)}`,
        } satisfies ReadArtifactTextFileResult;
      } catch (error) {
        if (isS3NotFound(error)) {
          return null;
        }
        throw error;
      }
    },

    async validateDeploymentArtifacts(reference) {
      const s3 = await connect();
      await validateS3Deployment(s3, reference);
    },
  } satisfies ArtifactStorage;
}

function buildS3Reference(locator: S3ArtifactLocator): ArtifactStorageReference {
  const artifactRootPath = `s3://${locator.bucket}/${locator.keyPrefix}`;
  return {
    artifactBackend: "s3",
    artifactLocator: locator,
    artifactRootPath,
    manifestPath: `${artifactRootPath}/deployment.json`,
    sourceDirectory: `${artifactRootPath}/source`,
  };
}

function requireS3Locator(reference: ArtifactStorageReference): S3ArtifactLocator {
  if (reference.artifactLocator.type !== "s3") {
    throw new AutomationRuntimeError(
      "DEPLOYMENT_ARTIFACTS_MISSING",
      `Expected an S3 artifact locator for deployment artifacts: ${reference.artifactRootPath}`,
    );
  }

  return reference.artifactLocator;
}

async function validateS3Deployment(
  s3: S3Connection,
  reference: ArtifactStorageReference,
): Promise<void> {
  const locator = requireS3Locator(reference);

  try {
    await s3.client.send(
      new s3.sdk.HeadObjectCommand({
        Bucket: locator.bucket,
        Key: joinS3Key(locator.keyPrefix, "deployment.json"),
      }),
    );
    const listResponse = await s3.client.send(
      new s3.sdk.ListObjectsV2Command({
        Bucket: locator.bucket,
        MaxKeys: 1,
        Prefix: joinS3Key(locator.keyPrefix, "source/"),
      }),
    );
    if ((listResponse.Contents ?? []).length === 0) {
      throw new Error("source-missing");
    }
  } catch (error) {
    if (isS3NotFound(error) || (error instanceof Error && error.message === "source-missing")) {
      throw new AutomationRuntimeError(
        "DEPLOYMENT_ARTIFACTS_MISSING",
        `Deployment artifacts not found at: ${reference.artifactRootPath}`,
      );
    }

    throw error;
  }
}

async function readS3BodyAsBuffer(body: unknown): Promise<Buffer> {
  if (body === undefined || body === null) {
    return Buffer.alloc(0);
  }

  if (typeof body === "string") {
    return Buffer.from(body);
  }

  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }

  if (body instanceof Readable) {
    const chunks: Buffer[] = [];
    for await (const chunk of body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  if (
    typeof body === "object" &&
    body !== null &&
    "transformToByteArray" in body &&
    typeof body.transformToByteArray === "function"
  ) {
    return Buffer.from(await body.transformToByteArray());
  }

  return Buffer.from(String(body));
}

async function deleteS3Prefix(s3: S3Connection, bucket: string, prefix: string): Promise<void> {
  const keys: string[] = [];
  for await (const key of listS3Keys(s3, bucket, prefix)) {
    keys.push(key);
  }

  for (let index = 0; index < keys.length; index += 1_000) {
    const batch = keys.slice(index, index + 1_000);
    if (batch.length === 0) {
      continue;
    }

    await s3.client.send(
      new s3.sdk.DeleteObjectsCommand({
        Bucket: bucket,
        Delete: {
          Objects: batch.map((key) => ({ Key: key })),
          Quiet: true,
        },
      }),
    );
  }
}

function guessContentType(filePath: string): string | undefined {
  if (filePath.endsWith(".json")) {
    return "application/json";
  }
  if (filePath.endsWith(".yaml") || filePath.endsWith(".yml")) {
    return "application/yaml";
  }
  if (
    filePath.endsWith(".md") ||
    filePath.endsWith(".mermaid") ||
    filePath.endsWith(".ts") ||
    filePath.endsWith(".js") ||
    filePath.endsWith(".py")
  ) {
    return "text/plain; charset=utf-8";
  }

  return undefined;
}

function joinS3Key(...segments: readonly string[]): string {
  return segments
    .map((segment) => segment.replace(/^\/+|\/+$/g, ""))
    .filter((segment) => segment.length > 0)
    .join("/");
}

export function createS3ReadinessTarget(bucket: string, prefix: string | null): string {
  return prefix ? `s3://${bucket}/${prefix}` : `s3://${bucket}`;
}

function isS3NotFound(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const metadata = (error as Error & { readonly $metadata?: { readonly httpStatusCode?: number } })
    .$metadata;
  return (
    metadata?.httpStatusCode === 404 ||
    error.name === "NotFound" ||
    error.name === "NoSuchKey" ||
    error.name === "NoSuchBucket"
  );
}

async function* listS3Keys(
  s3: S3Connection,
  bucket: string,
  prefix: string,
): AsyncGenerator<string> {
  let continuationToken: string | undefined;

  while (true) {
    const response = await s3.client.send(
      new s3.sdk.ListObjectsV2Command({
        Bucket: bucket,
        ContinuationToken: continuationToken,
        Prefix: prefix,
      }),
    );

    for (const object of response.Contents ?? []) {
      if (object.Key) {
        yield object.Key;
      }
    }

    if (!response.IsTruncated) {
      return;
    }

    continuationToken = response.NextContinuationToken;
  }
}

async function copyS3PrefixToDirectory(
  s3: S3Connection,
  bucket: string,
  prefix: string,
  directory: string,
): Promise<void> {
  for await (const key of listS3Keys(s3, bucket, prefix)) {
    const relativePath = key.slice(prefix.length);
    if (relativePath === "") continue;
    const response = await s3.client.send(
      new s3.sdk.GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    const destination = path.join(directory, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, await readS3BodyAsBuffer(response.Body));
  }
}
