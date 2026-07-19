import { describe, expect, it } from "vitest";
import type { WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";
import { panelKey, statusUrl } from "./pi-web-plugin.js";

function context(sessionId?: string): WorkspacePanelContext {
  const unavailable = (): Promise<never> => Promise.reject(new Error("not used"));
  return {
    machine: { id: "local", name: "Local", kind: "local" },
    workspace: { id: "workspace", projectId: "project", path: "/workspaces/Ivyhouse_op_system", label: "Ivyhouse", isMain: true, isGitRepo: true, isGitWorktree: false },
    state: sessionId === undefined ? {} : { selectedSession: { id: sessionId } },
    files: { readFile: unavailable, writeFile: unavailable, deleteFile: unavailable, moveFile: unavailable },
    host: { requestRender: () => undefined },
    prompt: { insertText: () => undefined, getText: () => "", getSelection: () => null },
    terminal: { open: () => undefined, runCommand: unavailable },
  };
}

describe("Info Plugin Todo session selection", () => {
  it("keys panel state and requests by selected session", () => {
    expect(panelKey(context("session-a"))).not.toBe(panelKey(context("session-b")));
    expect(statusUrl(context("session-a"))).toContain("sessionId=session-a");
    expect(statusUrl(context("session-b"))).toContain("sessionId=session-b");
  });

  it("does not invent a session when none is selected", () => {
    expect(panelKey(context())).toContain("no-session");
    expect(statusUrl(context())).not.toContain("sessionId=");
  });
});
