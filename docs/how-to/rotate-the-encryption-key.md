# Rotate the encryption key

`SWIZZLE_ENCRYPTION_KEY` encrypts platform secrets, OAuth client secrets, OAuth token sets, pending PKCE verifiers, and each person's two-factor secret and recovery codes in PostgreSQL. It also derives approval link tokens and the secret that signs session cookies. The API, scheduler and worker must hold the same key. Rotation runs in two phases, so no credential becomes unreadable. First, every service accepts the old and new keys. Then one command rewrites every stored credential under the new key.

These steps rotate the key for `just dev`. The key lives in `~/.config/swizzle/dev.env`, which every worktree's dev stack reads, and `just db-reencrypt` rewrites credentials in the development database of the worktree you run it in. The repository has no recipe for re-encrypting credentials in the packaged stack, so do not rotate that stack with these steps.

## Rotate the key

1. Generate a new key:

   ```bash
   openssl rand -base64 32
   ```

2. In `~/.config/swizzle/dev.env`, move the current value of `SWIZZLE_ENCRYPTION_KEY` into the JSON array `SWIZZLE_ENCRYPTION_PREVIOUS_KEYS`, and set `SWIZZLE_ENCRYPTION_KEY` to the new key:

   ```env
   SWIZZLE_ENCRYPTION_KEY=<new key>
   SWIZZLE_ENCRYPTION_PREVIOUS_KEYS=["<old key>"]
   ```

3. Restart the API, scheduler and worker with `just dev`. New writes now use the new key, and old values stay readable.

4. Rewrite every stored credential under the new key, in each worktree whose dev data you keep:

   ```bash
   just db-reencrypt
   ```

   The recipe also reseals the state of attempts in flight, which holds their delivered secrets. It runs in one transaction, prints the number of rewritten rows per kind, and never prints plaintext ([`reencryptStoredCredentials`](../../packages/db/src/credential-reencryption.ts)).

5. Trigger a run that uses a secret, and run `swizzle connections test <name>` for each connection.

6. Set `SWIZZLE_ENCRYPTION_PREVIOUS_KEYS=[]` in `~/.config/swizzle/dev.env`, restart the services with `just dev`, and run `swizzle security audit`.

Keep the old key until step 4 has succeeded. Without it, the credentials it encrypted cannot be decrypted.

## Sign in again

Session cookies are signed with a secret derived from the current key, so every browser is signed out once the services run on the new key. Sign in again; two-factor sign-in keeps working, because step 4 rewrote its secrets and recovery codes. Agent tokens are not signed with the key and keep working.

## Send new approval links

Approval tokens derive from the key, so every link sent before the rotation stops working. Runs that wait for an approval stay waiting. Send a new link, or decide in the dashboard. See [approval links](../explanation/approvals.md).
