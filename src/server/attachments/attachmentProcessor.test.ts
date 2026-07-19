import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("keeps image attachments as metadata only when inline images are disabled", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "pi-web-attachments-"));
    try {
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
      }], { sessionId: "session/image", uploadRootDir: tempDir });

      expect(result.promptText).toContain("status=\"metadata-only\"");
      expect(result.promptText).toContain("Saved image path:");
      expect(result.images).toEqual([]);
      expect(result.attachments[0]?.status).toBe("metadata-only");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("sends supported image attachments as Pi image inputs", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "pi-web-attachments-"));
    try {
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
      }], { sessionId: "session/image", includeImages: true, uploadRootDir: tempDir });

      expect(result.promptText).toContain("status=\"included\"");
      expect(result.promptText).toContain("Inline image was sent to Pi vision input.");
      expect(result.images).toEqual([{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }]);
      expect(result.attachments[0]?.status).toBe("included");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
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
