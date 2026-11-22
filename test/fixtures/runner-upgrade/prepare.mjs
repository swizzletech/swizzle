import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const [root, output, tag] = process.argv.slice(2);
const { prepareImages } = await import(pathToFileURL(`${root}/scripts/stack-images.ts`));
const prepared = prepareImages(
  { root, envFile: `${root}/.env`, ...(tag === undefined ? {} : { version: "1.0.4" }) },
  output,
  tag === "local" ? { tag: "local" } : {},
);
writeFileSync(`${output}.images.json`, JSON.stringify(prepared.images));
