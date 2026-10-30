import { pathToFileURL } from "node:url";

const [root, output, tag = "local"] = process.argv.slice(2);
const { prepareImages } = await import(pathToFileURL(`${root}/scripts/stack-images.ts`));
prepareImages(
  { root, envFile: `${root}/.env`, version: "1.0.4" },
  output,
  tag === "local" ? { tag: "local" } : {},
);
