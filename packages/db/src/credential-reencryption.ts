import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { eq, isNotNull } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { betterAuthSecretConfig } from "./auth.js";
import type * as schema from "./schema.js";
import {
  authTwoFactors,
  environmentConnections,
  environmentSecrets,
  executionLeases,
} from "./schema.js";
import { decryptSecretValue, encryptSecretValue, SECRET_ENCRYPTION_ALGORITHM } from "./secrets.js";

export interface CredentialReencryptionResult {
  readonly executionStates: number;
  readonly connectionClientSecrets: number;
  readonly connectionPendingVerifiers: number;
  readonly connectionTokens: number;
  readonly platformSecrets: number;
  readonly twoFactorSecrets: number;
}

/**
 * Re-encrypt every stored credential with the current primary encryption key.
 * Previous keys are decrypt-only and must be supplied through
 * SWIZZLE_ENCRYPTION_PREVIOUS_KEYS until this transaction succeeds.
 */
export async function reencryptStoredCredentials(
  db: NodePgDatabase<typeof schema>,
): Promise<CredentialReencryptionResult> {
  return await db.transaction(async (transaction) => {
    let platformSecrets = 0;
    for (const row of await transaction.select().from(environmentSecrets)) {
      const envelope = encryptSecretValue(
        decryptSecretValue({ algorithm: row.algorithm, ciphertext: row.ciphertext }),
      );
      await transaction
        .update(environmentSecrets)
        .set({
          algorithm: envelope.algorithm,
          ciphertext: envelope.ciphertext,
          keyVersion: envelope.keyVersion,
        })
        .where(eq(environmentSecrets.id, row.id));
      platformSecrets += 1;
    }

    let connectionClientSecrets = 0;
    let connectionPendingVerifiers = 0;
    let connectionTokens = 0;
    for (const row of await transaction.select().from(environmentConnections)) {
      const clientSecret = encryptSecretValue(
        decryptSecretValue({
          algorithm: row.clientSecretAlgorithm,
          ciphertext: row.clientSecretCiphertext,
        }),
      );
      const values: Partial<typeof environmentConnections.$inferInsert> = {
        clientSecretAlgorithm: clientSecret.algorithm,
        clientSecretCiphertext: clientSecret.ciphertext,
        clientSecretKeyVersion: clientSecret.keyVersion,
      };
      connectionClientSecrets += 1;

      if (row.tokenCiphertext !== null) {
        if (row.tokenAlgorithm === null) {
          throw new Error(`Connection ${row.id} has token ciphertext without an algorithm.`);
        }
        const token = encryptSecretValue(
          decryptSecretValue({
            algorithm: row.tokenAlgorithm,
            ciphertext: row.tokenCiphertext,
          }),
        );
        values.tokenAlgorithm = token.algorithm;
        values.tokenCiphertext = token.ciphertext;
        values.tokenKeyVersion = token.keyVersion;
        connectionTokens += 1;
      }

      if (row.pendingCodeVerifierCiphertext !== null) {
        const verifier = encryptSecretValue(
          decryptSecretValue({
            algorithm: row.clientSecretAlgorithm,
            ciphertext: row.pendingCodeVerifierCiphertext,
          }),
        );
        values.pendingCodeVerifierCiphertext = verifier.ciphertext;
        connectionPendingVerifiers += 1;
      }

      await transaction
        .update(environmentConnections)
        .set(values)
        .where(eq(environmentConnections.id, row.id));
    }

    // Better Auth encrypts each factor's TOTP secret and recovery codes under the secret it
    // derives from the current key (auth.ts). The lock keeps a concurrent enrollment or code use
    // from writing between this read and the write.
    const key = betterAuthSecretConfig(process.env);
    const reencrypt = async (data: string) =>
      await symmetricEncrypt({ data: await symmetricDecrypt({ data, key }), key });
    let twoFactorSecrets = 0;
    for (const row of await transaction.select().from(authTwoFactors).for("update")) {
      await transaction
        .update(authTwoFactors)
        .set({
          backupCodes: await reencrypt(row.backupCodes),
          secret: await reencrypt(row.secret),
        })
        .where(eq(authTwoFactors.id, row.id));
      twoFactorSecrets += 1;
    }

    // An attempt in flight keeps its delivered secrets sealed on its lease (dispatch-store.ts).
    let executionStates = 0;
    for (const row of await transaction
      .select({ taskId: executionLeases.taskId, executionState: executionLeases.executionState })
      .from(executionLeases)
      .where(isNotNull(executionLeases.executionState))
      .for("update")) {
      if (row.executionState === null) continue;
      const sealed = encryptSecretValue(
        decryptSecretValue({
          algorithm: SECRET_ENCRYPTION_ALGORITHM,
          ciphertext: row.executionState,
        }),
      );
      await transaction
        .update(executionLeases)
        .set({ executionState: sealed.ciphertext })
        .where(eq(executionLeases.taskId, row.taskId));
      executionStates += 1;
    }

    return {
      executionStates,
      connectionClientSecrets,
      connectionPendingVerifiers,
      connectionTokens,
      platformSecrets,
      twoFactorSecrets,
    };
  });
}
