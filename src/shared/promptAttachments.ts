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
