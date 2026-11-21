import path from "node:path";
import type { Rule } from "../lint.js";

const SDK_SOURCES: Readonly<Record<string, string>> = {
  "swizzle-sdk.ts": "packages/sdk-ts/src/index.ts",
  "swizzle_sdk.py": "packages/sdk-py/swizzle_sdk.py",
};

export const sdkCopiesMatch: Rule = {
  id: "sdk-copies-match",
  check(repo) {
    return repo.files.flatMap((file) => {
      const source = SDK_SOURCES[path.posix.basename(file)];
      if (source === undefined || !repo.exists(source)) return [];
      const copy = repo.read(file).split("\n");
      const original = repo.read(source).split("\n");
      const differs = copy.findIndex((line, index) => line !== original[index]);
      if (differs === -1 && copy.length === original.length) return [];
      return [
        {
          file,
          line: differs === -1 ? copy.length : differs + 1,
          message: `This vendored SDK differs from ${source}. Run \`cp ${source} ${file}\`, then fix the automation if it used a helper that changed.`,
        },
      ];
    });
  },
};
