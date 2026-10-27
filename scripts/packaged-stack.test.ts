import { spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, onTestFinished, test, vi } from "vitest";
import { temporaryDirectory } from "../test/support.js";
import { startPackagedStack, throwawayPrefix } from "./packaged-stack.mts";

async function dockerFixture(projects: readonly string[], pruneBusy = false) {
  const root = await temporaryDirectory("swizzle-packaged-owner-");
  const bin = path.join(root, "bin");
  const state = path.join(root, "networks.json");
  const images = path.join(root, "images.json");
  await mkdir(bin);
  await writeFile(state, JSON.stringify(projects));
  await writeFile(images, JSON.stringify(["unrelated-image"]));
  await cp(".env.example", path.join(root, ".env.example"));
  await writeFile(
    path.join(bin, "docker"),
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const state = ${JSON.stringify(state)};
const imageFile = ${JSON.stringify(images)};
let images = JSON.parse(fs.readFileSync(imageFile, "utf8"));
let networks = JSON.parse(fs.readFileSync(state, "utf8"));
if (args[0] === "compose" && args.includes("up")) {
  const project = args[args.indexOf("--project-name") + 1];
  networks.push(project);
  images.push(project + "-image");
  fs.writeFileSync(imageFile, JSON.stringify(images));
  fs.writeFileSync(state, JSON.stringify(networks));
  console.error("forced Compose up failure after creating an empty project network");
  process.exit(1);
}
if (args[0] === "compose" && args.includes("down")) {
  console.error("no configuration file provided");
  process.exit(1);
}
if (args[0] === "network" && args[1] === "ls") {
  if (args.includes("--format")) console.log(networks.join("\\n"));
  else {
    const project = args[args.indexOf("--filter") + 1]?.split("=").slice(2).join("=");
    console.log(networks.filter((name) => name === project).join("\\n"));
  }
}
if (args[0] === "network" && args[1] === "rm") {
  networks = networks.filter((name) => !args.slice(2).includes(name));
  fs.writeFileSync(state, JSON.stringify(networks));
}
if (args[0] === "image") {
  const project = args[args.indexOf("--filter") + 1]?.split("=").slice(2).join("=");
  const owned = images.filter((id) => !project || id === project + "-image");
  if (args[1] === "ls") console.log(owned.join("\\n"));
  if (args[1] === "inspect") console.log(args.slice(4).map((id) => id.replace(/-image$/, "")).join("\\n"));
  if (args[1] === "prune" && ${pruneBusy}) {
    console.error("a prune operation is already running");
    process.exit(1);
  }
  if (args[1] === "prune" || args[1] === "rm") {
    images = images.filter((id) => args[1] === "prune" ? !owned.includes(id) : !args.slice(2).includes(id));
    fs.writeFileSync(imageFile, JSON.stringify(images));
  }
}

`,
    { mode: 0o755 },
  );
  vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
  vi.spyOn(os, "tmpdir").mockReturnValue(root);
  return { root, state, images };
}

test("a failed packaged up leaves no project networks", async () => {
  const f = await dockerFixture([]);
  await expect(startPackagedStack("smoke", () => {}, f.root)).rejects.toThrow("exited with 1");
  expect(JSON.parse(await readFile(f.state, "utf8"))).toEqual([]);
});

test("packaged sweeping rejects a reused PID and preserves a genuinely live owner", async () => {
  const other = await temporaryDirectory("swizzle-other-owner-");
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: other,
    stdio: "ignore",
  });
  await once(child, "spawn");
  onTestFinished(async () => {
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
  });
  const live = `${throwawayPrefix("smoke")}12345678`;
  const stale = live.replace(`-${process.pid}-`, `-${child.pid}-`);
  const f = await dockerFixture([live, stale]);
  await expect(startPackagedStack("smoke", () => {}, f.root)).rejects.toThrow("exited with 1");
  expect(JSON.parse(await readFile(f.state, "utf8"))).toEqual([live]);
  expect(child.exitCode).toBe(null);
});

test("packaged cleanup removes owned images while another Docker prune runs", async () => {
  const f = await dockerFixture([], true);
  await expect(startPackagedStack("smoke", () => {}, f.root)).rejects.toThrow("exited with 1");
  expect(JSON.parse(await readFile(f.images, "utf8"))).toEqual(["unrelated-image"]);
});
