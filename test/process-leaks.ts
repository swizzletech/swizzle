import { afterAll, beforeEach } from "vitest";
import { killLeftProcesses } from "./processes.js";
import { temporaryDirectories } from "./support.js";

beforeEach(({ onTestFinished }) => {
  onTestFinished(() => killLeftProcesses(temporaryDirectories));
});

afterAll(() => killLeftProcesses(temporaryDirectories));
