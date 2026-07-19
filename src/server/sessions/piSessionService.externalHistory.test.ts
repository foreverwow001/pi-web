import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionEventHub } from "../realtime/sessionEventHub.js";
import { PiSessionService, SessionHistoryConflictError } from "./piSessionService.js";
import { fakeRuntime, fakeSessionManager, runtimeCreator, sessionRecord, testModelRuntime } from "./piSessionService.testSupport.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("PiSessionService external history protection", () => {
  it("blocks a thinking-level write when a busy cached runtime is behind the persisted leaf", async () => {
    const fixture = await createFixture();
    try {
      await expect(fixture.service.messages(fixture.sessionId)).resolves.toHaveLength(1);
      await appendEntry(fixture.sessionPath, "disk-new", "old-leaf");
      const before = await readFile(fixture.sessionPath, "utf8");

      await expect(fixture.service.messages(fixture.sessionId)).resolves.toHaveLength(1);
      await expect(fixture.service.setThinkingLevel(fixture.sessionId, "high")).rejects.toBeInstanceOf(SessionHistoryConflictError);
      expect(fixture.setThinkingCalls()).toBe(0);
      expect(await readFile(fixture.sessionPath, "utf8")).toBe(before);
    } finally {
      await fixture.service.dispose();
    }
  });

  it("allows a busy runtime to continue after its own persisted leaf advances", async () => {
    const fixture = await createFixture();
    try {
      await expect(fixture.service.messages(fixture.sessionId)).resolves.toHaveLength(1);
      fixture.setRuntimeLeaf("own-new");
      await appendEntry(fixture.sessionPath, "own-new", "old-leaf");

      await expect(fixture.service.setThinkingLevel(fixture.sessionId, "high")).resolves.toMatchObject({ thinkingLevel: "high" });
      expect(fixture.setThinkingCalls()).toBe(1);
    } finally {
      await fixture.service.dispose();
    }
  });
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-web-history-guard-"));
  roots.push(root);
  const sessionId = "history-guard-session";
  const sessionPath = join(root, `${sessionId}.jsonl`);
  await writeFile(sessionPath, `${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-07-18T00:00:00.000Z", cwd: root })}\n`, "utf8");
  await appendEntry(sessionPath, "old-leaf", null);

  let runtimeLeaf = "old-leaf";
  let setThinkingCalls = 0;
  const manager = fakeSessionManager(root, {
    getSessionId: () => sessionId,
    getSessionFile: () => sessionPath,
    getBranch: () => [{ type: "message", id: runtimeLeaf, message: { role: "user", content: "old" } }],
    getLeafId: () => runtimeLeaf,
  });
  const fixtureRuntime = fakeRuntime(sessionId, {
    sessionManager: manager,
    sessionFile: sessionPath,
    isStreaming: true,
    thinkingLevel: "off",
    getAvailableThinkingLevels: () => ["off", "high"],
    setThinkingLevel(level) {
      setThinkingCalls += 1;
      fixtureRuntime.session.thinkingLevel = level;
    },
  });
  const { runtime } = fixtureRuntime;
  const service = new PiSessionService(new SessionEventHub(), {
    agentDir: root,
    modelRuntime: testModelRuntime,
    createAgentRuntime: runtimeCreator(runtime),
    sessionManager: {
      create: () => manager,
      list: () => Promise.resolve([]),
      listAll: () => Promise.resolve([sessionRecord(sessionId, root)]).then((records) => records.map((record) => ({ ...record, path: sessionPath, messageCount: 1, firstMessage: "old", allMessagesText: "old" }))),
      open: () => manager,
    },
    heartbeatIntervalMs: 60_000,
  });

  return {
    service,
    sessionId,
    sessionPath,
    setRuntimeLeaf: (leaf: string) => { runtimeLeaf = leaf; },
    setThinkingCalls: () => setThinkingCalls,
  };
}

async function appendEntry(path: string, id: string, parentId: string | null): Promise<void> {
  await appendFile(path, `${JSON.stringify({ type: "message", id, parentId, timestamp: "2026-07-18T00:01:00.000Z", message: { role: "user", content: id } })}\n`, "utf8");
}
