import { afterAll, beforeEach } from "vitest";
import { killLeftProcesses } from "./processes.js";
import { temporaryDirectories } from "./support.js";

let activeTests = 0;
let finishedSinceIdle: string[] = [];

beforeEach(({ task, onTestFinished }) => {
  activeTests++;
  onTestFinished(() => {
    activeTests--;
    finishedSinceIdle.push(task.name);
    if (activeTests > 0) return;
    const suspects = finishedSinceIdle;
    finishedSinceIdle = [];
    killLeftProcesses(temporaryDirectories, suspects);
  });
});

afterAll(() => killLeftProcesses(temporaryDirectories, []));
