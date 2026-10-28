import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseAutomationConfig } from "@swizzle/config";
import { list as listTar } from "tar";
import { onTestFinished, vi } from "vitest";
import { temporaryDirectory, waitFor } from "../../../test/support.js";
import type { RunContainerAutomationOptions } from "../src/container-runner.js";
import { DockerScope } from "../src/docker-cli.js";
import { entrypointScript } from "../src/executed-script.js";
import { sandboxRemovals } from "../src/sandbox.js";
import type { AutomationDefinition } from "../src/validation.js";

export const NODE_CONFIG = `
name: secure-run
version: 1.0.0
entrypoint: main.js
trigger:
  type: webhook
runtime:
  execution_mode: container
`;

export const PYTHON_CONFIG = `
name: hello
version: 1.0.0
entrypoint: main.py
trigger:
  type: webhook
runtime:
  language: python
  execution_mode: container
`;

interface FakeDockerOptions {
  readonly missingImage: boolean;
  /** Another process holds the assembly container's name and tags the image while it is asked. */
  readonly assembledElsewhere?: boolean;
  readonly stallControl?: string;
  readonly installGate?: boolean;
  readonly layerMiB?: number;
  readonly sizeUnknown?: boolean;
  readonly failCommit?: "always" | "once";
  readonly commitError?: string;
  /** Emitted after releaseStderr(), so stdout has been consumed before an overflow. */
  readonly execStderr?: string;
  readonly execAfterOutputStalls?: boolean;
  readonly installOutput?: string;
  readonly failInstall?: boolean | "stall";
  readonly failTag?: boolean;
  readonly failAttach?: boolean;
  readonly cliGoneAtAttach?: boolean;
  readonly execHangs?: boolean;
  /** What the automation prints on stdout; `{"ok":true}` by default. */
  readonly execStdout?: string;
}

/**
 * Puts a `docker` on PATH that logs each call and answers as the daemon would: the image inspect
 * fails when `missingImage`, commit fails `always` or `once` with `failCommit`, tag fails after a
 * commit when `failTag`, the install step fails or stalls with `failInstall`, `docker start
 * --attach` fails before the install container ran with `failAttach`, the CLI can no longer be
 * started from the install step on with `cliGoneAtAttach`, and exec prints a JSON
 * result. With `layerMiB`, the install step runs until `docker kill` and the container's writable
 * layer holds that many MiB. With `sizeUnknown`, the layer's size cannot be read; a stalled install
 * stalls the size reading too. With `execHangs`, exec ignores every signal but SIGKILL and never
 * ends, like a CLI whose daemon stopped answering. `execPid` reads the last exec's process id. `inputs`
 * lists the files of the last exec's input archive.
 */
export async function fakeDocker(input: FakeDockerOptions) {
  const bin = await temporaryDirectory("swizzle-fake-docker-");
  const log = path.join(bin, "calls.log");
  await writeFile(
    path.join(bin, "docker"),
    `#!/bin/sh
echo "$*" >> '${log}'
${input.stallControl ? `case "$*" in "${input.stallControl}"*) exec sleep 30 ;; esac` : ""}
${input.cliGoneAtAttach ? `case "$*" in "cp "*:/opt/swizzle) /bin/rm '${bin}/docker' ;; esac` : ""}
${input.assembledElsewhere ? `case "$*" in "create --name swizzle-image-"*) echo 'Error response from daemon: Conflict. The container name "/swizzle-image-x" is already in use by container "holder".' >&2; exit 1 ;; esac` : ""}
case "$1 $2" in
  "version --format") echo 29.9.1 ;;
  "image inspect") [ "$3" != --format ] || { echo 0; exit 0; }; ${imageInspectCommand(input, bin)} ;;
  commit*) ${input.commitError ? `echo '${input.commitError}' >&2;` : ""} ${commitCommand(input, bin)} ;;
  tag*) exit ${input.failTag ? 1 : 0} ;;
  "start --attach") ${input.installOutput ? `echo '${input.installOutput}';` : ""} ${installCommand(input, bin)} ;;
  "container inspect") case "$*" in
    *{{.Image}}*) echo sha256:base ;;
    *{{.Id}}*) touch '${bin}/tagged'; echo holder ;;
    *State*) echo "${containerState(input)}" ;;
    *) ${layerSizeCommand(input)} ;;
  esac ;;
  kill*) touch '${bin}/killed' ;;
  exec*) ${execCommand(input, bin)} ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  // Without the fake, no `docker` may be left on PATH for the CLI to fall back to.
  vi.stubEnv("PATH", input.cliGoneAtAttach ? bin : `${bin}:${process.env.PATH}`);
  const calls = async () =>
    (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean);
  // Sandbox and assembly removals can outlive the result. Keep the fake until cleanup ends,
  // including retries, so a late call cannot recreate its log during directory removal.
  onTestFinished(async ({ signal }) => {
    await waitFor(signal, async () => {
      const logged = await calls();
      return logged.every((call) => {
        const created = /^create --name (swizzle-run-\S+)/u.exec(call)?.[1];
        return created === undefined || logged.includes(`rm --force ${created}`);
      });
    });
    await sandboxRemovals();
    await DockerScope.removals();
  });
  return {
    calls,
    /** Waits until a call that starts with `prefix` reached the fake. */
    reached: (signal: AbortSignal, prefix: string) =>
      waitFor(signal, async () => (await calls()).some((call) => call.startsWith(prefix))),
    releaseInstall: () => writeFile(path.join(bin, "release"), ""),
    releaseStderr: () => writeFile(path.join(bin, "stderr-release"), ""),
    execPid: async () => Number(await readFile(path.join(bin, "exec.pid"), "utf8")),
    /** The files the last exec received in its input archive. */
    inputs: async () => {
      const names: string[] = [];
      await listTar({
        file: path.join(bin, "inputs.tar"),
        onReadEntry: (entry) => names.push(entry.path),
      });
      return names.filter((name) => name !== "./").sort();
    },
  };
}

function imageInspectCommand(input: FakeDockerOptions, bin: string): string {
  if (input.assembledElsewhere) return `[ -e '${bin}/tagged' ]; exit $?`;
  return `exit ${Number(input.missingImage)}`;
}

function commitCommand(input: FakeDockerOptions, bin: string): string {
  if (input.failTag) return "echo sha256:committed";
  switch (input.failCommit) {
    case "always":
      return "exit 1";
    case "once":
      return `[ -e '${bin}/committed' ] || { touch '${bin}/committed'; exit 1; }`;
    default:
      return "exit 0";
  }
}

function installCommand(input: FakeDockerOptions, bin: string): string {
  if (input.installGate) return `while [ ! -e '${bin}/release' ]; do sleep 0.05; done; exit 0`;
  if (input.layerMiB !== undefined)
    return `while [ ! -e '${bin}/killed' ]; do sleep 0.05; done; exit 137`;
  if (input.failInstall === "stall") return "exec sleep 30";
  if (input.failAttach) return "echo 'Error response from daemon: connection reset' >&2; exit 1";
  return `exit ${Number(input.failInstall === true)}`;
}

function containerState(input: FakeDockerOptions): string {
  if (input.failAttach) return "created 0";
  return `exited ${Number(Boolean(input.failInstall))}`;
}

function layerSizeCommand(input: FakeDockerOptions): string {
  if (input.failInstall === "stall") return "exec sleep 30";
  if (input.sizeUnknown) return "exit 1";
  return `echo ${(input.layerMiB ?? 0) * 1_048_576}`;
}

function execCommand(input: FakeDockerOptions, bin: string): string {
  if (input.execHangs)
    return `trap '' HUP INT TERM; echo $$ > '${bin}/exec.pid'; cat >/dev/null; while :; do sleep 1; done`;
  const commands = [
    `echo $$ > '${bin}/exec.pid'`,
    `cat > '${bin}/inputs.tar'`,
    `echo '${input.execStdout ?? '{"ok":true}'}'`,
  ];
  if (input.execStderr)
    commands.push(
      `while [ ! -e '${bin}/stderr-release' ]; do sleep 0.01; done`,
      `echo '${input.execStderr}' >&2`,
    );
  if (input.execAfterOutputStalls) commands.push("exec sleep 30");
  return commands.join("; ");
}

export function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function makeDefinition(source: string, directory = "/automation"): AutomationDefinition {
  const config = parseAutomationConfig(source);
  return {
    config,
    configPath: path.join(directory, "config.yaml"),
    directory,
    entrypointExtension: config.entrypoint.endsWith(".ts") ? ".ts" : ".js",
    entrypointPath: path.join(directory, config.entrypoint),
    entrypointRelativePath: config.entrypoint,
  };
}

export async function makeRunOptions(platformRun: boolean): Promise<RunContainerAutomationOptions> {
  const directory = await temporaryDirectory("swizzle-container-source-");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "main.js"), "console.log('{}')\n");
  const definition = makeDefinition(NODE_CONFIG, directory);
  return {
    automationDirectory: directory,
    definition,
    environment: { AGENT_API_KEY: "injected-at-runtime" },
    platformRun,
    runId: "26f446df-2453-5101-b2a9-941d33c9f555",
    script: await entrypointScript(definition, {}),
    timeoutMs: 60_000,
  };
}
