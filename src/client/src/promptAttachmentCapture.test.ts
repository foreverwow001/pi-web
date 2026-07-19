import { describe, expect, it, vi } from "vitest";
import { PromptEditor } from "./components/PromptEditor";
import { capturePromptAttachments, DEFAULT_FILE_MIME_TYPE, effectivePromptAttachmentDelivery, READ_FAILURE_MESSAGE, type CapturableFile } from "./promptAttachmentCapture";

function file(name: string, type: string, size = 10): CapturableFile {
  return { name, type, size };
}

describe("capturePromptAttachments", () => {
  it("reads supported images as native inline image attachments", async () => {
    const result = await capturePromptAttachments(
      [file("shot.png", "image/png"), file("pic.webp", "image/webp")],
      (f) => Promise.resolve(`data-for-${f.name}`),
    );

    expect(result.error).toBeUndefined();
    expect(result.attachments).toEqual([
      { kind: "image", name: "shot.png", mimeType: "image/png", data: "data-for-shot.png", size: 10 },
      { kind: "image", name: "pic.webp", mimeType: "image/webp", data: "data-for-pic.webp", size: 10 },
    ]);
  });

  it("captures generic files with their browser MIME type", async () => {
    const result = await capturePromptAttachments(
      [file("report.pdf", "application/pdf", 1234), file("vector.svg", "image/svg+xml")],
      (f) => Promise.resolve(`data-for-${f.name}`),
    );

    expect(result.error).toBeUndefined();
    expect(result.attachments).toEqual([
      { kind: "file", name: "report.pdf", mimeType: "application/pdf", data: "data-for-report.pdf", size: 1234 },
      { kind: "file", name: "vector.svg", mimeType: "image/svg+xml", data: "data-for-vector.svg", size: 10 },
    ]);
  });

  it("uses application/octet-stream when the browser does not provide a MIME type", async () => {
    const result = await capturePromptAttachments([file("archive", "")], () => Promise.resolve("x"));

    expect(result.attachments[0]).toMatchObject({ kind: "file", name: "archive", mimeType: DEFAULT_FILE_MIME_TYPE });
  });

  it("derives fallback names for unnamed pasted attachments", async () => {
    const result = await capturePromptAttachments(
      [file("", "image/jpeg"), file("", "application/pdf")],
      () => Promise.resolve("x"),
    );

    expect(result.attachments.map((attachment) => attachment.name)).toEqual(["pasted-image.jpg", "pasted-file.bin"]);
  });

  it("reports a read failure without dropping other attachments", async () => {
    const result = await capturePromptAttachments(
      [file("bad.png", "image/png"), file("good.txt", "text/plain")],
      (f) => f.name === "bad.png" ? Promise.reject(new Error("boom")) : Promise.resolve("ok"),
    );

    expect(result.error).toBe(READ_FAILURE_MESSAGE);
    expect(result.attachments.map((attachment) => attachment.name)).toEqual(["good.txt"]);
  });

  it("returns no attachments and no error for an empty batch", async () => {
    const result = await capturePromptAttachments([], () => Promise.resolve("x"));
    expect(result).toEqual({ attachments: [] });
  });
});

describe("effectivePromptAttachmentDelivery", () => {
  it("preserves inline delivery when all pending attachments are supported images", () => {
    expect(effectivePromptAttachmentDelivery("inline", [{ kind: "image", mimeType: "image/png" }])).toBe("inline");
  });

  it("preserves an explicit folder preference for supported images", () => {
    expect(effectivePromptAttachmentDelivery("folder", [{ kind: "image", mimeType: "image/png" }])).toBe("folder");
  });

  it("forces folder delivery when any attachment is a generic file", () => {
    expect(effectivePromptAttachmentDelivery("inline", [
      { kind: "image", mimeType: "image/png" },
      { kind: "file", mimeType: "application/pdf" },
    ])).toBe("folder");
  });
});

describe("PromptEditor attachment wiring", () => {
  it("captures pasted files and sends the structured attachment payload", async () => {
    const editor = new PromptEditor();
    const onSend = vi.fn<NonNullable<PromptEditor["onSend"]>>();
    editor.onSend = onSend;
    setPromptEditorPrivate(editor, "draft", "inspect attachments");
    const pasteEvent = pasteEventWithFiles([
      new File(["png"], "shot.png", { type: "image/png" }),
      new File(["pdf"], "report.pdf", { type: "application/pdf" }),
    ]);
    const preventDefault = vi.spyOn(pasteEvent, "preventDefault");

    invokePromptEditorPrivate(editor, "handlePaste", pasteEvent);
    await flushMicrotasks();
    expect(preventDefault).toHaveBeenCalledOnce();

    invokePromptEditorPrivate(editor, "send");
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith("inspect attachments", [
      expect.objectContaining({ kind: "image", filename: "shot.png", mime: "image/png", dataBase64: "cG5n", source: "paste", extractionStatus: "ready" }),
      expect.objectContaining({ kind: "document", filename: "report.pdf", mime: "application/pdf", dataBase64: "cGRm", source: "paste", extractionStatus: "ready" }),
    ], undefined);
  });

  it("removes a pending attachment before sending the remaining attachments", () => {
    const editor = new PromptEditor();
    const onSend = vi.fn<NonNullable<PromptEditor["onSend"]>>();
    editor.onSend = onSend;
    setPromptEditorPrivate(editor, "draft", "please review");
    setPromptEditorPrivate(editor, "attachments", [
      { id: "attachment-1", kind: "document", filename: "report.pdf", extension: ".pdf", mime: "application/pdf", size: 6, source: "picker", warnings: [], dataBase64: "UkVQT1JU", extractionStatus: "ready" },
      { id: "attachment-2", kind: "image", filename: "shot.png", extension: ".png", mime: "image/png", size: 3, source: "picker", warnings: [], dataBase64: "UE5H", dataUrl: "data:image/png;base64,UE5H", extractionStatus: "ready" },
    ]);

    invokePromptEditorPrivate(editor, "removeAttachment", "attachment-1");
    invokePromptEditorPrivate(editor, "send");

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith("please review", [
      expect.objectContaining({ id: "attachment-2", kind: "image", filename: "shot.png" }),
    ], undefined);
  });
});

function setPromptEditorPrivate(editor: PromptEditor, property: string, value: unknown): void {
  if (!Reflect.set(editor, property, value)) throw new Error(`Failed to set PromptEditor ${property}`);
}

function invokePromptEditorPrivate(editor: PromptEditor, method: string, ...args: unknown[]): unknown {
  const handler: unknown = Reflect.get(editor, method);
  if (typeof handler !== "function") throw new Error(`Missing PromptEditor method: ${method}`);
  return Reflect.apply(handler, editor, args);
}


function pasteEventWithFiles(files: readonly File[]): Event {
  const event = new Event("paste", { cancelable: true });
  const items = files.map((file) => ({ kind: "file", getAsFile: () => file }));
  Object.defineProperty(event, "clipboardData", { value: { items, getData: () => "" } });
  return event;
}

async function flushMicrotasks(): Promise<void> {
  for (let remaining = 0; remaining < 10; remaining += 1) await Promise.resolve();
}
