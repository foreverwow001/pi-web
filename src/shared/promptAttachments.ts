import type { PromptAttachment, PromptFileAttachment, PromptImageAttachment } from "./apiTypes.js";

export type PromptAttachmentKind = "text" | "document" | "image" | "unsupported";
export type PromptAttachmentSource = "drop" | "picker" | "paste";
export type PromptAttachmentExtractionStatus = "ready" | "metadata-only" | "failed";

export interface PromptAttachmentSummary {
  filename: string;
  kind: PromptAttachmentKind;
  mime: string;
  size: number;
  status: "included" | "metadata-only" | "failed" | "truncated";
  warnings: string[];
}

export interface PromptAttachmentPayload {
  id: string;
  kind: PromptAttachmentKind;
  filename: string;
  extension: string;
  mime: string;
  size: number;
  source: PromptAttachmentSource;
  warnings: string[];
  text?: string;
  dataBase64?: string;
  dataUrl?: string;
  extractionStatus?: PromptAttachmentExtractionStatus;
  reason?: string;
}

export const TEXT_ATTACHMENT_EXTENSIONS = [".txt", ".md", ".html", ".csv"] as const;
export const DOCUMENT_ATTACHMENT_EXTENSIONS = [".pdf", ".docx", ".doc", ".xlsx", ".xls"] as const;
export const IMAGE_ATTACHMENT_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif"] as const;
export const SUPPORTED_ATTACHMENT_EXTENSIONS = [
  ...TEXT_ATTACHMENT_EXTENSIONS,
  ...DOCUMENT_ATTACHMENT_EXTENSIONS,
  ...IMAGE_ATTACHMENT_EXTENSIONS,
] as const;

const TEXT_ATTACHMENT_EXTENSION_SET = new Set<string>(TEXT_ATTACHMENT_EXTENSIONS);
const DOCUMENT_ATTACHMENT_EXTENSION_SET = new Set<string>(DOCUMENT_ATTACHMENT_EXTENSIONS);
const IMAGE_ATTACHMENT_EXTENSION_SET = new Set<string>(IMAGE_ATTACHMENT_EXTENSIONS);
const SUPPORTED_ATTACHMENT_EXTENSION_SET = new Set<string>(SUPPORTED_ATTACHMENT_EXTENSIONS);

export const MAX_ATTACHMENT_COUNT = 10;
export const MAX_TEXT_ATTACHMENT_BYTES = 512 * 1024;
export const MAX_DOCUMENT_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_TEXT_CHARS = 120_000;
export const MAX_DATA_BASE64_CHARS = Math.ceil((MAX_DOCUMENT_ATTACHMENT_BYTES * 4) / 3) + 16;

/** Image mime types supported by the pi coding agent. */
export const SUPPORTED_IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
export type SupportedImageMimeType = typeof SUPPORTED_IMAGE_MIME_TYPES[number];
const supportedImageMimeTypes: ReadonlySet<string> = new Set(SUPPORTED_IMAGE_MIME_TYPES);

/** Maximum base64 payload per image; mirrors upstream PI WEB validation. */
export const MAX_INLINE_IMAGE_BASE64_BYTES = Math.round(4.5 * 1024 * 1024);
export const MAX_PROMPT_ATTACHMENTS = 16;

export function extensionFromFilename(filename: string): string {
  const normalized = filename.trim().toLowerCase();
  const index = normalized.lastIndexOf(".");
  return index <= 0 ? "" : normalized.slice(index);
}

export function isTextAttachmentExtension(extension: string): boolean {
  return TEXT_ATTACHMENT_EXTENSION_SET.has(extension.toLowerCase());
}

export function isDocumentAttachmentExtension(extension: string): boolean {
  return DOCUMENT_ATTACHMENT_EXTENSION_SET.has(extension.toLowerCase());
}

export function isImageAttachmentExtension(extension: string): boolean {
  return IMAGE_ATTACHMENT_EXTENSION_SET.has(extension.toLowerCase());
}

export function isSupportedAttachmentExtension(extension: string): boolean {
  return SUPPORTED_ATTACHMENT_EXTENSION_SET.has(extension.toLowerCase());
}

export function isRiskyAttachmentFilename(filename: string): boolean {
  const value = filename.toLowerCase();
  return /(^|[/.\\_-])(\.env|secret|token|password|credential|credentials|auth|private|\.?key)([/.\\_-]|$)/.test(value)
    || value.endsWith(".pem")
    || value.endsWith(".key")
    || value === "auth.json"
    || value === "credentials.json";
}

export function isSupportedImageMimeType(value: unknown): value is SupportedImageMimeType {
  return typeof value === "string" && supportedImageMimeTypes.has(value);
}

export function extensionForImageMimeType(mimeType: string): string {
  switch (mimeType) {
    case "image/jpeg": return "jpg";
    case "image/png": return "png";
    case "image/gif": return "gif";
    case "image/webp": return "webp";
    default: return "bin";
  }
}

const base64Pattern = /^[A-Za-z0-9+/]*={0,2}$/;

export function base64ByteLength(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

export interface AttachmentValidationOptions {
  enforceInlineSizeLimit?: boolean;
  /** When true, accept general file attachments for save-to-folder delivery. */
  allowFileAttachments?: boolean;
  maxAttachments?: number;
}

type ImageOnlyAttachmentValidationOptions = AttachmentValidationOptions & { allowFileAttachments?: false | undefined };
type SaveAttachmentValidationOptions = AttachmentValidationOptions & { allowFileAttachments: true };

/**
 * Validate and normalize untrusted prompt attachments. Throws on malformed,
 * unsupported, or oversized input so routes can return a 400.
 */
export function parsePromptAttachments(value: unknown, options?: ImageOnlyAttachmentValidationOptions): PromptImageAttachment[];
export function parsePromptAttachments(value: unknown, options: SaveAttachmentValidationOptions): PromptAttachment[];
export function parsePromptAttachments(value: unknown, options: AttachmentValidationOptions = {}): PromptAttachment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("attachments must be an array");
  const maxAttachments = options.maxAttachments ?? MAX_PROMPT_ATTACHMENTS;
  if (value.length > maxAttachments) throw new Error(`too many attachments (max ${String(maxAttachments)})`);
  return value.map((entry, index) => parsePromptAttachment(entry, index, options));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePromptAttachment(value: unknown, index: number, options: AttachmentValidationOptions): PromptAttachment {
  if (!isRecord(value)) throw new Error(`attachment ${String(index)} must be an object`);
  const record = value;
  const kind = record["kind"];
  if (kind === "image") return parseImageAttachment(record, index, options);
  if (kind === "file" && options.allowFileAttachments === true) return parseFileAttachment(record, index);
  throw new Error(`attachment ${String(index)} has unsupported kind`);
}

function parseImageAttachment(record: Record<string, unknown>, index: number, options: AttachmentValidationOptions): PromptImageAttachment {
  const mimeType = record["mimeType"];
  if (!isSupportedImageMimeType(mimeType)) throw new Error(`attachment ${String(index)} has unsupported image type`);
  const data = requireBase64Data(record["data"], index, { allowEmpty: false });
  if (options.enforceInlineSizeLimit === true && base64ByteLength(data) > MAX_INLINE_IMAGE_BASE64_BYTES) {
    throw new Error(`attachment ${String(index)} exceeds the inline image size limit`);
  }
  return {
    kind: "image",
    mimeType,
    data,
    ...attachmentName(record),
  };
}

function parseFileAttachment(record: Record<string, unknown>, index: number): PromptFileAttachment {
  const mimeType = record["mimeType"];
  if (typeof mimeType !== "string" || mimeType.trim() === "") throw new Error(`attachment ${String(index)} has invalid file type`);
  return {
    kind: "file",
    mimeType: mimeType.trim(),
    data: requireBase64Data(record["data"], index, { allowEmpty: true }),
    ...attachmentName(record),
  };
}

function requireBase64Data(value: unknown, index: number, options: { allowEmpty: boolean }): string {
  if (typeof value !== "string" || (!options.allowEmpty && value === "") || !base64Pattern.test(value)) {
    throw new Error(`attachment ${String(index)} has invalid base64 data`);
  }
  return value;
}

function attachmentName(record: Record<string, unknown>): { name?: string } {
  const name = record["name"];
  return typeof name === "string" && name !== "" ? { name } : {};
}
