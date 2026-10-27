import path from "node:path";
import type { Rule } from "../lint.js";

// Automation, workflow, job and container platforms a page could compare Swizzle to. Tools the
// stack runs on or connects to (Docker, Caddy, Postgres, Valkey, BullMQ, Tailscale, S3) are not
// comparisons and stay out. The names in the second group are ordinary words in lower case, so
// they match only when capitalized.
const ALWAYS =
  // conventions-allow no-other-products: the rule's own pattern
  /\b(?:n8n|supabase|zapier|windmill|kubernetes|k8s|airflow|dagster|inngest|pipedream|activepieces|kestra|ifttt|sidekiq|celery|trigger\.dev|make\.com)\b/iu;
const CAPITALIZED =
  // conventions-allow no-other-products: the rule's own pattern
  /\b(?:Temporal|Prefect|Hatchet|Nomad|Power Automate|Step Functions|AWS Lambda|Cloud Run)\b/u;

/** Lockfiles pin what dependencies are called; nobody writes them. */
const LOCKFILES = new Set(["pnpm-lock.yaml", "package-lock.json", "uv.lock", "Cargo.lock"]);

export const noOtherProducts: Rule = {
  id: "no-other-products",
  check(repo) {
    return repo.files
      .filter((file) => !LOCKFILES.has(path.posix.basename(file)))
      .flatMap((file) => {
        const text = repo.read(file);
        if (text.includes("\0")) return [];
        return text.split("\n").flatMap((line, index) => {
          const match = (line.match(ALWAYS) ?? line.match(CAPITALIZED))?.[0];
          if (match === undefined) return [];
          return [
            {
              file,
              line: index + 1,
              message: `"${match}" names another product. Describe Swizzle and the behaviour in its own terms instead of comparing it to a product or naming one as an example.`,
            },
          ];
        });
      });
  },
};
