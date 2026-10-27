import type { Rule } from "../lint.js";

const COVERAGE_GATE =
  /\bthresholds\s*:|coverageThreshold|--coverage\.thresholds|check-?coverage|checkCoverage|fail[_-]under|min(?:imum)?[-_ ]?tests?[-_ ]?count/iu;
const TEST_CONFIG =
  /(^|\/)((vitest|vite|playwright|jest)[^/]*\.(c|m)?[jt]s|package\.json|justfile|lefthook\.yml|pyproject\.toml|setup\.cfg|\.coveragerc|\.c8rc[^/]*|\.nycrc[^/]*)$|^\.github\/(workflows|actions)\//u;

export const noCoverageGate: Rule = {
  id: "no-coverage-gate",
  check(repo) {
    return repo.files
      .filter((file) => TEST_CONFIG.test(file))
      .flatMap((file) =>
        repo
          .read(file)
          .split("\n")
          .flatMap((text, index) =>
            COVERAGE_GATE.test(text)
              ? [
                  {
                    file,
                    line: index + 1,
                    message:
                      "A coverage threshold or minimum test count rewards tests that prove nothing. A test exists only when it proves a behaviour whose breakage would cause a problem.",
                  },
                ]
              : [],
          ),
      );
  },
};
