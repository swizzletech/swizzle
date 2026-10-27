import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export async function resolveCliAssetDirectory(relativePath: string): Promise<string> {
  const assetPath = fileURLToPath(new URL(`../assets/${relativePath}`, import.meta.url));
  const stats = await stat(assetPath);
  if (!stats.isDirectory()) throw new Error(`CLI asset directory not found: ${assetPath}`);
  return assetPath;
}
