import { describe, expect, it } from "vitest";
import { promptSendArguments, shouldUseMobileEnterNewline } from "./PromptEditor";
import type { PromptAttachmentPayload } from "../../../shared/promptAttachments";

describe("PromptEditor prompt send contract", () => {
  const attachment: PromptAttachmentPayload = {
    id: "attachment-1",
    kind: "text",
    filename: "note.txt",
    extension: ".txt",
    mime: "text/plain",
    size: 4,
    source: "drop",
    warnings: [],
    text: "note",
    extractionStatus: "ready",
  };

  it.each([
    [undefined, []],
    ["followUp" as const, []],
    ["steer" as const, [attachment]],
  ])("keeps streamingBehavior before attachments (%s)", (streamingBehavior, attachments) => {
    expect(promptSendArguments("hello", streamingBehavior, attachments)).toEqual(["hello", streamingBehavior, attachments]);
  });
});

describe("PromptEditor mobile Enter behavior", () => {
  it("uses newline mode on coarse pointer / touch devices", () => {
    expect(shouldUseMobileEnterNewline((query) => ({ matches: query === "(pointer: coarse)" }))).toBe(true);
  });

  it("uses newline mode in standalone PWA display mode", () => {
    expect(shouldUseMobileEnterNewline((query) => ({ matches: query === "(display-mode: standalone)" }))).toBe(true);
  });

  it("keeps desktop Enter-to-send behavior when no mobile/PWA query matches", () => {
    expect(shouldUseMobileEnterNewline(() => ({ matches: false }))).toBe(false);
  });
});
