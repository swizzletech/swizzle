// A setup file of vitest.config.ts: every test ends with none of the processes it started still
// running. A fake `docker`, an automation or a server that a test leaves behind outlives the test
// worker and stays on the host after the run, so the check kills what it finds and fails the test
// that left it. A test that timed out keeps running in the background and may start more, so the
// check runs again when the file ends. test/processes.ts says which processes count as a test's.

import { afterAll, beforeEach } from "vitest";
import { killLeftProcesses } from "./processes.js";
import { temporaryDirectories } from "./support.js";

beforeEach(({ onTestFinished }) => {
  // Registered before the test registers its own hooks, so it runs after them: a test's cleanup
  // that stops its processes has run when the check looks.
  onTestFinished(() => killLeftProcesses(temporaryDirectories));
});

afterAll(() => killLeftProcesses(temporaryDirectories));
