import { Buffer } from "node:buffer";
import type { ImageContent } from "@earendil-works/pi-ai";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import WordExtractor from "word-extractor";
import * as XLSX from "@e965/xlsx";
import {
  extensionFromFilename,
  isDocumentAttachmentExtension,
  isImageAttachmentExtension,
  isRiskyAttachmentFilename,
  isSupportedAttachmentExtension,
  isTextAttachmentExtension,
  MAX_ATTACHMENT_COUNT,
  MAX_DATA_BASE64_CHARS,
  MAX_DOCUMENT_ATTACHMENT_BYTES,
  MAX_IMAGE_ATTACHMENT_BYTES,
  MAX_TEXT_ATTACHMENT_BYTES,
  MAX_TOTAL_ATTACHMENT_TEXT_CHARS,
  type PromptAttachmentPayload,
  type PromptAttachmentSummary,
} from "../../shared/promptAttachments.js";
import { saveImageUpload } from "./uploadStore.js";

export interface AttachmentPackagingOptions {
  sessionId?: string;
  includeImages?: boolean;
  uploadRootDir?: string;
}

export interface PackagedPrompt {
  promptText: string;
  displayText: string;
  attachments: PromptAttachmentSummary[];
  images: ImageContent[];
}

export type AttachmentSummary = PromptAttachmentSummary;

interface ProcessedAttachment {
  summary: AttachmentSummary;
  content?: string;
  image?: ImageContent;
}

export async function packagePromptWithAttachments(text: string, attachmentsValue: unknown, options: AttachmentPackagingOptions = {}): Promise<PackagedPrompt> {
  const attachments = normalizePromptAttachments(attachmentsValue);
  if (attachments.length === 0) return { promptText: text, displayText: text, attachments: [], images: [] };

  const processed: ProcessedAttachment[] = [];
  let remainingChars = MAX_TOTAL_ATTACHMENT_TEXT_CHARS;
  for (const attachment of attachments) {
    const item = await processAttachment(attachment, remainingChars, options);
    processed.push(item);
    if (item.content !== undefined) remainingChars = Math.max(0, remainingChars - item.content.length);
  }

  const promptText = buildPromptText(text, processed);
  return { promptText, displayText: text, attachments: processed.map((item) => item.summary), images: processed.flatMap((item) => item.image === undefined ? [] : [item.image]) };
}

export function normalizePromptAttachments(value: unknown): PromptAttachmentPayload[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("attachments must be an array");
  return value.slice(0, MAX_ATTACHMENT_COUNT).map(normalizePromptAttachment);
}

function normalizePromptAttachment(value: unknown): PromptAttachmentPayload {
  if (!isRecord(value)) throw new Error("attachment must be an object");
  const filename = requiredString(value["filename"], "attachment filename").slice(0, 240);
  const rawExtension = value["extension"];
  const extension = (typeof rawExtension === "string" && rawExtension !== "" ? rawExtension : extensionFromFilename(filename)).toLowerCase();
  const kind = normalizeKind(value["kind"]);
  const mime = stringValue(value["mime"], "application/octet-stream").slice(0, 160);
  const size = numberValue(value["size"], 0);
  const rawWarnings = value["warnings"];
  const warnings = Array.isArray(rawWarnings) ? rawWarnings.filter((item): item is string => typeof item === "string").slice(0, 5) : [];
  const rawText = value["text"];
  const text = typeof rawText === "string" ? rawText : undefined;
  const rawDataBase64 = value["dataBase64"];
  const dataBase64 = typeof rawDataBase64 === "string" && rawDataBase64.length <= MAX_DATA_BASE64_CHARS ? rawDataBase64 : undefined;
  const rawDataUrl = value["dataUrl"];
  const dataUrl = typeof rawDataUrl === "string" && rawDataUrl.length <= MAX_DATA_BASE64_CHARS + 80 ? rawDataUrl : undefined;
  const rawExtractionStatus = value["extractionStatus"];
  const extractionStatus = rawExtractionStatus === "ready" || rawExtractionStatus === "metadata-only" || rawExtractionStatus === "failed" ? rawExtractionStatus : undefined;
  const rawReason = value["reason"];
  const reason = typeof rawReason === "string" ? rawReason.slice(0, 240) : undefined;
  return { id: stringValue(value["id"], `att-${filename}`), kind, filename, extension, mime, size, source: "drop", warnings, ...(text === undefined ? {} : { text }), ...(dataBase64 === undefined ? {} : { dataBase64 }), ...(dataUrl === undefined ? {} : { dataUrl }), ...(extractionStatus === undefined ? {} : { extractionStatus }), ...(reason === undefined ? {} : { reason }) };
}

async function processAttachment(attachment: PromptAttachmentPayload, remainingChars: number, options: AttachmentPackagingOptions): Promise<ProcessedAttachment> {
  const warnings = [...attachment.warnings];
  if (isRiskyAttachmentFilename(attachment.filename)) warnings.push("Sensitive filename: content was not attached.");
  if (!isSupportedAttachmentExtension(attachment.extension)) return metadataOnly(attachment, warnings, "Unsupported file type.");
  if (warnings.length > attachment.warnings.length) return metadataOnly(attachment, warnings, "Sensitive filename.");

  try {
    if (isTextAttachmentExtension(attachment.extension)) return processTextAttachment(attachment, warnings, remainingChars);
    if (isImageAttachmentExtension(attachment.extension)) return await processImageAttachment(attachment, warnings, options);
    if (isDocumentAttachmentExtension(attachment.extension)) return await processDocumentAttachment(attachment, warnings, remainingChars);
    return metadataOnly(attachment, warnings, "Unsupported file type.");
  } catch (error) {
    return {
      summary: { filename: attachment.filename, kind: attachment.kind, mime: attachment.mime, size: attachment.size, status: "failed", warnings: [...warnings, error instanceof Error ? error.message : String(error)] },
    };
  }
}

function processTextAttachment(attachment: PromptAttachmentPayload, warnings: string[], remainingChars: number): ProcessedAttachment {
  if (attachment.size > MAX_TEXT_ATTACHMENT_BYTES) return metadataOnly(attachment, [...warnings, "Text file exceeds size limit."], "Text file exceeds size limit.");
  if (attachment.text === undefined) return metadataOnly(attachment, warnings, "No text content supplied.");
  return includeText(attachment, warnings, attachment.text, remainingChars);
}

async function processImageAttachment(attachment: PromptAttachmentPayload, warnings: string[], options: AttachmentPackagingOptions): Promise<ProcessedAttachment> {
  if (attachment.size > MAX_IMAGE_ATTACHMENT_BYTES) return metadataOnly(attachment, [...warnings, "Image exceeds size limit."], "Image exceeds size limit.");
  const buffer = decodeAttachmentBuffer(attachment);
  if (buffer === undefined) return metadataOnly(attachment, warnings, "No image content supplied.");
  const saved = options.sessionId === undefined ? undefined : await saveImageUpload(options.sessionId, attachment, buffer, options.uploadRootDir === undefined ? {} : { rootDir: options.uploadRootDir });
  const imageSupported = options.includeImages === true;
  const summaryWarnings = imageSupported ? warnings : [...warnings, "Current model does not support image input; image content was not sent inline."];
  const content = [
    ...(saved === undefined ? [] : [`Saved image path: ${saved.absolutePath}`]),
    imageSupported ? "Inline image was sent to Pi vision input." : "Inline image was not sent because the current model does not support image input.",
  ].join("\n");
  return {
    summary: { filename: attachment.filename, kind: "image", mime: attachment.mime, size: attachment.size, status: imageSupported ? "included" : "metadata-only", warnings: summaryWarnings },
    content,
    ...(imageSupported ? { image: { type: "image" as const, data: buffer.toString("base64"), mimeType: attachment.mime } } : {}),
  };
}

async function processDocumentAttachment(attachment: PromptAttachmentPayload, warnings: string[], remainingChars: number): Promise<ProcessedAttachment> {
  if (attachment.size > MAX_DOCUMENT_ATTACHMENT_BYTES) return metadataOnly(attachment, [...warnings, "Document exceeds size limit."], "Document exceeds size limit.");
  const buffer = decodeAttachmentBuffer(attachment);
  if (buffer === undefined) return metadataOnly(attachment, warnings, "No document content supplied.");
  if (attachment.extension === ".pdf") return includeText(attachment, warnings, await extractPdfText(buffer), remainingChars);
  if (attachment.extension === ".docx") return includeText(attachment, warnings, await extractDocxText(buffer), remainingChars);
  if (attachment.extension === ".doc") return includeText(attachment, warnings, await extractDocText(buffer), remainingChars);
  if (attachment.extension === ".xlsx" || attachment.extension === ".xls") return includeText(attachment, warnings, extractWorkbookText(buffer), remainingChars);
  return metadataOnly(attachment, warnings, "Unsupported document type.");
}

async function extractPdfText(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return result.text;
  } finally {
    await parser.destroy();
  }
}

async function extractDocxText(buffer: Buffer): Promise<string> {
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}

async function extractDocText(buffer: Buffer): Promise<string> {
  const extractor = new WordExtractor();
  const result = await extractor.extract(buffer);
  return result.getBody();
}

function extractWorkbookText(buffer: Buffer): string {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  return workbook.SheetNames.map((name) => {
    const sheet = workbook.Sheets[name];
    const csv = sheet === undefined ? "" : XLSX.utils.sheet_to_csv(sheet);
    return `<sheet name="${escapeAttribute(name)}">\n${csv.trim()}\n</sheet>`;
  }).join("\n\n");
}

function includeText(attachment: PromptAttachmentPayload, warnings: string[], text: string, remainingChars: number): ProcessedAttachment {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (normalized === "") return metadataOnly(attachment, [...warnings, "No readable text extracted."], "No readable text extracted.");
  const truncated = normalized.length > remainingChars;
  const content = truncated ? normalized.slice(0, Math.max(0, remainingChars)) : normalized;
  return {
    summary: { filename: attachment.filename, kind: attachment.kind, mime: attachment.mime, size: attachment.size, status: truncated ? "truncated" : "included", warnings: truncated ? [...warnings, "Attachment text was truncated."] : warnings },
    content,
  };
}

function metadataOnly(attachment: PromptAttachmentPayload, warnings: string[], reason: string): ProcessedAttachment {
  return { summary: { filename: attachment.filename, kind: attachment.kind, mime: attachment.mime, size: attachment.size, status: "metadata-only", warnings: warnings.length > 0 ? warnings : [reason] } };
}

function buildPromptText(text: string, attachments: ProcessedAttachment[]): string {
  const lines = ["<pi-web-user-message>", text.trim(), "</pi-web-user-message>", "", "<pi-web-attachments>"];
  for (const item of attachments) {
    const summary = item.summary;
    lines.push(`<attachment filename="${escapeAttribute(summary.filename)}" kind="${summary.kind}" mime="${escapeAttribute(summary.mime)}" size="${String(summary.size)}" status="${summary.status}">`);
    if (item.content !== undefined) lines.push(item.content);
    else lines.push(`[${summary.status}: ${summary.warnings.join("; ")}]`);
    lines.push("</attachment>", "");
  }
  lines.push("</pi-web-attachments>");
  return lines.join("\n");
}

function decodeAttachmentBuffer(attachment: PromptAttachmentPayload): Buffer | undefined {
  if (attachment.dataBase64 === undefined) return undefined;
  return Buffer.from(attachment.dataBase64, "base64");
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is required`);
  return value.trim();
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : fallback;
}

function normalizeKind(value: unknown): PromptAttachmentPayload["kind"] {
  return value === "text" || value === "document" || value === "image" || value === "unsupported" ? value : "unsupported";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
