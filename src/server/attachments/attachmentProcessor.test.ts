import { describe, expect, it } from "vitest";
import { packagePromptWithAttachments } from "./attachmentProcessor";

describe("attachment processor", () => {
  it("packages supported text attachments into the prompt", async () => {
    const result = await packagePromptWithAttachments("Review this", [{
      id: "a1",
      kind: "text",
      filename: "notes.md",
      extension: ".md",
      mime: "text/markdown",
      size: 11,
      source: "drop",
      warnings: [],
      text: "hello world",
      extractionStatus: "ready",
    }]);

    expect(result.promptText).toContain("<pi-web-user-message>");
    expect(result.promptText).toContain("hello world");
    expect(result.attachments).toEqual([{ filename: "notes.md", kind: "text", mime: "text/markdown", size: 11, status: "included", warnings: [] }]);
  });

  it("keeps image attachments as metadata only", async () => {
    const result = await packagePromptWithAttachments("Look", [{
      id: "img",
      kind: "image",
      filename: "screen.png",
      extension: ".png",
      mime: "image/png",
      size: 20,
      source: "drop",
      warnings: [],
      dataBase64: "aGVsbG8=",
      extractionStatus: "ready",
    }]);

    expect(result.promptText).toContain("status=\"metadata-only\"");
    expect(result.attachments[0]?.status).toBe("metadata-only");
  });

  it("does not include content for sensitive filenames", async () => {
    const result = await packagePromptWithAttachments("Check", [{
      id: "secret",
      kind: "text",
      filename: ".env",
      extension: ".txt",
      mime: "text/plain",
      size: 10,
      source: "drop",
      warnings: [],
      text: "TOKEN=secret",
      extractionStatus: "ready",
    }]);

    expect(result.promptText).not.toContain("TOKEN=secret");
    expect(result.attachments[0]?.status).toBe("metadata-only");
  });
});
