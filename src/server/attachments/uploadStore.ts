import { Buffer } from "node:buffer";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { piWebDataDir } from "../../config.js";
import type { PromptAttachmentPayload } from "../../shared/promptAttachments.js";

export interface SavedUpload {
  absolutePath: string;
}

export interface SaveImageUploadOptions {
  rootDir?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export async function saveImageUpload(sessionId: string, attachment: PromptAttachmentPayload, buffer: Buffer, options: SaveImageUploadOptions = {}): Promise<SavedUpload> {
  const rootDir = options.rootDir ?? join(piWebDataDir(options.env, options.cwd), "uploads");
  const sessionDir = join(rootDir, sanitizeSegment(sessionId));
  await mkdir(sessionDir, { recursive: true });
  const filename = `${sanitizeSegment(attachment.id)}-${sanitizeFilename(attachment.filename)}`;
  const absolutePath = join(sessionDir, filename);
  await writeFile(absolutePath, buffer, { mode: 0o600 });
  return { absolutePath };
}

function sanitizeSegment(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 120);
  return sanitized === "" ? "upload" : sanitized;
}

function sanitizeFilename(value: string): string {
  const basename = value.split(/[\\/]/).pop() ?? "image";
  const sanitized = basename.replace(/[^a-zA-Z0-9._ -]/g, "-").replace(/\s+/g, " ").trim().slice(0, 180);
  return sanitized === "" ? "image" : sanitized;
}
