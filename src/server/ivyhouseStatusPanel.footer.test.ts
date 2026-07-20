import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { footerControlsStatePath, readFooterControls, writeFooterControls } from "./ivyhouseStatusPanel.js";

let stateDir: string;
const cwd = process.cwd();

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "pi-web-footer-session-test-"));
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

describe("Pi Web footer mode session isolation", () => {
  it("keeps mode per session while sharing the project fast override", async () => {
    await writeFooterControls(cwd, { fastOverride: "on" }, undefined, stateDir);
    await writeFooterControls(cwd, { agent: "plan", effectiveAgent: "plan" }, "session-a", stateDir);
    await writeFooterControls(cwd, { agent: "build", effectiveAgent: "build" }, "session-b", stateDir);

    await expect(readFooterControls(cwd, "session-a", stateDir)).resolves.toMatchObject({
      sessionId: "session-a",
      mode: "plan",
      effectiveMode: "plan",
      requestedEffectiveMismatch: false,
      fastOverride: "on",
      fastEnabled: true,
    });
    await expect(readFooterControls(cwd, "session-b", stateDir)).resolves.toMatchObject({
      sessionId: "session-b",
      mode: "build",
      effectiveMode: "build",
      requestedEffectiveMismatch: false,
      fastOverride: "on",
      fastEnabled: true,
    });
    await expect(readFooterControls(cwd, "session-c", stateDir)).resolves.toMatchObject({
      sessionId: "session-c",
      mode: "default",
      effectiveMode: "default",
      requestedEffectiveMismatch: false,
    });
  });

  it("ignores a legacy project-wide agent mode for session-scoped reads", async () => {
    await writeFile(footerControlsStatePath(cwd, undefined, stateDir), JSON.stringify({ agent: "plan", fastOverride: "off" }), "utf8");

    await expect(readFooterControls(cwd, "session-a", stateDir)).resolves.toMatchObject({ mode: "default", effectiveMode: "default", requestedEffectiveMismatch: false, fastOverride: "off" });
  });

  it("surfaces requested/effective drift until the next run records effective mode", async () => {
    await writeFooterControls(cwd, { agent: "plan", effectiveAgent: "default" }, "session-a", stateDir);

    await expect(readFooterControls(cwd, "session-a", stateDir)).resolves.toMatchObject({
      mode: "plan",
      effectiveMode: "default",
      requestedEffectiveMismatch: true,
    });
  });

  it("fails closed when a mode write has no session id", async () => {
    await expect(writeFooterControls(cwd, { agent: "plan" }, undefined, stateDir)).rejects.toThrow("sessionId is required");
  });
});
