import { describe, expect, it } from "vitest";
import { textMessage } from "./chatMessages";
import { applyTranscriptEvent } from "./chatTranscript";
import type { RoundUsageSnapshot } from "../../shared/apiTypes";
import type { ChatLine } from "./components/shared";

const finalAssistant = {
  role: "assistant",
  content: [
    { type: "thinking", thinking: "plan" },
    { type: "text", text: "answer" },
  ],
  timestamp: "2026-05-09T12:00:00.000Z",
  provider: "test",
  model: "model",
};

describe("applyTranscriptEvent", () => {
  it("streams thinking and text into one assistant message", () => {
    let messages: ChatLine[] = [];
    messages = applyTranscriptEvent(messages, { type: "assistant.thinking.delta", text: "pla" }) ?? messages;
    messages = applyTranscriptEvent(messages, { type: "assistant.thinking.delta", text: "n" }) ?? messages;
    messages = applyTranscriptEvent(messages, { type: "assistant.delta", text: "answer" }) ?? messages;

    expect(messages).toEqual([
      { role: "assistant", parts: [{ type: "thinking", text: "plan" }, { type: "text", text: "answer" }] },
    ]);
  });

  it("replaces the streamed assistant message with the finalized history shape", () => {
    const streamed: ChatLine[] = [
      textMessage("user", "question"),
      { role: "assistant", parts: [{ type: "thinking", text: "partial" }, { type: "text", text: "partial answer" }] },
    ];

    expect(applyTranscriptEvent(streamed, { type: "message.end", message: finalAssistant })).toEqual([
      textMessage("user", "question"),
      {
        role: "assistant",
        parts: [{ type: "thinking", text: "plan" }, { type: "text", text: "answer" }],
        meta: { timestamp: "2026-05-09T12:00:00.000Z", model: { provider: "test", id: "model" } },
      },
    ]);
  });

  it("replaces streamed skill reads when the finalized assistant tool call arrives after the tool result", () => {
    const streamed: ChatLine[] = [
      { role: "skill", parts: [{ type: "skillRead", name: "playwright", path: "/skills/playwright/SKILL.md" }] },
      { role: "tool", parts: [{ type: "toolResult", toolName: "read", text: "skill content", isError: false }] },
    ];

    expect(applyTranscriptEvent(streamed, {
      type: "message.end",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", name: "read", arguments: { path: "/skills/playwright/SKILL.md" } }],
        timestamp: "2026-05-09T12:00:00.000Z",
      },
    })).toEqual([
      { role: "skill", parts: [{ type: "skillRead", name: "playwright", path: "/skills/playwright/SKILL.md" }], meta: { timestamp: "2026-05-09T12:00:00.000Z" } },
      { role: "tool", parts: [{ type: "toolResult", toolName: "read", text: "skill content", isError: false }] },
    ]);
  });

  it("replaces streamed skill reads when the finalized assistant message includes thinking", () => {
    const streamed: ChatLine[] = [
      { role: "skill", parts: [{ type: "skillRead", name: "playwright", path: "/skills/playwright/SKILL.md" }] },
      { role: "tool", parts: [{ type: "toolResult", toolName: "read", text: "skill content", isError: false }] },
    ];

    expect(applyTranscriptEvent(streamed, {
      type: "message.end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "load skill" },
          { type: "toolCall", name: "read", arguments: { path: "/skills/playwright/SKILL.md" } },
        ],
        timestamp: "2026-05-09T12:00:00.000Z",
      },
    })).toEqual([
      { role: "assistant", parts: [{ type: "thinking", text: "load skill" }, { type: "skillRead", name: "playwright", path: "/skills/playwright/SKILL.md" }], meta: { timestamp: "2026-05-09T12:00:00.000Z" } },
      { role: "tool", parts: [{ type: "toolResult", toolName: "read", text: "skill content", isError: false }] },
    ]);
  });

  it("replaces streamed skill reads when finalized paths differ but the skill name matches", () => {
    const streamed: ChatLine[] = [
      { role: "skill", parts: [{ type: "skillRead", name: "playwright", path: "skills/playwright/SKILL.md" }] },
      { role: "tool", parts: [{ type: "toolResult", toolName: "read", text: "skill content", isError: false }] },
    ];

    expect(applyTranscriptEvent(streamed, {
      type: "message.end",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", name: "read", arguments: { path: "/home/user/.agents/skills/playwright/SKILL.md" } }],
        timestamp: "2026-05-09T12:00:00.000Z",
      },
    })).toEqual([
      { role: "skill", parts: [{ type: "skillRead", name: "playwright", path: "/home/user/.agents/skills/playwright/SKILL.md" }], meta: { timestamp: "2026-05-09T12:00:00.000Z" } },
      { role: "tool", parts: [{ type: "toolResult", toolName: "read", text: "skill content", isError: false }] },
    ]);
  });

  it("keeps edit tool preview and result updates on one execution card", () => {
    let messages: ChatLine[] = [];
    messages = applyTranscriptEvent(messages, { type: "tool.start", toolName: "edit", toolCallId: "edit-1", summary: "src/app.ts", args: { path: "src/app.ts", edits: [{ oldText: "old", newText: "new" }] } }) ?? messages;
    messages = applyTranscriptEvent(messages, { type: "tool.update", toolName: "edit", toolCallId: "edit-1", text: "Edit preview computed.", details: { preview: { diff: "-1 old\n+1 new", firstChangedLine: 1 } } }) ?? messages;
    messages = applyTranscriptEvent(messages, { type: "tool.end", toolName: "edit", toolCallId: "edit-1", text: "ok", isError: false, content: [{ type: "text", text: "ok" }], details: { diff: "-1 old\n+1 new", firstChangedLine: 1 } }) ?? messages;
    messages = applyTranscriptEvent(messages, { type: "message.end", message: { role: "toolResult", toolCallId: "edit-1", toolName: "edit", content: [{ type: "text", text: "ok" }], details: { diff: "-1 old\n+1 new", firstChangedLine: 1 }, isError: false } }) ?? messages;

    expect(messages).toEqual([
      {
        role: "tool",
        parts: [{
          type: "toolExecution",
          toolCallId: "edit-1",
          toolName: "edit",
          summary: "src/app.ts",
          args: { path: "src/app.ts", edits: [{ oldText: "old", newText: "new" }] },
          status: "success",
          resultText: "ok",
          content: [{ type: "text", text: "ok" }],
          details: { diff: "-1 old\n+1 new", firstChangedLine: 1 },
          preview: { diff: "-1 old\n+1 new", firstChangedLine: 1 },
        }],
      },
    ]);
  });

  it("does not merge consecutive streamed skill reads", () => {
    let messages: ChatLine[] = [];
    messages = applyTranscriptEvent(messages, { type: "tool.start", toolName: "read", toolCallId: "1", summary: "", args: { path: "/skills/playwright/SKILL.md" } }) ?? messages;
    messages = applyTranscriptEvent(messages, { type: "tool.start", toolName: "read", toolCallId: "2", summary: "", args: { path: "/skills/sentry-cli/SKILL.md" } }) ?? messages;

    expect(messages).toEqual([
      { role: "skill", parts: [{ type: "skillRead", name: "playwright", path: "/skills/playwright/SKILL.md" }] },
      { role: "skill", parts: [{ type: "skillRead", name: "sentry-cli", path: "/skills/sentry-cli/SKILL.md" }] },
    ]);
  });

  it("ignores duplicate streamed skill read starts", () => {
    let messages: ChatLine[] = [];
    messages = applyTranscriptEvent(messages, { type: "tool.start", toolName: "read", toolCallId: "1", summary: "", args: { path: "/skills/playwright/SKILL.md" } }) ?? messages;
    messages = applyTranscriptEvent(messages, { type: "tool.start", toolName: "read", toolCallId: "1", summary: "", args: { path: "/skills/playwright/SKILL.md" } }) ?? messages;

    expect(messages).toEqual([
      { role: "skill", parts: [{ type: "skillRead", name: "playwright", path: "/skills/playwright/SKILL.md" }] },
    ]);
  });

  it("does not merge different finalized user messages", () => {
    const messages = [textMessage("user", "first queued prompt")];

    expect(applyTranscriptEvent(messages, { type: "message.end", message: { role: "user", content: "second queued prompt" } })).toEqual([
      textMessage("user", "first queued prompt"),
      textMessage("user", "second queued prompt"),
    ]);
  });

  it("does not merge optimistic user messages after an aborted turn", () => {
    const messages = [textMessage("user", "stopped prompt")];

    expect(applyTranscriptEvent(messages, { type: "message.append", message: { role: "user", content: "new prompt" } })).toEqual([
      textMessage("user", "stopped prompt"),
      textMessage("user", "new prompt"),
    ]);
  });

  it("replaces a new optimistic user message instead of duplicating it after an aborted turn", () => {
    let messages: ChatLine[] = [textMessage("user", "stopped prompt")];
    messages = applyTranscriptEvent(messages, { type: "message.append", message: { role: "user", content: "new prompt" } }) ?? messages;

    expect(applyTranscriptEvent(messages, { type: "message.end", message: { role: "user", content: "new prompt", timestamp: "2026-05-09T12:00:00.000Z" } })).toEqual([
      textMessage("user", "stopped prompt"),
      { ...textMessage("user", "new prompt"), meta: { timestamp: "2026-05-09T12:00:00.000Z" } },
    ]);
  });

  it("replaces optimistic attachment messages with finalized packaged image prompts", () => {
    const optimistic: ChatLine = { role: "user", parts: [
      { type: "text", text: "Review image" },
      { type: "attachmentSummary", attachments: [{ filename: "screen.png", kind: "image", mime: "image/png", size: 20, status: "included", warnings: [] }] },
    ] };

    expect(applyTranscriptEvent([optimistic], {
      type: "message.end",
      message: {
        role: "user",
        content: [
          { type: "text", text: "<pi-web-user-message>\nReview image\n</pi-web-user-message>\n\n<pi-web-attachments>\n<attachment filename=\"screen.png\" kind=\"image\" mime=\"image/png\" size=\"20\" status=\"included\">\nSaved image path: /tmp/screen.png\nInline image was sent to Pi vision input.\n</attachment>\n</pi-web-attachments>" },
          { type: "image", data: "abc", mimeType: "image/png" },
        ],
        timestamp: "2026-05-09T12:00:00.000Z",
      },
    })).toEqual([{ ...optimistic, meta: { timestamp: "2026-05-09T12:00:00.000Z" } }]);
  });

  it("appends round usage to the final assistant message", () => {
    const messages = [textMessage("user", "question"), textMessage("assistant", "answer")];
    const usage: RoundUsageSnapshot = {
      roundId: "round-1",
      sessionId: "session-1",
      status: "complete",
      parent: { tokens: { input: 100, output: 20, cacheRead: 50, cacheWrite: 0, total: 170 }, cost: 0.01 },
      child: { tokens: { input: 30, output: 10, cacheRead: 0, cacheWrite: 0, total: 40 }, cost: 0.02 },
      total: { tokens: { input: 130, output: 30, cacheRead: 50, cacheWrite: 0, total: 210 }, cost: 0.03 },
      childRuns: 1,
      childUsagePending: false,
      children: [{ role: "qa-reviewer", tokens: { input: 30, output: 10, cacheRead: 0, cacheWrite: 0, total: 40 }, cost: 0.02, hasUsage: true }],
    };

    expect(applyTranscriptEvent(messages, { type: "round.usage", usage })).toEqual([
      textMessage("user", "question"),
      { role: "assistant", parts: [{ type: "text", text: "answer" }, { type: "roundUsage", usage }] },
    ]);
  });

  it("keeps only one round usage row per assistant message", () => {
    const usageOne: RoundUsageSnapshot = {
      roundId: "round-1",
      sessionId: "session-1",
      status: "complete",
      parent: { tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, cost: 0 },
      child: { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 },
      total: { tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, cost: 0 },
      childRuns: 0,
      childUsagePending: false,
      children: [],
    };
    const usageTwo: RoundUsageSnapshot = { ...usageOne, roundId: "round-2", total: { tokens: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, total: 5 }, cost: 0 } };
    const messages = [{ role: "assistant" as const, parts: [{ type: "text" as const, text: "answer" }, { type: "roundUsage" as const, usage: usageOne }] }];

    expect(applyTranscriptEvent(messages, { type: "round.usage", usage: usageTwo })).toEqual([
      { role: "assistant", parts: [{ type: "text", text: "answer" }, { type: "roundUsage", usage: usageTwo }] },
    ]);
  });

  it("preserves round usage if final assistant message arrives after usage event", () => {
    const usage: RoundUsageSnapshot = {
      roundId: "round-1",
      sessionId: "session-1",
      status: "complete",
      parent: { tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, cost: 0 },
      child: { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 },
      total: { tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, cost: 0 },
      childRuns: 0,
      childUsagePending: false,
      children: [],
    };
    const messages = [{ role: "assistant" as const, parts: [{ type: "text" as const, text: "streamed" }, { type: "roundUsage" as const, usage }] }];

    expect(applyTranscriptEvent(messages, { type: "message.end", message: { role: "assistant", content: "final" } })).toEqual([
      { role: "assistant", parts: [{ type: "text", text: "final" }, { type: "roundUsage", usage }] },
    ]);
  });

  it("replaces an optimistic user message when the finalized text matches", () => {
    const messages = [textMessage("user", "sent prompt")];

    expect(applyTranscriptEvent(messages, { type: "message.end", message: { role: "user", content: "sent prompt", timestamp: "2026-05-09T12:00:00.000Z" } })).toEqual([
      { ...textMessage("user", "sent prompt"), meta: { timestamp: "2026-05-09T12:00:00.000Z" } },
    ]);
  });
});
