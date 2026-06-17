import { describe, expect, it } from "vitest";
import { appendText, appendThinking, normalizeMessage, normalizeMessages, textMessage } from "./chatMessages";

describe("chat message normalization", () => {
  it("normalizes simple text messages and drops empty content", () => {
    expect(normalizeMessages([
      { role: "user", content: "hello" },
      { role: "assistant", content: "" },
      { role: "unknown", content: "system text" },
    ])).toEqual([
      textMessage("user", "hello"),
      textMessage("system", "system text"),
    ]);
  });

  it("preserves already-normalized chat lines", () => {
    const line = { role: "assistant" as const, parts: [{ type: "text" as const, text: "cached" }] };

    expect(normalizeMessage(line)).toEqual([line]);
    expect(normalizeMessages([{ role: "user", content: "raw" }, line])).toEqual([textMessage("user", "raw"), line]);
  });

  it("normalizes tool calls and tool results", () => {
    expect(normalizeMessage({ role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "npm test" } }] })).toEqual([
      { role: "assistant", parts: [{ type: "toolCall", toolName: "bash", summary: "npm test", args: { command: "npm test" } }] },
    ]);
    expect(normalizeMessage({ role: "toolResult", toolName: "bash", isError: true, content: [{ type: "text", text: "failed" }] })).toEqual([
      { role: "tool", parts: [{ type: "toolResult", toolName: "bash", text: "failed", content: [{ type: "text", text: "failed" }], isError: true }] },
    ]);
  });

  it("normalizes image content into image parts", () => {
    expect(normalizeMessage({ role: "user", content: [{ type: "text", text: "see this" }, { type: "image", mimeType: "image/png", data: "QUJD" }] })).toEqual([
      { role: "user", parts: [{ type: "text", text: "see this" }, { type: "image", mimeType: "image/png", data: "QUJD" }] },
    ]);
  });

  it("falls back to a placeholder for image content without data", () => {
    expect(normalizeMessage({ role: "user", content: [{ type: "image", mimeType: "image/png" }] })).toEqual([
      { role: "user", parts: [{ type: "text", text: "[image]" }] },
    ]);
  });

  it("shows assistant model errors as system chat messages", () => {
    expect(normalizeMessage({ role: "assistant", content: [], stopReason: "error", errorMessage: "429 rate limit", timestamp: "2026-05-09T12:00:00.000Z", provider: "openai", model: "gpt-4.1" })).toEqual([
      { role: "system", parts: [{ type: "text", text: "Model response failed: 429 rate limit" }], meta: { timestamp: "2026-05-09T12:00:00.000Z", model: { provider: "openai", id: "gpt-4.1" } } },
    ]);
  });

  it("keeps partial assistant content and adds a visible error line", () => {
    expect(normalizeMessage({ role: "assistant", content: [{ type: "text", text: "partial answer" }], stopReason: "error", errorMessage: "connection lost" })).toEqual([
      textMessage("assistant", "partial answer"),
      textMessage("system", "Model response failed: connection lost"),
    ]);
  });

  it("extracts skill invocation blocks into dedicated skill and user messages", () => {
    expect(normalizeMessage({ role: "user", content: "<skill name=\"playwright\" location=\"/skills/playwright\">\nUse browser\n</skill>\n\nNow test the UI" })).toEqual([
      { role: "user", parts: [{ type: "skillInvocation", name: "playwright", location: "/skills/playwright", content: "Use browser" }] },
      textMessage("user", "Now test the UI"),
    ]);
  });

  it("normalizes skill reads into skill chat lines", () => {
    expect(normalizeMessage({ role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "/home/user/.agents/skills/playwright/SKILL.md" } }] })).toEqual([
      { role: "skill", parts: [{ type: "skillRead", name: "playwright", path: "/home/user/.agents/skills/playwright/SKILL.md" }] },
    ]);
  });

  it("pairs tool calls and results into execution cards when normalizing history", () => {
    expect(normalizeMessages([
      { role: "assistant", content: [{ type: "toolCall", id: "edit-1", name: "edit", arguments: { path: "src/app.ts", edits: [{ oldText: "old", newText: "new" }] } }] },
      { role: "toolResult", toolCallId: "edit-1", toolName: "edit", content: [{ type: "text", text: "ok" }], details: { diff: "-1 old\n+1 new" }, isError: false },
    ])).toEqual([
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
          details: { diff: "-1 old\n+1 new" },
        }],
      },
    ]);
  });

  it("formats bash execution records as bash chat lines", () => {
    expect(normalizeMessage({
      role: "bashExecution",
      command: "npm test",
      excludeFromContext: true,
      output: "ok",
      exitCode: 0,
      truncated: true,
      fullOutputPath: "/tmp/out.log",
    })).toEqual([
      textMessage("bash", "excluded from context\n\n$ npm test\n\nok\n\nexit 0\n\noutput truncated\n\nfull output: /tmp/out.log"),
    ]);
  });

  it("renders pi-web attachment package as user text plus attachment summary", () => {
    expect(normalizeMessage({
      role: "user",
      content: "<pi-web-user-message>\nReview this\n</pi-web-user-message>\n\n<pi-web-attachments>\n<attachment filename=\"notes.md\" kind=\"text\" mime=\"text/markdown\" size=\"11\" status=\"included\">\nhello\n</attachment>\n</pi-web-attachments>",
    })).toEqual([
      { role: "user", parts: [
        { type: "text", text: "Review this" },
        { type: "attachmentSummary", attachments: [{ filename: "notes.md", kind: "text", mime: "text/markdown", size: 11, status: "included", warnings: [] }] },
      ] },
    ]);
  });

  it("renders packaged array content as user text plus attachment summary and hides inline image marker", () => {
    expect(normalizeMessage({
      role: "user",
      content: [
        { type: "text", text: "<pi-web-user-message>\nReview image\n</pi-web-user-message>\n\n<pi-web-attachments>\n<attachment filename=\"screen.png\" kind=\"image\" mime=\"image/png\" size=\"20\" status=\"included\">\nSaved image path: /tmp/screen.png\nInline image was sent to Pi vision input.\n</attachment>\n</pi-web-attachments>" },
        { type: "image", data: "abc", mimeType: "image/png" },
      ],
    })).toEqual([
      { role: "user", parts: [
        { type: "text", text: "Review image" },
        { type: "attachmentSummary", attachments: [{ filename: "screen.png", kind: "image", mime: "image/png", size: 20, status: "included", warnings: [] }] },
      ] },
    ]);
  });

  it("normalizes persisted round usage on assistant history messages", () => {
    const roundUsage = {
      roundId: "round-1",
      sessionId: "session-1",
      status: "complete",
      parent: { tokens: { input: 10, output: 5, cacheRead: 2, cacheWrite: 0, total: 17 }, cost: 0.01 },
      child: { tokens: { input: 20, output: 10, cacheRead: 0, cacheWrite: 0, total: 30 }, cost: 0.02 },
      total: { tokens: { input: 30, output: 15, cacheRead: 2, cacheWrite: 0, total: 47 }, cost: 0.03 },
      childRuns: 1,
      childUsagePending: false,
      children: [{ role: "qa-reviewer", tokens: { input: 20, output: 10, cacheRead: 0, cacheWrite: 0, total: 30 }, cost: 0.02, hasUsage: true }],
    };

    expect(normalizeMessage({ role: "assistant", content: "answer", roundUsage })).toEqual([
      { role: "assistant", parts: [{ type: "text", text: "answer" }, { type: "roundUsage", usage: roundUsage }] },
    ]);
  });

  it("renders optimistic attachment summaries from message metadata", () => {
    expect(normalizeMessage({
      role: "user",
      content: "Review this",
      attachments: [{ filename: "screen.png", kind: "image", mime: "image/png", size: 20, status: "metadata-only", warnings: ["metadata only"] }],
    })).toEqual([
      { role: "user", parts: [
        { type: "text", text: "Review this" },
        { type: "attachmentSummary", attachments: [{ filename: "screen.png", kind: "image", mime: "image/png", size: 20, status: "metadata-only", warnings: ["metadata only"] }] },
      ] },
    ]);
  });
});

describe("appendText", () => {
  it("appends to the previous same-role text message", () => {
    expect(appendText([textMessage("assistant", "hello")], "assistant", " world")).toEqual([
      textMessage("assistant", "hello world"),
    ]);
  });

  it("starts a new message when role does not match", () => {
    expect(appendText([textMessage("user", "hello")], "assistant", "hi")).toEqual([
      textMessage("user", "hello"),
      textMessage("assistant", "hi"),
    ]);
  });

  it("adds a text part to the previous same-role non-text message", () => {
    expect(appendText([{ role: "assistant", parts: [{ type: "thinking", text: "plan" }] }], "assistant", "answer")).toEqual([
      { role: "assistant", parts: [{ type: "thinking", text: "plan" }, { type: "text", text: "answer" }] },
    ]);
  });
});

describe("appendThinking", () => {
  it("appends thinking deltas to the previous assistant thinking part", () => {
    expect(appendThinking([{ role: "assistant", parts: [{ type: "thinking", text: "pla" }] }], "n")).toEqual([
      { role: "assistant", parts: [{ type: "thinking", text: "plan" }] },
    ]);
  });

  it("adds a thinking part to the previous assistant message", () => {
    expect(appendThinking([textMessage("assistant", "answer")], "plan")).toEqual([
      { role: "assistant", parts: [{ type: "text", text: "answer" }, { type: "thinking", text: "plan" }] },
    ]);
  });
});
