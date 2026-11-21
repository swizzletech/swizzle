import { createHmac } from "node:crypto";

export function authenticatorCode(base32Secret: string, at: Date = new Date()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bits = [...base32Secret]
    .map((character) => alphabet.indexOf(character).toString(2).padStart(5, "0"))
    .join("");
  const key = Buffer.from(bits.match(/.{8}/gu)?.map((byte) => Number.parseInt(byte, 2)) ?? []);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at.getTime() / 30_000)));
  const digest = createHmac("sha1", key).update(counter).digest();
  const offset = (digest.at(-1) ?? 0) & 0x0f;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

export function wrongAuthenticatorCode(base32Secret: string, at: Date = new Date()): string {
  const accepted = new Set(
    [-1, 0, 1, 2].map((offset) =>
      authenticatorCode(base32Secret, new Date(at.getTime() + offset * 30_000)),
    ),
  );
  let candidate = 0;
  while (accepted.has(String(candidate).padStart(6, "0"))) candidate += 1;
  return String(candidate).padStart(6, "0");
}
