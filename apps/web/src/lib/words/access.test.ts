import { describe, expect, it } from "vitest";

import {
  accessProblemInWords,
  passwordProblemInWords,
  sessionDeviceInWords,
  signInProblemInWords,
} from "./access";

describe("passwordProblemInWords", () => {
  it("says how far a typed password is outside the accepted length, and nothing before typing or within it", () => {
    expect(passwordProblemInWords("twelve-chars")).toBe(
      "12 characters. The password needs at least 15.",
    );
    expect(passwordProblemInWords("x")).toBe("1 character. The password needs at least 15.");
    expect(passwordProblemInWords("")).toBeNull();
    expect(passwordProblemInWords("fifteen-chars-x")).toBeNull();
    expect(passwordProblemInWords("x".repeat(128))).toBeNull();
    expect(passwordProblemInWords("x".repeat(129))).toBe(
      "129 characters. The password can have at most 128.",
    );
  });
});

describe("signInProblemInWords", () => {
  it("leaves a code without words to the API's own message", () => {
    expect(signInProblemInWords("AUTH_CODE_INVALID")).toBe(
      "That code is incorrect, expired or already used. Try the current one.",
    );
    expect(signInProblemInWords("AUTH_REQUEST_INVALID")).toBeNull();
    expect(signInProblemInWords(undefined)).toBeNull();
  });
});

// A refused right must say what is missing and where the person's role comes from (A3 of the
// dashboard brief); the API sends the facts, these words are what the person reads.

describe("accessProblemInWords", () => {
  it("names the team a capped role comes from in a protected environment", () => {
    const words = accessProblemInWords({
      code: "ACCESS_DENIED",
      details: {
        protectedEnvironment: "production",
        required: "editor",
        role: null,
        scope: null,
        sources: [
          {
            on: "project",
            projectId: "p",
            role: "editor",
            via: { teamId: "t", teamName: "Office" },
          },
        ],
      },
      message: "This needs editor; you have no role here.",
      status: 403,
    });
    expect(words).toBe(
      "This needs editor. Your role editor on the project through the team Office gives you nothing in production. The production environment is protected, so only a production grant counts there. Ask an admin of this project to grant you production, or an owner or admin of the instance to add you to a team that holds it.",
    );
  });

  it("says a token's scope is the limit", () => {
    const words = accessProblemInWords({
      code: "ACCESS_DENIED",
      details: {
        protectedEnvironment: null,
        required: "editor",
        role: "viewer",
        scope: { environments: ["staging"], projectIds: null, role: "viewer" },
        sources: [],
      },
      message: "",
      status: 403,
    });
    expect(words).toBe(
      "This needs editor. Your role here is viewer. The token you use acts at most as viewer, only in staging. Ask an admin of this project.",
    );
  });

  it("calls an environment protected only when the API says so", () => {
    const grant = (on: "project" | "environment", role: string) => ({
      environment: on === "environment" ? "staging" : undefined,
      on,
      projectId: "p",
      role,
      via: null,
    });
    const words = accessProblemInWords({
      code: "ACCESS_DENIED",
      details: {
        protectedEnvironment: null,
        required: "admin",
        role: "editor",
        scope: null,
        sources: [grant("project", "viewer"), grant("environment", "editor")],
      },
      message: "",
      status: 403,
    });
    expect(words).toBe(
      "This needs admin. Your role here is editor, from viewer on the project, editor in staging. Ask an admin of this project.",
    );
  });

  it("tells an owner with a narrowed token what an instance page needs", () => {
    const words = accessProblemInWords({
      code: "ACCESS_DENIED",
      details: {
        required: "admin",
        role: "owner",
        scope: { environments: ["staging"], projectIds: null, role: "admin" },
      },
      message:
        "Only an instance owner or admin may do this, with a session or a token of full scope.",
      status: 403,
    });
    expect(words).toBe(
      "Only an instance owner or admin may do this, with a session or a token of full scope. The token you use acts at most as admin, only in staging.",
    );
  });

  it("sends a member to an owner or admin for an instance page", () => {
    const words = accessProblemInWords({
      code: "ACCESS_DENIED",
      details: { required: "admin", role: "member", scope: null },
      message: "Only an instance owner or admin may do this.",
      status: 403,
    });
    expect(words).toBe(
      "Only an instance owner or admin may do this. You are a member of this instance.",
    );
  });

  it("says a hidden automation may exist", () => {
    const words = accessProblemInWords({
      code: "AUTOMATION_NOT_FOUND",
      message: "Automation not found: export",
      status: 404,
    });
    expect(words).toBe(
      "Automation not found: export. Either it does not exist, or no grant gives you access to it. An admin of its project can share it with you.",
    );
  });
});

describe("a session's browser in words", () => {
  it("names the browser and the device, not the engines a user agent also lists", () => {
    const agents = {
      "Chrome on Android":
        "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
      "Edge on Windows":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
      "Firefox on Linux": "Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0",
      "Safari on Mac":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15",
      "Browser on Linux": "Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Waterfox/6.6",
      "Chrome on Linux":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/152.0.0.0 Safari/537.36",
      curl: "curl/8.23.0",
    };
    for (const [words, agent] of Object.entries(agents))
      expect(sessionDeviceInWords(agent)).toBe(words);
    expect(sessionDeviceInWords(null)).toBe("Unknown browser");
  });
});
