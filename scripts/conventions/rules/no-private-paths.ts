import path from "node:path";
import { exportConfiguration, isPrivate } from "../../private-paths.js";
import type { Rule } from "../lint.js";

/** A path with at least one slash, which may start with `./` or `../`; a trailing dot ends a sentence. */
const PATH = /[\w.@-]*(?:\/[\w.@-]*[\w@-])+/gu;

/**
 * A public file that names a private file breaks in the public export, which leaves that file out:
 * a test that runs it fails there, and a link or comment points at nothing. A path counts when it
 * names a tracked private file from the repository root or from the naming file's directory.
 */
export const noPrivatePaths: Rule = {
  id: "no-private-paths",
  check(repo) {
    const hidden = new Set(repo.files.filter(isPrivate));
    return repo.files
      .filter((file) => !isPrivate(file))
      .flatMap((file) => {
        const text = repo.read(file);
        if (text.includes("\0")) return [];
        const exportedPaths = new Set(exportConfiguration(file, text).match(PATH));
        return text.split("\n").flatMap((line, index) =>
          [...new Set(line.match(PATH))]
            .filter(
              (found) =>
                exportedPaths.has(found) &&
                (hidden.has(found.replace(/^(?:\.\.?\/)+/u, "")) ||
                  hidden.has(path.posix.join(path.posix.dirname(file), found))),
            )
            .map((found) => ({
              file,
              line: index + 1,
              message: `${found} is private, so the public export leaves it out and this reference breaks there. Move a test of private material under .agents/checks/, or drop the reference.`,
            })),
        );
      });
  },
};
