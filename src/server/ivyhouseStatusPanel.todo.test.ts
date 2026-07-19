import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ivyhouseTodoSnapshotPath, readTodoSnapshot } from "./ivyhouseStatusPanel.js";

let stateDir: string;
const cwd = "/workspaces/Ivyhouse_op_system";

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "pi-web-todo-session-test-"));
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

async function writeSnapshot(sessionId: string, subject: string, storedSessionId: string = sessionId): Promise<void> {
  await writeFile(ivyhouseTodoSnapshotPath(cwd, sessionId, stateDir), JSON.stringify({
    version: 2,
    sessionId: storedSessionId,
    cwd,
    updatedAt: Date.now(),
    tasks: [{ id: 1, subject, status: "pending" }],
    nextId: 2,
  }), "utf8");
}

describe("Pi Web Todo session isolation", () => {
  it("reads only the selected session snapshot", async () => {
    await writeSnapshot("session-a", "A only");
    await writeSnapshot("session-b", "B only");

    await expect(readTodoSnapshot(cwd, "session-a", stateDir)).resolves.toEqual([{ id: 1, text: "A only", status: "pending" }]);
    await expect(readTodoSnapshot(cwd, "session-b", stateDir)).resolves.toEqual([{ id: 1, text: "B only", status: "pending" }]);
  });

  it("fails closed when no session or mismatched metadata is supplied", async () => {
    await writeSnapshot("session-a", "foreign", "session-b");

    await expect(readTodoSnapshot(cwd, undefined, stateDir)).resolves.toEqual([]);
    await expect(readTodoSnapshot(cwd, "session-a", stateDir)).resolves.toEqual([]);
    await expect(readTodoSnapshot(cwd, "missing", stateDir)).resolves.toEqual([]);
  });
});
