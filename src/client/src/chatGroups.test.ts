import { describe, expect, it } from "vitest";
import { formalStageUsage, groupChatMessages, mainTurnUsage, summarizeChatGroup } from "./chatGroups";
import type { ChatLine } from "./components/shared";

const text = (role: ChatLine["role"], value: string): ChatLine => ({ role, parts: [{ type: "text", text: value }] });

describe("groupChatMessages", () => {
  it("groups technical parts until a readable message is encountered", () => {
    const messages: ChatLine[] = [
      { role: "assistant", parts: [{ type: "thinking", text: "plan" }, { type: "toolCall", toolName: "read", summary: "file" }] },
      text("assistant", "visible answer"),
      { role: "tool", parts: [{ type: "toolResult", toolName: "read", text: "ok", isError: false }] },
    ];

    expect(groupChatMessages(messages, 10)).toEqual([
      { kind: "group", startIndex: 10, endIndex: 10, messages: [messages[0]] },
      { kind: "message", index: 11, message: text("assistant", "visible answer") },
      { kind: "group", startIndex: 12, endIndex: 12, messages: [messages[2]] },
    ]);
  });

  it("splits mixed readable and technical parts from a single message", () => {
    const messages: ChatLine[] = [
      { role: "assistant", parts: [{ type: "thinking", text: "hidden" }, { type: "text", text: "shown" }] },
    ];

    expect(groupChatMessages(messages)).toEqual([
      { kind: "group", startIndex: 0, endIndex: 0, messages: [{ role: "assistant", parts: [{ type: "thinking", text: "hidden" }] }] },
      { kind: "message", index: 0, message: { role: "assistant", parts: [{ type: "text", text: "shown" }] } },
    ]);
  });

  it("keeps skill reads out of event groups", () => {
    const messages: ChatLine[] = [
      { role: "assistant", parts: [{ type: "thinking", text: "plan" }, { type: "skillRead", name: "playwright", path: "/skills/playwright/SKILL.md" }] },
    ];

    expect(groupChatMessages(messages)).toEqual([
      { kind: "group", startIndex: 0, endIndex: 0, messages: [{ role: "assistant", parts: [{ type: "thinking", text: "plan" }] }] },
      { kind: "message", index: 0, message: { role: "skill", parts: [{ type: "skillRead", name: "playwright", path: "/skills/playwright/SKILL.md" }] } },
    ]);
  });

  it("keeps image content visible outside collapsed event groups", () => {
    const image = { type: "image" as const, mimeType: "image/png", data: "QUJD" };
    const messages: ChatLine[] = [
      { role: "tool", parts: [{ type: "toolResult", toolName: "read", text: "Read image file [image/png]", isError: false }, image] },
    ];

    expect(groupChatMessages(messages)).toEqual([
      {
        kind: "group",
        startIndex: 0,
        endIndex: 0,
        messages: [{ role: "tool", parts: [{ type: "toolResult", toolName: "read", text: "Read image file [image/png]", isError: false }] }],
      },
      { kind: "tool-image", index: 0, message: { role: "tool", parts: [image] }, toolName: "read" },
    ]);
  });

  it("preserves image metadata when splitting technical and readable parts", () => {
    const meta = { timestamp: "2026-07-13T22:00:00.000Z" };
    const image = { type: "image" as const, mimeType: "image/webp", data: "QUJD" };
    const message: ChatLine = { role: "tool", parts: [{ type: "toolResult", toolName: "read", text: "ok", isError: false }, image], meta };

    expect(groupChatMessages([message])).toEqual([
      { kind: "group", startIndex: 0, endIndex: 0, messages: [{ role: "tool", parts: [message.parts[0]], meta }] },
      { kind: "tool-image", index: 0, message: { role: "tool", parts: [image], meta }, toolName: "read" },
    ]);
  });

  it("keeps user images as ordinary messages", () => {
    const image = { type: "image" as const, mimeType: "image/png", data: "QUJD" };
    const message: ChatLine = { role: "user", parts: [image] };

    expect(groupChatMessages([message])).toEqual([
      { kind: "message", index: 0, message },
    ]);
  });

  it("preserves message metadata when grouping", () => {
    const message: ChatLine = { role: "assistant", parts: [{ type: "thinking", text: "hidden" }, { type: "text", text: "shown" }], meta: { timestamp: "2026-05-09T12:00:00.000Z", model: { provider: "test", id: "model" } } };

    expect(groupChatMessages([message])).toEqual([
      { kind: "group", startIndex: 0, endIndex: 0, messages: [{ role: "assistant", parts: [{ type: "thinking", text: "hidden" }], meta: message.meta }] },
      { kind: "message", index: 0, message: { role: "assistant", parts: [{ type: "text", text: "shown" }], meta: message.meta } },
    ]);
  });

  it("treats compaction and branch summaries as grouped events", () => {
    const messages: ChatLine[] = [
      { ...text("assistant", "summary"), source: "compaction" },
      { ...text("assistant", "branch"), source: "branch_summary" },
    ];

    const groups = groupChatMessages(messages);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ kind: "group", startIndex: 0, endIndex: 1 });
  });

  it("keeps a stable group end index when older events are prepended into a group", () => {
    expect(groupChatMessages([
      { role: "tool", parts: [{ type: "toolResult", toolName: "read", text: "older", isError: false }] },
      { role: "assistant", parts: [{ type: "toolCall", toolName: "read", summary: "newer" }] },
      text("assistant", "answer"),
    ], 8)[0]).toMatchObject({ kind: "group", startIndex: 8, endIndex: 9 });
  });
});

describe("mainTurnUsage", () => {
  it("shows the exact Coordinator turn traffic for the reported two-read event group", () => {
    const usage = { tokens: { input: 22_066, output: 187, cacheRead: 237_056, cacheWrite: 0, reasoning: 10, total: 259_309 }, partial: false };
    const duplicatedTurnMeta = { turnId: "turn-259k", turnUsage: usage };
    expect(mainTurnUsage([
      { role: "tool", parts: [{ type: "toolExecution", toolName: "read", summary: "one", status: "success" }], meta: duplicatedTurnMeta },
      { role: "tool", parts: [{ type: "toolExecution", toolName: "read", summary: "two", status: "success" }], meta: duplicatedTurnMeta },
      { role: "assistant", parts: [{ type: "thinking", text: "inspect" }], meta: { turnId: "next-turn", turnUsage: { tokens: { total: 999 }, partial: false }, turnHasTools: true } },
    ])).toEqual({ tokens: usage.tokens, turns: 1, partial: false });
  });

  it("aggregates distinct main turns without counting reasoning twice in total", () => {
    expect(mainTurnUsage([
      { role: "tool", parts: [{ type: "toolExecution", toolName: "read", summary: "a", status: "success" }], meta: { turnId: "a", turnUsage: { tokens: { input: 10, output: 2, cacheRead: 20, reasoning: 1, total: 32 }, partial: false } } },
      { role: "assistant", parts: [{ type: "toolCall", toolName: "read", summary: "b" }], meta: { turnId: "b", turnUsage: { tokens: { input: 5, output: 1, cacheRead: 10, reasoning: 2, total: 16 }, partial: false } } },
    ])).toEqual({ tokens: { input: 15, output: 3, cacheRead: 30, reasoning: 3, total: 48 }, turns: 2, partial: false });
  });

  it("keeps a text-only main turn when it shares an event group with earlier tool results", () => {
    expect(mainTurnUsage([
      { role: "tool", parts: [{ type: "toolExecution", toolName: "read", summary: "a", status: "success" }], meta: { turnId: "tool-turn", turnUsage: { tokens: { total: 32 }, partial: false }, turnHasTools: true } },
      { role: "assistant", parts: [{ type: "thinking", text: "finalize" }], meta: { turnId: "text-turn", turnUsage: { tokens: { total: 16 }, partial: false }, turnHasTools: false } },
    ])).toEqual({ tokens: { total: 48 }, turns: 2, partial: false });
  });

  it("returns undefined for ordinary events without assistant usage", () => {
    expect(mainTurnUsage([{ role: "tool", parts: [{ type: "toolResult", toolName: "read", text: "ok", isError: false }] }])).toBeUndefined();
  });
});

describe("formalStageUsage", () => {
  const formalResult = (details: unknown): ChatLine => ({
    role: "tool",
    parts: [{ type: "toolResult", toolName: "pi_orchestrator_dispatch", text: "done", isError: false, details }],
  });

  it("extracts persistent completed child usage from final tool details", () => {
    expect(formalStageUsage([formalResult({ evidence: {
      role: "engineer",
      child_session_id: "child-1",
      child_model_attempts: [{ retryable_provider_failure: true }, { retryable_provider_failure: false }],
      child_usage: {
        hasUsage: true,
        assistantMessages: 12,
        tokens: { input: 120, output: 30, cacheRead: 850, cacheWrite: 10, reasoning: 7, total: 1010 },
      },
    } })])).toEqual({
      children: [{
        key: "child-1",
        role: "engineer",
        tokens: { input: 120, output: 30, cacheRead: 850, cacheWrite: 10, reasoning: 7, total: 1010 },
        hasUsage: true,
        partial: false,
        assistantTurns: 12,
        attempts: 2,
        providerRetries: 1,
      }],
      tokens: { input: 120, output: 30, cacheRead: 850, cacheWrite: 10, reasoning: 7, total: 1010 },
      hasUsage: true,
      partial: false,
      attempts: 2,
      providerRetries: 1,
    });
  });

  it("aggregates a parallel reviewer wave and de-duplicates live/final copies", () => {
    const evidence = (role: string, id: string, total: number) => ({ role, child_session_id: id, child_usage: { hasUsage: true, tokens: { total } } });
    expect(formalStageUsage([formalResult({
      evidence: evidence("architecture-doc-steward", "arch", 400),
      results: [
        { evidence: evidence("architecture-doc-steward", "arch", 400) },
        { evidence: evidence("data-migration-reviewer", "data", 600) },
      ],
    })])).toMatchObject({
      children: [
        { key: "arch", role: "architecture-doc-steward", tokens: { total: 400 } },
        { key: "data", role: "data-migration-reviewer", tokens: { total: 600 } },
      ],
      tokens: { total: 1000 },
      attempts: 2,
    });
  });

  it("preserves unknown and partial usage instead of displaying zero", () => {
    expect(formalStageUsage([formalResult({ evidence: {
      role: "qa-reviewer",
      child_session_id: "qa",
      timed_out: true,
      child_usage: { hasUsage: false, coverage: { complete: false }, tokens: {} },
    } })])).toMatchObject({ hasUsage: false, partial: true, children: [{ hasUsage: false, partial: true }] });
  });

  it("does not create stage usage for preflight-only or ordinary tool events", () => {
    expect(formalStageUsage([formalResult({ dispatched: false })])).toBeUndefined();
    expect(formalStageUsage([{ role: "tool", parts: [{ type: "toolResult", toolName: "read", text: "ok", isError: false }] }])).toBeUndefined();
  });
});

describe("summarizeChatGroup", () => {
  it("summarizes special event groups", () => {
    expect(summarizeChatGroup([{ ...text("assistant", "a"), source: "compaction" }])).toBe("1 history compaction summary");
    expect(summarizeChatGroup([
      { ...text("assistant", "a"), source: "branch_summary" },
      { ...text("assistant", "b"), source: "branch_summary" },
    ])).toBe("2 branch summaries");
  });

  it("summarizes mixed groups by role counts", () => {
    expect(summarizeChatGroup([text("tool", "a"), text("system", "b"), text("tool", "c")])).toBe("3 events · 2 tool · 1 system");
  });
});
