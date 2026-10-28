// The PDF recipe of the shipped skill, deployed on the smoke's packaged stack exactly as the skill
// writes its config.yaml: it must validate and apply, and its run must render a page with pdftoppm in
// the runner image. The entrypoint is the smoke's, since the recipe shows none.

import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ApplyResponse } from "@swizzle/runtime/http-contract";
import { get, type PackagedStack, until } from "./packaged-stack.mts";

const RECIPES = "apps/cli/assets/skills/swizzle-builder/references/recipes.md";
const RECIPE = "## 8. PDF to image (poppler)";

const ENTRYPOINT = `import base64, json, os, pathlib, subprocess, sys

payload = json.load(sys.stdin)
scratch = pathlib.Path(os.environ["SWIZZLE_RUN_TMP"])
source = scratch / "in.pdf"
source.write_bytes(base64.b64decode(payload["pdf_base64"]))
subprocess.run(["pdftoppm", "-png", "-r", "50", str(source), str(scratch / "page")], check=True)
pages = {page.name: page.stat().st_size for page in scratch.glob("page*.png")}
print(json.dumps({"pages": pages}))
`;

/** A one-page PDF that shows `text` in Helvetica. */
function pdf(text: string): Buffer {
  const content = `BT /F1 18 Tf 20 40 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const offset = body.length;
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

export async function smokePdfRecipe(
  stack: PackagedStack,
  log: (message: string) => void,
): Promise<void> {
  const recipe = (await readFile(RECIPES, "utf8")).split(RECIPE)[1];
  const config = /```yaml\n([\s\S]*?)```/u.exec(recipe ?? "")?.[1];
  assert.ok(config !== undefined, `${RECIPES} has no "${RECIPE}" with a config.yaml block`);
  const secret = /secret: (\S+)/u.exec(config)?.[1];
  const hook = /path: (\/\S+)/u.exec(config)?.[1];
  assert.ok(secret !== undefined && hook !== undefined, "the PDF recipe signs a webhook");

  const directory = await mkdtemp(path.join(os.tmpdir(), "swizzle-smoke-recipe-"));
  try {
    await writeFile(path.join(directory, "config.yaml"), config);
    await writeFile(path.join(directory, "main.py"), ENTRYPOINT);
    const value = randomBytes(16).toString("hex");
    process.env.SWIZZLE_SMOKE_SIGNING_SECRET = value;
    await stack.cli("secret", "set", secret, "--value-env", "SWIZZLE_SMOKE_SIGNING_SECRET");
    await stack.cli("validate", directory);
    const applied: ApplyResponse = JSON.parse(await stack.cli("apply", directory));
    assert.ok(applied.webhookUrl);
    log("validated and deployed the skill's PDF recipe as written");

    const body = JSON.stringify({ pdf_base64: pdf("Swizzle smoke").toString("base64") });
    const response = await fetch(applied.webhookUrl, {
      body,
      headers: {
        "content-type": "application/json",
        "x-swizzle-signature": `sha256=${createHmac("sha256", value).update(body).digest("hex")}`,
      },
      method: "POST",
    });
    const queued = await response.text();
    assert.ok(response.ok, `POST ${hook} answered ${response.status}: ${queued}`);
    const { runId } = JSON.parse(queued) as { runId: string };
    const run = await until(
      `the PDF recipe's run ${runId} finished`,
      async () => {
        const answer = await get(
          `${stack.dashboard}/api/runs/${runId}?environment=${stack.environment}`,
          stack.token,
        );
        const parsed =
          answer === undefined ? undefined : (JSON.parse(answer) as { status: string });
        return ["succeeded", "failed", "dead-lettered"].includes(parsed?.status ?? "")
          ? answer
          : undefined;
      },
      log,
    );
    assert.match(run, /"status":"succeeded"/u, `the PDF recipe's run failed:\n${run}`);
    const { result } = JSON.parse(run) as { result: { pages: Record<string, number> } };
    assert.ok((result.pages["page-1.png"] ?? 0) > 0, `pdftoppm rendered no page: ${run}`);
    log("the PDF recipe's run rendered its page with pdftoppm");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}
