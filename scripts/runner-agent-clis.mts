import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const dockerfilePath = "infra/docker/Dockerfile";
const packages = ["@anthropic-ai/claude-code", "@openai/codex"];
const exactVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;

function newerRegistryVersion(packageSpec: string, current: string): string {
  const output = execFileSync("npm", ["view", packageSpec, "version", "--json"], {
    encoding: "utf8",
  });
  const result: unknown = JSON.parse(output);
  const versions: unknown[] = Array.isArray(result) ? result : [result];
  return versions.reduce<string>((newest, version) => {
    if (typeof version !== "string" || !exactVersion.test(version))
      throw new Error(`npm returned a non-release version for ${packageSpec}`);
    return version.localeCompare(newest, "en", { numeric: true }) > 0 ? version : newest;
  }, current);
}

function run(mode: string | undefined): void {
  if (mode !== "update" && mode !== "outdated") throw new Error("Expected update or outdated.");

  const dockerfile = readFileSync(dockerfilePath, "utf8");
  const stage = /^FROM [^\r\n]+ AS runner-base\r?\n[\s\S]*?(?=^FROM |(?![\s\S]))/mu.exec(
    dockerfile,
  );
  const install = /^RUN npm install --global\b(?:[^\r\n]*\\\r?\n)*[^\r\n]*/mu.exec(
    stage?.[0] ?? "",
  );
  if (stage === null || install === null)
    throw new Error(`Expected a global npm install in runner-base in ${dockerfilePath}`);

  const words = install[0].split(/(\s+)/u);
  const updates = packages
    .map((packageName) => {
      const [pin, duplicate] = words.filter((word) => word.startsWith(`${packageName}@`));
      const current = pin?.slice(packageName.length + 1) ?? "";
      if (pin === undefined || duplicate !== undefined || !exactVersion.test(current))
        throw new Error(
          `Expected one exact ${packageName} pin in runner-base in ${dockerfilePath}`,
        );
      const major = current.split(".", 1)[0];
      const selector = mode === "update" ? `${major}.x` : "latest";
      const available = newerRegistryVersion(`${packageName}@${selector}`, current);
      return { packageName, pin, current, available };
    })
    .filter(({ current, available }) => current !== available);

  if (updates.length === 0) return;
  if (mode === "update") {
    const replacements = new Map(
      updates.map(({ packageName, pin, available }) => [pin, `${packageName}@${available}`]),
    );
    const instruction = words.map((word) => replacements.get(word) ?? word).join("");
    const offset = stage.index + install.index;
    const updated =
      dockerfile.slice(0, offset) + instruction + dockerfile.slice(offset + install[0].length);
    writeFileSync(dockerfilePath, updated);
  } else {
    process.exitCode = 1;
  }
  for (const { packageName, current, available } of updates)
    console.log(`Runner ${packageName} ${current} -> ${available}`);
}

try {
  run(process.argv[2]);
} catch (error) {
  console.error(`Runner agent CLIs: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
