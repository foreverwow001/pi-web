import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PromptAttachment, SavedPromptAttachment } from "../../shared/apiTypes.js";
import { extensionForImageMimeType } from "../../shared/promptAttachments.js";
import { resolveParentInsideWorkspace } from "../workspaces/pathSafety.js";

/**
 * Default workspace-relative folder used when saving pasted/dropped
 * attachments for the agent to read with its own tools.
 */
export const DEFAULT_ATTACHMENT_FOLDER = ".pi-web/attachments";

export interface SaveAttachmentsOptions {
  folder?: string;
  now?: () => Date;
}

export async function saveAttachmentsToWorkspace(
  cwd: string,
  attachments: PromptAttachment[],
  options: SaveAttachmentsOptions = {},
): Promise<SavedPromptAttachment[]> {
  const folder = normalizeFolder(options.folder ?? DEFAULT_ATTACHMENT_FOLDER);
  const now = options.now ?? (() => new Date());
  const { target: folderTarget } = await resolveParentInsideWorkspace(cwd, folder);
  await mkdir(folderTarget, { recursive: true });

  const stamp = timestamp(now());
  const saved: SavedPromptAttachment[] = [];
  for (const [index, attachment] of attachments.entries()) {
    const bytes = Buffer.from(attachment.data, "base64");
    const filename = `attachment-${stamp}-${String(index + 1)}.${extensionForImageMimeType(attachment.mimeType)}`;
    const relativePath = `${folder}/${filename}`;
    await writeFile(join(folderTarget, filename), bytes);
    saved.push({ path: relativePath, mimeType: attachment.mimeType, size: bytes.byteLength });
  }
  return saved;
}

function normalizeFolder(folder: string): string {
  return folder.split(/[\\/]+/).filter((part) => part !== "" && part !== ".").join("/");
}

function timestamp(date: Date): string {
  const pad = (value: number, length = 2) => String(value).padStart(length, "0");
  return `${String(date.getFullYear())}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}`;
}
