import type { ChatLine, ChatPart, ToolExecutionPart, ToolPreview } from "./components/shared";
import type { RoundUsageSnapshot } from "../../shared/apiTypes";
import type { PromptAttachmentSummary } from "../../shared/promptAttachments";

export function normalizeMessages(messages: unknown[]): ChatLine[] {
  return coalesceToolExecutions(messages.flatMap(normalizeMessage)).filter((message) => message.parts.length > 0);
}

export function textMessage(role: ChatLine["role"], text: string): ChatLine {
  return { role, parts: [{ type: "text", text }] };
}

export function withMessageMeta(line: ChatLine, rawMessage: unknown): ChatLine {
  const meta = normalizeMeta(rawMessage);
  return meta === undefined ? line : { ...line, meta };
}

export function appendText(messages: ChatLine[], role: ChatLine["role"], text: string): ChatLine[] {
  if (text === "") return messages;
  const last = messages.at(-1);
  const lastPart = last?.parts.at(-1);
  if (last?.role === role && lastPart?.type === "text") {
    return [
      ...messages.slice(0, -1),
      { ...last, parts: [...last.parts.slice(0, -1), { ...lastPart, text: lastPart.text + text }] },
    ];
  }
  if (last?.role === role) return [...messages.slice(0, -1), { ...last, parts: [...last.parts, { type: "text", text }] }];
  return [...messages, textMessage(role, text)];
}

export function appendThinking(messages: ChatLine[], text: string): ChatLine[] {
  if (text === "") return messages;
  const last = messages.at(-1);
  const lastPart = last?.parts.at(-1);
  if (last?.role === "assistant" && lastPart?.type === "thinking") {
    return [
      ...messages.slice(0, -1),
      { ...last, parts: [...last.parts.slice(0, -1), { ...lastPart, text: lastPart.text + text }] },
    ];
  }
  if (last?.role === "assistant") return [...messages.slice(0, -1), { ...last, parts: [...last.parts, { type: "thinking", text }] }];
  return [...messages, { role: "assistant", parts: [{ type: "thinking", text }] }];
}

export function normalizeMessage(message: unknown): ChatLine[] {
  if (isChatLine(message)) return [message];
  if (getString(message, "role") === "bashExecution") return [withMessageMeta(normalizeBashExecution(message), message)];
  const role = normalizeRole(getString(message, "role"));
  const parts = [...normalizeContent(getProperty(message, "content"), message), ...normalizeRoundUsageParts(message)];
  const skillLines = role === "user" ? normalizeSkillInvocation(parts) : undefined;
  if (skillLines !== undefined) return skillLines.map((line) => withMessageMeta(line, message));
  const source = normalizeSource(message);
  if (role === "tool") return [withMessageMeta({ role, parts, ...(source === undefined ? {} : { source }) }, message)];

  const visible = parts.filter((part) => part.type !== "empty");
  const displayRole = role === "assistant" && visible.length > 0 && visible.every((part) => part.type === "skillRead") ? "skill" : role;
  return visible.length > 0 ? [withMessageMeta({ role: displayRole, parts: visible, ...(source === undefined ? {} : { source }) }, message)] : [];
}

function isChatLine(message: unknown): message is ChatLine {
  const role = getString(message, "role");
  return (role === "user" || role === "assistant" || role === "tool" || role === "system" || role === "bash" || role === "skill")
    && Array.isArray(getProperty(message, "parts"));
}

function normalizeSkillInvocation(parts: ChatPart[]): ChatLine[] | undefined {
  if (parts.length !== 1 || parts[0]?.type !== "text") return undefined;
  const skill = parseSkillBlock(parts[0].text);
  if (skill === undefined) return undefined;
  return [
    { role: "user", parts: [{ type: "skillInvocation", name: skill.name, location: skill.location, content: skill.content }] },
    ...(skill.userMessage === undefined ? [] : [{ role: "user" as const, parts: [{ type: "text" as const, text: skill.userMessage }] }]),
  ];
}

function parseSkillBlock(text: string): { name: string; location: string; content: string; userMessage?: string } | undefined {
  const match = /^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/.exec(text);
  if (match === null) return undefined;
  const userMessage = match[4]?.trim();
  return {
    name: match[1] ?? "skill",
    location: match[2] ?? "",
    content: match[3] ?? "",
    ...(userMessage === undefined || userMessage === "" ? {} : { userMessage }),
  };
}

function normalizeSource(message: unknown): ChatLine["source"] | undefined {
  const source = getString(message, "source");
  if (source === "compaction" || source === "branch_summary") return source;
  return undefined;
}

function normalizeMeta(message: unknown): ChatLine["meta"] | undefined {
  const timestamp = normalizeTimestamp(getProperty(message, "timestamp"));
  const model = normalizeModel(message);
  if (timestamp === undefined && model === undefined) return undefined;
  return { ...(timestamp === undefined ? {} : { timestamp }), ...(model === undefined ? {} : { model }) };
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value !== "string" || value === "") return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

function normalizeModel(message: unknown): NonNullable<ChatLine["meta"]>["model"] | undefined {
  if (getString(message, "role") !== "assistant") return undefined;
  const provider = getString(message, "provider");
  const id = getString(message, "model");
  const responseId = getString(message, "responseModel");
  if ((provider === undefined || provider === "") && (id === undefined || id === "") && (responseId === undefined || responseId === "")) return undefined;
  return {
    ...(provider === undefined || provider === "" ? {} : { provider }),
    ...(id === undefined || id === "" ? {} : { id }),
    ...(responseId === undefined || responseId === "" ? {} : { responseId }),
  };
}

function normalizeBashExecution(message: unknown): ChatLine {
  const command = getString(message, "command") ?? "";
  const lines = getBoolean(message, "excludeFromContext") === true ? ["excluded from context", "", `$ ${command}`] : [`$ ${command}`];
  const output = getProperty(message, "output");
  if (output != null) lines.push("", stringifyPrimitive(output));
  const exitCode = getProperty(message, "exitCode");
  if (exitCode != null) lines.push("", `exit ${stringifyPrimitive(exitCode)}`);
  if (getBoolean(message, "cancelled") === true) lines.push("", "cancelled");
  if (getBoolean(message, "truncated") === true) lines.push("", "output truncated");
  const fullOutputPath = getString(message, "fullOutputPath");
  if (fullOutputPath !== undefined && fullOutputPath !== "") lines.push("", `full output: ${fullOutputPath}`);
  return { role: "bash", parts: [{ type: "text", text: lines.join("\n") }] };
}

function normalizeRole(role: unknown): ChatLine["role"] {
  if (role === "assistant") return "assistant";
  if (role === "user") return "user";
  if (role === "toolResult") return "tool";
  return "system";
}

function normalizeContent(content: unknown, message: unknown): ChatPart[] {
  if (typeof content === "string") {
    const packaged = parsePiWebAttachmentPackage(content);
    const text = packaged?.text ?? content;
    const attachments = normalizeAttachmentSummaries(getProperty(message, "attachments")) ?? packaged?.attachments ?? [];
    return [
      ...(text !== "" ? [{ type: "text" as const, text }] : []),
      ...(attachments.length > 0 ? [{ type: "attachmentSummary" as const, attachments }] : []),
    ];
  }
  if (!Array.isArray(content)) return objectFallback(content);

  const packagedTextPart = content
    .map((part) => typeof part === "object" && part !== null && getString(part, "type") === "text" ? getString(part, "text") : undefined)
    .find((text): text is string => text !== undefined && parsePiWebAttachmentPackage(text) !== undefined);
  const packaged = packagedTextPart === undefined ? undefined : parsePiWebAttachmentPackage(packagedTextPart);
  if (packaged !== undefined) {
    const attachments = normalizeAttachmentSummaries(getProperty(message, "attachments")) ?? packaged.attachments;
    return [
      ...(packaged.text !== "" ? [{ type: "text" as const, text: packaged.text }] : []),
      ...(attachments.length > 0 ? [{ type: "attachmentSummary" as const, attachments }] : []),
    ];
  }

  return content.flatMap((part): ChatPart[] => {
    const type = getString(part, "type");
    const text = getString(part, "text");
    if (type === "text") return text !== undefined && text !== "" ? [{ type: "text", text }] : [];
    if (type === "thinking") {
      const thinking = getString(part, "thinking") ?? text;
      return thinking !== undefined && thinking !== "" ? [{ type: "thinking", text: thinking }] : [];
    }
    if (type === "toolCall") {
      const toolName = getString(part, "name") ?? "tool";
      const args = getProperty(part, "arguments");
      const skillRead = toolName === "read" ? parseSkillReadPath(getString(args, "path")) : undefined;
      if (skillRead !== undefined) return [{ type: "skillRead", ...skillRead }];
      const toolCallId = getString(part, "id");
      return [{ type: "toolCall", ...(toolCallId === undefined ? {} : { toolCallId }), toolName, summary: summarizeArgs(args), ...(args === undefined ? {} : { args }) }];
    }
    if (type === "image") return [{ type: "text", text: "[image]" }];
    return objectFallback(part);
  }).map((part) => part.type === "text" && getString(message, "role") === "toolResult"
    ? toolResultPartFromText(part.text, message)
    : part);
}

function normalizeRoundUsageParts(message: unknown): ChatPart[] {
  const usage = getProperty(message, "roundUsage");
  return isRoundUsageSnapshot(usage) ? [{ type: "roundUsage", usage }] : [];
}

function isRoundUsageSnapshot(value: unknown): value is RoundUsageSnapshot {
  if (!isRecord(value)) return false;
  if (typeof value["roundId"] !== "string" || typeof value["sessionId"] !== "string") return false;
  if (value["status"] !== "complete" && value["status"] !== "partial") return false;
  return isUsageBreakdown(value["parent"]) && isUsageBreakdown(value["child"]) && isUsageBreakdown(value["total"])
    && typeof value["childRuns"] === "number"
    && typeof value["childUsagePending"] === "boolean"
    && Array.isArray(value["children"]);
}

function isUsageBreakdown(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value["tokens"])) return false;
  const tokens = value["tokens"];
  return typeof tokens["input"] === "number"
    && typeof tokens["output"] === "number"
    && typeof tokens["cacheRead"] === "number"
    && typeof tokens["cacheWrite"] === "number"
    && typeof tokens["total"] === "number"
    && typeof value["cost"] === "number";
}

function parsePiWebAttachmentPackage(text: string): { text: string; attachments: PromptAttachmentSummary[] } | undefined {
  const messageMatch = /<pi-web-user-message>\n([\s\S]*?)\n<\/pi-web-user-message>/.exec(text);
  const attachmentsMatch = /<pi-web-attachments>\n([\s\S]*?)\n<\/pi-web-attachments>/.exec(text);
  if (messageMatch === null || attachmentsMatch === null) return undefined;
  const attachmentText = attachmentsMatch[1] ?? "";
  const attachments = [...attachmentText.matchAll(/<attachment\s+([^>]+)>/g)].map((match): PromptAttachmentSummary | undefined => {
    const attrs = parseAttributes(match[1] ?? "");
    const filename = attrs.get("filename") ?? "attachment";
    const kind = normalizeAttachmentKind(attrs.get("kind"));
    const mime = attrs.get("mime") ?? "application/octet-stream";
    const size = Number(attrs.get("size") ?? 0);
    const status = normalizeAttachmentStatus(attrs.get("status"));
    return { filename, kind, mime, size: Number.isFinite(size) ? size : 0, status, warnings: [] };
  }).filter((item): item is PromptAttachmentSummary => item !== undefined);
  return { text: (messageMatch[1] ?? "").trim(), attachments };
}

function normalizeAttachmentSummaries(value: unknown): PromptAttachmentSummary[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const summaries = value.map((item): PromptAttachmentSummary | undefined => {
    if (!isRecord(item)) return undefined;
    const filename = getString(item, "filename") ?? "attachment";
    const rawSize = getProperty(item, "size");
    const rawWarnings = getProperty(item, "warnings");
    return {
      filename,
      kind: normalizeAttachmentKind(getString(item, "kind")),
      mime: getString(item, "mime") ?? "application/octet-stream",
      size: typeof rawSize === "number" ? rawSize : 0,
      status: normalizeAttachmentStatus(getString(item, "status")),
      warnings: Array.isArray(rawWarnings) ? rawWarnings.filter((entry): entry is string => typeof entry === "string") : [],
    };
  }).filter((item): item is PromptAttachmentSummary => item !== undefined);
  return summaries.length === 0 ? undefined : summaries;
}

function parseAttributes(value: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const match of value.matchAll(/([a-zA-Z]+)="([^"]*)"/g)) attrs.set(match[1] ?? "", unescapeAttribute(match[2] ?? ""));
  return attrs;
}

function unescapeAttribute(value: string): string {
  return value.replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function normalizeAttachmentKind(value: unknown): PromptAttachmentSummary["kind"] {
  return value === "text" || value === "document" || value === "image" || value === "unsupported" ? value : "unsupported";
}

function normalizeAttachmentStatus(value: unknown): PromptAttachmentSummary["status"] {
  return value === "included" || value === "metadata-only" || value === "failed" || value === "truncated" ? value : "metadata-only";
}

function toolResultPartFromText(text: string, message: unknown): Extract<ChatPart, { type: "toolResult" }> {
  const toolCallId = getString(message, "toolCallId");
  const content = getProperty(message, "content");
  const details = getProperty(message, "details");
  return {
    type: "toolResult",
    ...(toolCallId === undefined ? {} : { toolCallId }),
    toolName: getString(message, "toolName") ?? "tool",
    text,
    ...(content === undefined ? {} : { content }),
    ...(details === undefined ? {} : { details }),
    isError: getBoolean(message, "isError") === true,
  };
}

function parseSkillReadPath(path: string | undefined): { name: string; path: string } | undefined {
  if (path === undefined || path === "") return undefined;
  const normalized = path.replace(/\\/g, "/");
  if (!normalized.endsWith("/SKILL.md") && normalized !== "SKILL.md") return undefined;
  const name = normalized.split("/").at(-2);
  if (name === undefined || name === "") return undefined;
  return { name, path };
}

function coalesceToolExecutions(lines: ChatLine[]): ChatLine[] {
  const result: ChatLine[] = [];
  const pendingTools = new Map<string, { lineIndex: number; partIndex: number }>();

  for (const line of lines) {
    let passthroughParts: ChatPart[] = [];
    const metadata = { ...(line.source === undefined ? {} : { source: line.source }), ...(line.meta === undefined ? {} : { meta: line.meta }) };
    const flushPassthrough = () => {
      if (passthroughParts.length === 0) return;
      result.push({ role: line.role, parts: passthroughParts, ...metadata });
      passthroughParts = [];
    };

    for (const part of line.parts) {
      if (part.type === "toolCall") {
        flushPassthrough();
        const execution = toolExecutionFromCall(part);
        const lineIndex = result.length;
        result.push({ role: "tool", parts: [execution], ...metadata });
        if (execution.toolCallId !== undefined) pendingTools.set(execution.toolCallId, { lineIndex, partIndex: 0 });
        continue;
      }

      if (part.type === "toolResult") {
        const target = part.toolCallId === undefined ? undefined : pendingTools.get(part.toolCallId);
        if (target !== undefined && mergeToolResultInto(result, target, part)) {
          pendingTools.delete(part.toolCallId ?? "");
          continue;
        }
      }

      passthroughParts.push(part);
    }

    flushPassthrough();
  }

  return result;
}

function toolExecutionFromCall(part: Extract<ChatPart, { type: "toolCall" }>): ToolExecutionPart {
  return {
    type: "toolExecution",
    ...(part.toolCallId === undefined ? {} : { toolCallId: part.toolCallId }),
    toolName: part.toolName,
    summary: part.summary,
    ...(part.args === undefined ? {} : { args: part.args }),
    status: "pending",
  };
}

function mergeToolResultInto(lines: ChatLine[], target: { lineIndex: number; partIndex: number }, result: Extract<ChatPart, { type: "toolResult" }>): boolean {
  const line = lines[target.lineIndex];
  const current = line?.parts[target.partIndex];
  if (line === undefined || current?.type !== "toolExecution") return false;
  const preview = previewFromDetails(result.details) ?? current.preview;
  const next: ToolExecutionPart = {
    ...current,
    status: result.isError ? "error" : "success",
    resultText: result.text,
    ...(result.content === undefined ? {} : { content: result.content }),
    ...(result.details === undefined ? {} : { details: result.details }),
    ...(preview === undefined ? {} : { preview }),
  };
  lines[target.lineIndex] = { ...line, parts: [...line.parts.slice(0, target.partIndex), next, ...line.parts.slice(target.partIndex + 1)] };
  return true;
}

export function previewFromDetails(details: unknown): ToolPreview | undefined {
  const preview = getProperty(details, "preview");
  if (!isRecord(preview)) return undefined;
  const diff = getString(preview, "diff");
  const error = getString(preview, "error");
  const firstChangedLine = getNumber(preview, "firstChangedLine");
  if (diff === undefined && error === undefined && firstChangedLine === undefined) return undefined;
  return {
    ...(diff === undefined ? {} : { diff }),
    ...(error === undefined ? {} : { error }),
    ...(firstChangedLine === undefined ? {} : { firstChangedLine }),
  };
}

function objectFallback(value: unknown): ChatPart[] {
  if (value == null) return [];
  if (typeof value === "object") return [{ type: "text", text: summarizeArgs(value) }];
  return [{ type: "text", text: stringifyPrimitive(value) }];
}

export function summarizeArgs(args: unknown): string {
  if (!isRecord(args)) return stringifyPrimitive(args);
  const command = getString(args, "command");
  if (command !== undefined) return command;
  const path = getString(args, "path");
  if (path !== undefined) return path;
  if (typeof args["oldText"] === "string" && typeof args["newText"] === "string") return "edit text replacement";
  const edits = args["edits"];
  if (Array.isArray(edits)) return `${String(edits.length)} edit${edits.length === 1 ? "" : "s"}`;
  const entries = Object.entries(args).filter(([, value]) => value != null).slice(0, 3);
  return entries.map(([key, value]) => `${key}: ${shortValue(value)}`).join(" · ");
}

function shortValue(value: unknown): string {
  if (typeof value === "string") return value.length > 80 ? `${value.slice(0, 77)}…` : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `${String(value.length)} item${value.length === 1 ? "" : "s"}`;
  if (typeof value === "object" && value !== null) return "object";
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getProperty(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function getString(value: unknown, key: string): string | undefined {
  const property = getProperty(value, key);
  return typeof property === "string" ? property : undefined;
}

function getBoolean(value: unknown, key: string): boolean | undefined {
  const property = getProperty(value, key);
  return typeof property === "boolean" ? property : undefined;
}

function getNumber(value: unknown, key: string): number | undefined {
  const property = getProperty(value, key);
  return typeof property === "number" && Number.isFinite(property) ? property : undefined;
}

function stringifyPrimitive(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  return "";
}
