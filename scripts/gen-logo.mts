import { existsSync, readFileSync, writeFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const source = readFileSync(new URL("docs/assets/logo-dark.svg", root), "utf8");
const edge = /^ {2}<g class="logo-edge" [^\n]+\n[\s\S]*?^ {2}<\/g>\n/mu;
const wordmark = /^ {2}<g class="logo-wordmark" [^\n]+\n[\s\S]*?^ {2}<\/g>\n/mu;
const wordmarkDefinition = /^ {2}<defs>[^\n]+<\/defs>\n/mu;
const uses = /<use [^>]+\/>/gu;
const attribution = /^ {2}<!-- [^\n]+ -->\n/mu;
const viewBox = /viewBox="[^"]+"/u;
const adaptiveStyle =
  "  <style>.logo-edge { display: none } @media (prefers-color-scheme: dark) { .logo-edge { display: inline } }</style>";
const artwork = source.replace(attribution, "");
const web = artwork.replace("  <title>", `${adaptiveStyle}\n  <title>`);
const head = web
  .replace(viewBox, 'viewBox="34 -2 136 148"')
  .replace(wordmarkDefinition, "")
  .replace(wordmark, "")
  .replace(uses, "");
const approval = artwork.replace('xmlns="http://www.w3.org/2000/svg"', 'class="logo"').trimEnd();

const template = approval.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("${", "\\${");

const outputs = [
  ["docs/assets/logo.svg", source.replace(edge, "")],
  ["apps/web/src/components/logo-full.svg", web],
  ["apps/web/src/components/logo-head.svg", head],
  ["apps/api/src/approval-logo.ts", `export const APPROVAL_LOGO = \`${template}\`;\n`],
] as const;

const check = process.argv.includes("--check");
const stale: string[] = [];
for (const [file, content] of outputs) {
  const url = new URL(file, root);
  if (check) {
    if (!existsSync(url) || readFileSync(url, "utf8") !== content) stale.push(file);
  } else {
    writeFileSync(url, content);
  }
}
if (stale.length > 0) {
  console.error(`Run just gen to refresh: ${stale.join(", ")}`);
  process.exitCode = 1;
}
