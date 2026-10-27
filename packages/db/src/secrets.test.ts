import { describe, expect, it, vi } from "vitest";
import { TEST_ENCRYPTION_KEY } from "../../../test/support.js";

import {
  decryptSecretValue,
  encryptSecretValue,
  SWIZZLE_ENCRYPTION_KEY_ENV,
  SWIZZLE_ENCRYPTION_PREVIOUS_KEYS_ENV,
} from "./secrets.js";

const ROTATED_ENCRYPTION_KEY = "abcdefghijklmnopqrstuvwxyzABCDEF";

describe("secret encryption", () => {
  it("encrypts secret values without storing plaintext in ciphertext", () => {
    vi.stubEnv(SWIZZLE_ENCRYPTION_KEY_ENV, TEST_ENCRYPTION_KEY);

    const encrypted = encryptSecretValue("super-secret-value");

    expect(encrypted.ciphertext).not.toContain("super-secret-value");
    expect(decryptSecretValue(encrypted)).toBe("super-secret-value");
  });

  it("fails clearly when the encryption key is missing", () => {
    vi.stubEnv(SWIZZLE_ENCRYPTION_KEY_ENV, undefined);

    expect(() => encryptSecretValue("hello")).toThrow(
      `${SWIZZLE_ENCRYPTION_KEY_ENV} must be set to a 32-byte secret before using platform secrets.`,
    );
  });

  it("decrypts existing credentials through the previous-key ring after rotation", () => {
    vi.stubEnv(SWIZZLE_ENCRYPTION_KEY_ENV, TEST_ENCRYPTION_KEY);
    const beforeRotation = encryptSecretValue("survives-rotation");

    vi.stubEnv(SWIZZLE_ENCRYPTION_KEY_ENV, ROTATED_ENCRYPTION_KEY);
    vi.stubEnv(SWIZZLE_ENCRYPTION_PREVIOUS_KEYS_ENV, JSON.stringify([TEST_ENCRYPTION_KEY]));
    const afterRotation = encryptSecretValue("new-key-data");

    expect(afterRotation.keyVersion).not.toBe(beforeRotation.keyVersion);
    expect(decryptSecretValue(beforeRotation)).toBe("survives-rotation");
    expect(decryptSecretValue(afterRotation)).toBe("new-key-data");
  });

  it("rejects malformed previous-key configuration", () => {
    vi.stubEnv(SWIZZLE_ENCRYPTION_KEY_ENV, TEST_ENCRYPTION_KEY);
    vi.stubEnv(SWIZZLE_ENCRYPTION_PREVIOUS_KEYS_ENV, "not-json");

    expect(() => encryptSecretValue("hello")).toThrow(
      `${SWIZZLE_ENCRYPTION_PREVIOUS_KEYS_ENV} must be a JSON array`,
    );
  });
});
