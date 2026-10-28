import { chmod, cp, open, readdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { parseAutomationConfig } from "@swizzle/config";
import { describe, expect, it, vi } from "vitest";
import { recordingProxy, temporaryDirectory } from "../../../test/support.js";
import { deployAutomation } from "./deploy.js";
import {
  checkConfiguredArtifactStorageReadiness,
  createArtifactStorageForReference,
  createConfiguredArtifactStorage,
} from "./storage.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, cp: vi.fn(actual.cp) };
});

const sourceRoot = fileURLToPath(new URL(".", import.meta.url));
const packageRoot = path.resolve(sourceRoot, "..");
const repoRoot = path.resolve(packageRoot, "../..");

describe("artifact storage", () => {
  it.each(["local", "s3"])(
    "refuses an existing %s store export target without modifying it",
    async (backend) => {
      const target = await temporaryDirectory("swizzle-store-export-existing-");
      await writeFile(path.join(target, "main.js"), "previous code");
      const storage = createConfiguredArtifactStorage({
        environment: { SWIZZLE_ARTIFACT_BACKEND: backend, SWIZZLE_ARTIFACT_S3_BUCKET: "fixture" },
      });
      await expect(storage.exportStore(target)).rejects.toMatchObject({ code: "EEXIST" });
      expect(await readdir(target)).toEqual(["main.js"]);
      expect(await readFile(path.join(target, "main.js"), "utf8")).toBe("previous code");
    },
  );

  it.each(["local", "s3"] as const)(
    "removes a partial %s source when copying fails",
    async (backend) => {
      const artifactsDirectory = await temporaryDirectory("swizzle-copy-fixture-");
      const deployment = await deployAutomation({
        artifactsDirectory,
        automationDirectory: path.join(repoRoot, "infra/examples/hello-webhook"),
        deploymentId: "copy-failure",
      });
      const scratch = await temporaryDirectory("swizzle-copy-scratch-");
      vi.spyOn(os, "tmpdir").mockReturnValue(scratch);
      const failure = new Error("injected partial copy failure");
      if (backend === "local") {
        vi.mocked(cp).mockImplementationOnce(async (_source, destination) => {
          await writeFile(path.join(String(destination), "partial.txt"), "partial");
          throw failure;
        });
      } else {
        vi.spyOn(S3Client.prototype, "send").mockImplementation(async (command: unknown) => {
          if (command instanceof ListObjectsV2Command)
            return {
              Contents: [{ Key: "fixture/source/partial.txt" }, { Key: "fixture/source/fail.txt" }],
            };
          if (command instanceof GetObjectCommand) {
            if (command.input.Key?.endsWith("fail.txt")) throw failure;
            return { Body: Buffer.from("partial") };
          }
          throw new Error("Unexpected S3 command");
        });
      }
      const reference =
        backend === "local"
          ? deployment
          : {
              ...deployment,
              artifactBackend: "s3" as const,
              artifactLocator: {
                type: "s3" as const,
                bucket: "fixture",
                keyPrefix: "fixture",
                region: "us-east-1",
                endpoint: null,
                forcePathStyle: false,
              },
            };
      const storage = createArtifactStorageForReference(reference);
      await expect(
        storage.withSourceDirectory(reference, async () => {
          throw new Error("Copy should fail before use");
        }),
      ).rejects.toBe(failure);
      expect(await readdir(scratch)).toEqual([]);
    },
  );

  it("probes the configured local artifact root directly and removes the probe file", async () => {
    const artifactsDirectory = await temporaryDirectory("swizzle-artifacts-");

    const storage = createConfiguredArtifactStorage({ artifactsDirectory });
    await expect(storage.checkReadiness()).resolves.toEqual({
      backend: "local",
      ok: true,
      target: artifactsDirectory,
    });
    expect(await readdir(artifactsDirectory)).toEqual([]);
  });

  it("reports an unwritable local artifact root and types deployment failures", async () => {
    const artifactsDirectory = await temporaryDirectory("swizzle-artifacts-");
    await chmod(artifactsDirectory, 0o555);

    try {
      const storage = createConfiguredArtifactStorage({ artifactsDirectory });
      await expect(storage.checkReadiness()).resolves.toMatchObject({
        backend: "local",
        code: "ARTIFACT_STORAGE_NOT_WRITABLE",
        ok: false,
        target: artifactsDirectory,
      });
      await expect(
        deployAutomation({
          artifactsDirectory,
          automationDirectory: path.join(repoRoot, "infra/examples/hello-webhook"),
          deploymentId: "deployment-unwritable-store",
        }),
      ).rejects.toMatchObject({
        code: "ARTIFACT_STORAGE_NOT_WRITABLE",
        details: {
          backend: "local",
          target: artifactsDirectory,
        },
      });
    } finally {
      await chmod(artifactsDirectory, 0o755);
    }
  });

  it("restores an exported local store under a new root and reads it through the stored deployment", async () => {
    const artifactsDirectory = await temporaryDirectory("swizzle-artifacts-");
    const backupDirectory = await temporaryDirectory("swizzle-artifacts-backup-");
    const restoredDirectory = await temporaryDirectory("swizzle-artifacts-restore-");

    const deployment = await deployAutomation({
      artifactsDirectory,
      automationDirectory: path.join(repoRoot, "infra/examples/hello-webhook"),
      deploymentId: "deployment-local-reference-priority",
    });

    const sourceStorage = createConfiguredArtifactStorage({ artifactsDirectory });
    await sourceStorage.exportStore(path.join(backupDirectory, "artifacts"));
    const restoredStorage = createConfiguredArtifactStorage({
      artifactsDirectory: restoredDirectory,
    });
    await writeFile(path.join(restoredDirectory, "stale.txt"), "stale", "utf8");
    // In the stack the store is a volume mount point: import must empty it, not replace it.
    // The open handle keeps the inode allocated, so a delete-and-recreate cannot reuse it.
    const handle = await open(restoredDirectory, "r");
    const before = await stat(restoredDirectory);
    try {
      await restoredStorage.importStore(path.join(backupDirectory, "artifacts"));
      const after = await stat(restoredDirectory);
      expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
    } finally {
      await handle.close();
    }
    expect(await readdir(restoredDirectory)).toEqual(["hello-webhook"]);

    const storage = createArtifactStorageForReference(deployment, {
      artifactsDirectory: restoredDirectory,
    });
    await storage.validateDeploymentArtifacts(deployment);

    const config = await storage.readTextFile(deployment, "config.yaml");
    expect(config?.content).toContain("name: hello-webhook");
    expect(config?.filePath).toContain(restoredDirectory);
    expect(config?.filePath).not.toContain(artifactsDirectory);
  });

  it.each(["main.py", "./main.py", "src/../main.py"])(
    "creates, reads, and materializes S3-backed artifacts with entrypoint %s",
    async (entrypoint) => {
      const s3Objects = new Map<string, Buffer>();
      vi.spyOn(S3Client.prototype, "send").mockImplementation(async (command: unknown) => {
        if (command instanceof PutObjectCommand) {
          const key = String(command.input.Key);
          const body = command.input.Body;
          s3Objects.set(
            key,
            Buffer.isBuffer(body)
              ? body
              : body instanceof Uint8Array
                ? Buffer.from(body)
                : Buffer.from(String(body ?? "")),
          );
          return {};
        }

        if (command instanceof HeadObjectCommand) {
          const key = String(command.input.Key);
          if (!s3Objects.has(key)) {
            const error = new Error("Not found");
            error.name = "NotFound";
            throw error;
          }
          return {};
        }

        if (command instanceof GetObjectCommand) {
          const key = String(command.input.Key);
          const body = s3Objects.get(key);
          if (!body) {
            const error = new Error("Not found");
            error.name = "NoSuchKey";
            throw error;
          }
          return { Body: body };
        }

        if (command instanceof DeleteObjectsCommand) {
          for (const object of command.input.Delete?.Objects ?? []) {
            if (object.Key) {
              s3Objects.delete(object.Key);
            }
          }
          return {};
        }

        if (command instanceof ListObjectsV2Command) {
          const prefix = String(command.input.Prefix ?? "");
          return {
            Contents: [...s3Objects.keys()]
              .filter((key) => key.startsWith(prefix))
              .slice(0, command.input.MaxKeys ?? Number.MAX_SAFE_INTEGER)
              .map((key) => ({ Key: key })),
            IsTruncated: false,
          };
        }

        throw new Error(
          `Unexpected S3 command: ${String((command as { constructor?: { name?: string } }).constructor?.name)}`,
        );
      });

      vi.stubEnv("SWIZZLE_ARTIFACT_BACKEND", "s3");
      vi.stubEnv("SWIZZLE_ARTIFACT_S3_BUCKET", "swizzle-test");
      vi.stubEnv("SWIZZLE_ARTIFACT_S3_ENDPOINT", "http://minio:9000");
      vi.stubEnv("SWIZZLE_ARTIFACT_S3_FORCE_PATH_STYLE", "true");
      vi.stubEnv("SWIZZLE_ARTIFACT_S3_PREFIX", "artifacts");
      vi.stubEnv("SWIZZLE_ARTIFACT_S3_REGION", "us-east-1");

      const automationDirectory = await temporaryDirectory("swizzle-s3-entrypoint-");
      await cp(path.join(repoRoot, "infra/examples/hello-webhook"), automationDirectory, {
        recursive: true,
      });
      const configPath = path.join(automationDirectory, "config.yaml");
      await writeFile(
        configPath,
        (await readFile(configPath, "utf8")).replace(
          "entrypoint: main.py",
          `entrypoint: ${entrypoint}`,
        ),
      );
      await writeFile(
        path.join(automationDirectory, "main.py"),
        'run_step("fetch", lambda: {"ok": True})\n',
      );

      const deployment = await deployAutomation({
        automationDirectory,
        deploymentId: "deployment-s3-store",
      });

      expect(deployment.artifactBackend).toBe("s3");
      expect(deployment.buildSnapshot.stepSites).toEqual([
        { key: "fetch", kind: "step", startLine: 1, endLine: 1, target: null },
      ]);
      expect(deployment.artifactRootPath).toBe(
        "s3://swizzle-test/artifacts/hello-webhook/1.0.0/deployment-s3-store",
      );

      const storage = createArtifactStorageForReference(deployment);
      await expect(storage.checkReadiness()).resolves.toEqual({
        backend: "s3",
        ok: true,
        target: "s3://swizzle-test/artifacts",
      });
      await storage.validateDeploymentArtifacts(deployment);

      const mermaid = await storage.readTextFile(deployment, "flow.mermaid");
      expect(mermaid?.content).toContain("graph TD");

      let copiedDirectory = "";
      await storage.withSourceDirectory(deployment, async (directory) => {
        copiedDirectory = directory;
        const config = await readFile(path.join(directory, "config.yaml"), "utf8");
        expect(config).toContain("name: hello-webhook");
        expect(parseAutomationConfig(config, "deployment").runtime.binary_version_matching).toBe(
          "numeric-prefix",
        );
      });
      await expect(stat(copiedDirectory)).rejects.toMatchObject({ code: "ENOENT" });

      const bundleDirectory = await temporaryDirectory("swizzle-s3-bundle-");
      await storage.exportDeploymentBundle(deployment, bundleDirectory);
      expect(await readFile(path.join(bundleDirectory, "deployment.json"), "utf8")).toContain(
        '"artifactBackend": "s3"',
      );

      const backupDirectory = path.join(
        await temporaryDirectory("swizzle-s3-backup-"),
        "artifacts",
      );
      await storage.exportStore(backupDirectory);
      await writeFile(path.join(backupDirectory, "extra.txt"), "restored", "utf8");
      await storage.importStore(backupDirectory);
      expect(s3Objects.has("artifacts/extra.txt")).toBe(true);
    },
  );

  it("reports denied S3 probe writes without exposing credentials", async () => {
    vi.spyOn(S3Client.prototype, "send").mockImplementation(async (command: unknown) => {
      if (command instanceof DeleteObjectsCommand) return {};
      if (command instanceof PutObjectCommand) {
        const error = new Error("Access denied");
        error.name = "AccessDenied";
        throw error;
      }
      throw new Error("Unexpected S3 readiness command");
    });

    vi.stubEnv("SWIZZLE_ARTIFACT_BACKEND", "s3");
    vi.stubEnv("SWIZZLE_ARTIFACT_S3_BUCKET", "swizzle-denied");
    vi.stubEnv("SWIZZLE_ARTIFACT_S3_ENDPOINT", "http://user:secret@minio:9000");
    vi.stubEnv("SWIZZLE_ARTIFACT_S3_FORCE_PATH_STYLE", "true");
    vi.stubEnv("SWIZZLE_ARTIFACT_S3_PREFIX", "artifacts");
    vi.stubEnv("SWIZZLE_ARTIFACT_S3_REGION", "us-east-1");

    const result = await createConfiguredArtifactStorage().checkReadiness();
    expect(result).toMatchObject({
      backend: "s3",
      code: "ARTIFACT_STORAGE_NOT_WRITABLE",
      ok: false,
      target: "s3://swizzle-denied/artifacts",
    });
    expect(result.error).not.toContain("user:secret");
  });

  it("reports S3 probe cleanup errors returned in a successful response", async () => {
    const probeObjects = new Map<string, string>();
    vi.spyOn(S3Client.prototype, "send").mockImplementation(async (command: unknown) => {
      if (command instanceof PutObjectCommand) {
        probeObjects.set(String(command.input.Key), String(command.input.Body));
        return {};
      }
      if (command instanceof GetObjectCommand) {
        return { Body: Buffer.from(probeObjects.get(String(command.input.Key)) ?? "") };
      }
      if (command instanceof DeleteObjectsCommand) {
        return {
          Errors: [{ Code: "AccessDenied", Key: String(command.input.Delete?.Objects?.[0]?.Key) }],
        };
      }
      throw new Error("Unexpected S3 readiness command");
    });

    vi.stubEnv("SWIZZLE_ARTIFACT_BACKEND", "s3");
    vi.stubEnv("SWIZZLE_ARTIFACT_S3_BUCKET", "swizzle-delete-denied");
    vi.stubEnv("SWIZZLE_ARTIFACT_S3_PREFIX", "artifacts");

    await expect(createConfiguredArtifactStorage().checkReadiness()).resolves.toMatchObject({
      code: "ARTIFACT_STORAGE_NOT_WRITABLE",
      ok: false,
      target: "s3://swizzle-delete-denied/artifacts",
    });
  });

  it("turns invalid artifact configuration into a readiness failure", async () => {
    vi.stubEnv("SWIZZLE_ARTIFACT_BACKEND", "s3");
    vi.stubEnv("SWIZZLE_ARTIFACT_S3_BUCKET", undefined);

    await expect(checkConfiguredArtifactStorageReadiness()).resolves.toMatchObject({
      backend: "s3",
      code: "ARTIFACT_STORAGE_NOT_WRITABLE",
      ok: false,
      target: "s3://<unconfigured>",
    });
  });

  it("sends S3 requests through the control egress proxy", async () => {
    const proxy = await recordingProxy();
    vi.stubEnv("SWIZZLE_CONTROL_EGRESS_PROXY", proxy.url);
    vi.stubEnv("SWIZZLE_ARTIFACT_BACKEND", "s3");
    vi.stubEnv("SWIZZLE_ARTIFACT_S3_BUCKET", "swizzle-test");
    vi.stubEnv("SWIZZLE_ARTIFACT_S3_ENDPOINT", "http://s3.swizzle.invalid");
    vi.stubEnv("SWIZZLE_ARTIFACT_S3_FORCE_PATH_STYLE", "true");
    vi.stubEnv("SWIZZLE_ARTIFACT_S3_PREFIX", "artifacts");
    vi.stubEnv("AWS_ACCESS_KEY_ID", "test-access-key");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "test-secret-key");

    await createConfiguredArtifactStorage().checkReadiness();

    expect(proxy.requests[0]).toMatch(
      /^PUT http:\/\/s3\.swizzle\.invalid\/swizzle-test\/artifacts\/\.swizzle-readiness\//u,
    );
  });
});
