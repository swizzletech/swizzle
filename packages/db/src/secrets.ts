import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { ConfigurationError } from "@swizzle/core";

export const SWIZZLE_ENCRYPTION_KEY_ENV = "SWIZZLE_ENCRYPTION_KEY";
export const SWIZZLE_ENCRYPTION_PREVIOUS_KEYS_ENV = "SWIZZLE_ENCRYPTION_PREVIOUS_KEYS";
export const SECRET_ENCRYPTION_ALGORITHM = "aes-256-gcm";
export const SECRET_ENCRYPTION_KEY_VERSION = "v2";
const SECRET_ENCRYPTION_KEY_LENGTH_BYTES = 32;

export type SecretConfigurationErrorCode = "INVALID_ENCRYPTION_KEY" | "MISSING_ENCRYPTION_KEY";

export class SecretConfigurationError extends ConfigurationError {
  constructor(
    public override readonly code: SecretConfigurationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(code, message, options);
    this.name = "SecretConfigurationError";
  }
}

export interface SecretCipherEnvelope {
  readonly algorithm: string;
  readonly ciphertext: string;
  readonly keyVersion: string;
}

export function assertSecretEncryptionKeyIsConfigured(
  environment: NodeJS.ProcessEnv = process.env,
): void {
  try {
    void resolveSecretEncryptionKeyring(environment);
  } catch (error) {
    if (!(error instanceof SecretConfigurationError)) throw error;
    throw new SecretConfigurationError(
      error.code,
      `${error.message} Generate a key with ` +
        'python3 -c "import secrets; print(secrets.token_urlsafe(32))" and set it in .env. ' +
        "All swizzle services must share the same value.",
      { cause: error },
    );
  }
}

export function encryptSecretValue(
  value: string,
  environment: NodeJS.ProcessEnv = process.env,
): SecretCipherEnvelope {
  const key = resolveSecretEncryptionKeyring(environment)[0]?.key;
  if (key === undefined) {
    throw new SecretConfigurationError(
      "MISSING_ENCRYPTION_KEY",
      `${SWIZZLE_ENCRYPTION_KEY_ENV} must be configured before encrypting credentials.`,
    );
  }
  const keyVersion = deriveSecretEncryptionKeyVersion(key);
  const iv = randomBytes(12);
  const cipher = createCipheriv(SECRET_ENCRYPTION_ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    algorithm: SECRET_ENCRYPTION_ALGORITHM,
    ciphertext: [
      SECRET_ENCRYPTION_KEY_VERSION,
      keyVersion,
      iv.toString("base64"),
      authTag.toString("base64"),
      encrypted.toString("base64"),
    ].join("."),
    keyVersion,
  };
}

export function decryptSecretValue(
  envelope: Pick<SecretCipherEnvelope, "algorithm" | "ciphertext">,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (envelope.algorithm !== SECRET_ENCRYPTION_ALGORITHM) {
    throw new SecretConfigurationError(
      "INVALID_ENCRYPTION_KEY",
      `Unsupported secret encryption algorithm: ${envelope.algorithm}`,
    );
  }

  const [formatVersion, keyVersion, ivBase64, authTagBase64, encryptedBase64, ...rest] =
    envelope.ciphertext.split(".");
  if (
    formatVersion !== SECRET_ENCRYPTION_KEY_VERSION ||
    keyVersion === undefined ||
    ivBase64 === undefined ||
    authTagBase64 === undefined ||
    encryptedBase64 === undefined ||
    rest.length > 0
  ) {
    throw new SecretConfigurationError(
      "INVALID_ENCRYPTION_KEY",
      "Stored secret ciphertext has an invalid format.",
    );
  }

  const key = resolveSecretEncryptionKeyring(environment).find(
    (entry) => entry.version === keyVersion,
  )?.key;
  if (key === undefined) {
    throw new SecretConfigurationError(
      "INVALID_ENCRYPTION_KEY",
      `Stored secret requires encryption key version ${keyVersion}, which is not configured.`,
    );
  }

  try {
    const decipher = createDecipheriv(
      SECRET_ENCRYPTION_ALGORITHM,
      key,
      Buffer.from(ivBase64, "base64"),
    );
    decipher.setAuthTag(Buffer.from(authTagBase64, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedBase64, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch (error) {
    throw new SecretConfigurationError(
      "INVALID_ENCRYPTION_KEY",
      "Stored secret ciphertext could not be decrypted with its configured encryption key.",
      { cause: error },
    );
  }
}

export function resolveSecretEncryptionKey(environment: NodeJS.ProcessEnv = process.env): Buffer {
  const rawKey = environment[SWIZZLE_ENCRYPTION_KEY_ENV];
  if (rawKey === undefined || rawKey.trim() === "") {
    throw new SecretConfigurationError(
      "MISSING_ENCRYPTION_KEY",
      `${SWIZZLE_ENCRYPTION_KEY_ENV} must be set to a 32-byte secret before using platform secrets.`,
    );
  }

  const utf8Key = Buffer.from(rawKey, "utf8");
  if (utf8Key.byteLength === SECRET_ENCRYPTION_KEY_LENGTH_BYTES) {
    return utf8Key;
  }

  try {
    const base64Key = Buffer.from(rawKey, "base64");
    if (base64Key.byteLength === SECRET_ENCRYPTION_KEY_LENGTH_BYTES) {
      return base64Key;
    }
  } catch {
    // Ignore and fall through to the explicit validation error below.
  }

  throw new SecretConfigurationError(
    "INVALID_ENCRYPTION_KEY",
    `${SWIZZLE_ENCRYPTION_KEY_ENV} must be exactly 32 bytes (raw UTF-8) or a base64-encoded 32-byte key.`,
  );
}

export function deriveSecretEncryptionKeyVersion(key: Buffer): string {
  return `k_${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

/** The current key first, then the previous ones still accepted for reading. */
export function resolveSecretEncryptionKeyring(
  environment: NodeJS.ProcessEnv,
): readonly { readonly key: Buffer; readonly version: string }[] {
  const keys = [resolveSecretEncryptionKey(environment)];
  const rawPrevious = environment[SWIZZLE_ENCRYPTION_PREVIOUS_KEYS_ENV]?.trim();
  if (rawPrevious) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawPrevious) as unknown;
    } catch (error) {
      throw new SecretConfigurationError(
        "INVALID_ENCRYPTION_KEY",
        `${SWIZZLE_ENCRYPTION_PREVIOUS_KEYS_ENV} must be a JSON array of prior 32-byte raw or base64 keys.`,
        { cause: error },
      );
    }
    if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
      throw new SecretConfigurationError(
        "INVALID_ENCRYPTION_KEY",
        `${SWIZZLE_ENCRYPTION_PREVIOUS_KEYS_ENV} must be a JSON array of prior 32-byte raw or base64 keys.`,
      );
    }
    for (const rawKey of parsed) {
      keys.push(resolveSecretEncryptionKey({ [SWIZZLE_ENCRYPTION_KEY_ENV]: rawKey }));
    }
  }

  const unique = new Map<string, Buffer>();
  for (const key of keys) unique.set(deriveSecretEncryptionKeyVersion(key), key);
  return [...unique].map(([version, key]) => ({ key, version }));
}
