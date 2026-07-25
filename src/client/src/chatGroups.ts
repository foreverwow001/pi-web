import type { AssistantTurnUsage, ChatLine, ChatPart, TokenUsageBreakdown } from "./components/shared";

export type ChatGroup =
  | { kind: "message"; message: ChatLine; index: number }
  | { kind: "tool-image"; message: ChatLine; index: number; toolName?: string }
  | { kind: "group"; messages: ChatLine[]; startIndex: number; endIndex: number };

export type FormalStageTokenBreakdown = TokenUsageBreakdown;

export interface MainTurnUsage {
  tokens: TokenUsageBreakdown;
  turns: number;
  partial: boolean;
}

export interface FormalStageChildUsage {
  key: string;
  role: string;
  tokens: FormalStageTokenBreakdown;
  hasUsage: boolean;
  partial: boolean;
  assistantTurns?: number;
  attempts: number;
  providerRetries: number;
}

export interface FormalStageUsage {
  children: FormalStageChildUsage[];
  tokens: FormalStageTokenBreakdown;
  hasUsage: boolean;
  partial: boolean;
  attempts: number;
  providerRetries: number;
}

export function groupChatMessages(messages: ChatLine[], indexOffset = 0): ChatGroup[] {
  const groups: ChatGroup[] = [];
  let eventMessages: ChatLine[] = [];
  let eventStartIndex = 0;

  const pushEvent = (message: ChatLine, index: number) => {
    if (!eventMessages.length) eventStartIndex = index;
    eventMessages.push(message);
  };
  const flushEvents = () => {
    if (!eventMessages.length) return;
    groups.push({ kind: "group", messages: eventMessages, startIndex: eventStartIndex, endIndex: eventStartIndex + eventMessages.length - 1 });
    eventMessages = [];
  };

  messages.forEach((message, index) => {
    const readableParts = message.parts.filter((part) => isReadablePart(message, part));
    const technicalParts = message.parts.filter((part) => !isReadablePart(message, part));

    const absoluteIndex = indexOffset + index;
    const metadata = { ...(message.source === undefined ? {} : { source: message.source }), ...(message.meta === undefined ? {} : { meta: message.meta }) };
    if (technicalParts.length) pushEvent({ role: message.role, parts: technicalParts, ...metadata }, absoluteIndex);
    if (readableParts.length) {
      flushEvents();
      const role = readableParts.every((part) => part.type === "skillRead") ? "skill" : message.role;
      const readableMessage = { role, parts: readableParts, ...metadata };
      if (isToolImageMessage(readableMessage)) {
        const toolName = toolNameFromParts(technicalParts);
        groups.push({ kind: "tool-image", message: readableMessage, index: absoluteIndex, ...(toolName === undefined ? {} : { toolName }) });
      } else {
        groups.push({ kind: "message", message: readableMessage, index: absoluteIndex });
      }
    }
  });
  flushEvents();
  return groups;
}

export function mainTurnUsage(messages: ChatLine[]): MainTurnUsage | undefined {
  const candidates = messages.filter((message) => message.meta?.turnUsage !== undefined
    && (message.parts.some(isToolEventPart) || message.meta.turnHasTools !== true));
  const turns = new Map<string, AssistantTurnUsage>();
  candidates.forEach((message, index) => {
    const usage = message.meta?.turnUsage;
    if (usage === undefined) return;
    const key = message.meta?.turnId ?? fallbackTurnKey(message, usage, index);
    const current = turns.get(key);
    if (current === undefined || turnUsageCompleteness(usage) > turnUsageCompleteness(current)) turns.set(key, usage);
  });
  if (turns.size === 0) return undefined;
  const rows = [...turns.values()];
  return {
    tokens: sumTokens(rows.map((row) => row.tokens)),
    turns: rows.length,
    partial: rows.some((row) => row.partial || row.tokens.total === undefined),
  };
}

export function formalStageUsage(messages: ChatLine[]): FormalStageUsage | undefined {
  const children = new Map<string, FormalStageChildUsage>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "toolExecution" && part.type !== "toolResult") continue;
      for (const evidence of formalEvidenceRecords(part.details)) {
        const usage = record(evidence["child_usage"]);
        if (usage === undefined) continue;
        const role = stringValue(evidence["role"]) ?? "formal child";
        const key = stringValue(evidence["child_session_id"]) ?? stringValue(evidence["dispatch_id"]) ?? `${role}:${String(children.size)}`;
        const parsed = parseChildUsage(key, role, evidence, usage);
        const current = children.get(key);
        if (current === undefined || usageCompleteness(parsed) >= usageCompleteness(current)) children.set(key, parsed);
      }
    }
  }
  if (children.size === 0) return undefined;
  const rows = [...children.values()];
  const hasUsage = rows.some((row) => row.hasUsage);
  return {
    children: rows,
    tokens: sumTokens(rows.filter((row) => row.hasUsage).map((row) => row.tokens)),
    hasUsage,
    partial: rows.some((row) => row.partial || !row.hasUsage),
    attempts: rows.reduce((sum, row) => sum + row.attempts, 0),
    providerRetries: rows.reduce((sum, row) => sum + row.providerRetries, 0),
  };
}

export function summarizeChatGroup(messages: ChatLine[]): string {
  if (messages.every((message) => message.source === "compaction")) return `${String(messages.length)} history compaction ${messages.length === 1 ? "summary" : "summaries"}`;
  if (messages.every((message) => message.source === "branch_summary")) return `${String(messages.length)} branch ${messages.length === 1 ? "summary" : "summaries"}`;
  const counts = messages.reduce<Record<string, number>>((acc, message) => {
    acc[message.role] = (acc[message.role] ?? 0) + 1;
    return acc;
  }, {});
  const details = Object.entries(counts).map(([role, count]) => `${String(count)} ${role}`).join(" · ");
  return `${String(messages.length)} ${messages.length === 1 ? "event" : "events"}${details !== "" ? ` · ${details}` : ""}`;
}

function formalEvidenceRecords(value: unknown): Record<string, unknown>[] {
  const root = record(value);
  if (root === undefined) return [];
  const records: Record<string, unknown>[] = [];
  const directEvidence = record(root["evidence"]);
  if (directEvidence !== undefined) records.push(directEvidence);
  if (record(root["child_usage"]) !== undefined) records.push(root);
  if (Array.isArray(root["results"])) {
    for (const result of root["results"]) {
      const item = record(result);
      if (item === undefined) continue;
      const evidence = record(item["evidence"]);
      if (evidence !== undefined) records.push(evidence);
      else if (record(item["child_usage"]) !== undefined) records.push(item);
    }
  }
  return records;
}

function parseChildUsage(key: string, role: string, evidence: Record<string, unknown>, usage: Record<string, unknown>): FormalStageChildUsage {
  const tokenRecord = record(usage["tokens"]) ?? usage;
  const hasUsage = usage["hasUsage"] === true || finiteNumber(tokenRecord["total"]) !== undefined || finiteNumber(tokenRecord["totalTokens"]) !== undefined;
  const modelAttempts = evidence["child_model_attempts"];
  const attempts = Array.isArray(modelAttempts)
    ? Math.max(1, modelAttempts.length)
    : Math.max(1, integerValue(usage["modelAttempts"]) ?? integerValue(usage["attempts"]) ?? 1);
  const providerRetries = integerValue(usage["providerRetries"])
    ?? (Array.isArray(modelAttempts)
      ? modelAttempts.filter((attempt) => record(attempt)?.["retryable_provider_failure"] === true).length
      : 0);
  const coverage = record(usage["coverage"]);
  const assistantTurns = integerValue(usage["assistantMessages"]);
  return {
    key,
    role,
    tokens: {
      ...numberProperty(tokenRecord, "input"),
      ...numberProperty(tokenRecord, "output"),
      ...numberAliasProperty(tokenRecord, "cacheRead", "cache_read"),
      ...numberAliasProperty(tokenRecord, "cacheWrite", "cache_write"),
      ...numberProperty(tokenRecord, "reasoning"),
      ...numberAliasProperty(tokenRecord, "total", "totalTokens"),
    },
    hasUsage,
    partial: evidence["timed_out"] === true || usage["partial"] === true || coverage?.["complete"] === false,
    ...(assistantTurns === undefined ? {} : { assistantTurns }),
    attempts,
    providerRetries,
  };
}

function sumTokens(tokens: FormalStageTokenBreakdown[]): FormalStageTokenBreakdown {
  const keys: (keyof FormalStageTokenBreakdown)[] = ["input", "output", "cacheRead", "cacheWrite", "reasoning", "total"];
  return Object.fromEntries(keys.flatMap((key) => {
    const values = tokens.map((item) => item[key]).filter((value): value is number => value !== undefined);
    return values.length === 0 ? [] : [[key, values.reduce((sum, value) => sum + value, 0)]];
  }));
}

function usageCompleteness(usage: FormalStageChildUsage): number {
  return (usage.hasUsage ? 100 : 0) + Object.values(usage.tokens).length + (usage.partial ? 0 : 10);
}

function isToolEventPart(part: ChatPart): boolean {
  return part.type === "toolCall" || part.type === "toolExecution" || part.type === "toolResult" || part.type === "skillRead";
}

function fallbackTurnKey(message: ChatLine, usage: AssistantTurnUsage, index: number): string {
  const timestamp = message.meta?.timestamp;
  const model = message.meta?.model;
  if (timestamp !== undefined) return `${timestamp}:${model?.provider ?? ""}:${model?.id ?? ""}:${String(usage.tokens.total ?? "unknown")}`;
  return `event:${String(index)}`;
}

function turnUsageCompleteness(usage: AssistantTurnUsage): number {
  return Object.values(usage.tokens).length + (usage.partial ? 0 : 10);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function integerValue(value: unknown): number | undefined {
  const parsed = finiteNumber(value);
  return parsed === undefined ? undefined : Math.floor(parsed);
}

function numberProperty(recordValue: Record<string, unknown>, key: keyof FormalStageTokenBreakdown): Partial<FormalStageTokenBreakdown> {
  const value = finiteNumber(recordValue[key]);
  return value === undefined ? {} : { [key]: value };
}

function numberAliasProperty(recordValue: Record<string, unknown>, key: keyof FormalStageTokenBreakdown, alias: string): Partial<FormalStageTokenBreakdown> {
  const value = finiteNumber(recordValue[key]) ?? finiteNumber(recordValue[alias]);
  return value === undefined ? {} : { [key]: value };
}

function isToolImageMessage(message: ChatLine): boolean {
  return message.role === "tool" && message.parts.length > 0 && message.parts.every((part) => part.type === "image");
}

function toolNameFromParts(parts: ChatPart[]): string | undefined {
  for (const part of parts) {
    if ((part.type === "toolCall" || part.type === "toolExecution" || part.type === "toolResult") && part.toolName !== "") return part.toolName;
  }
  return undefined;
}

function isReadablePart(message: ChatLine, part: ChatPart): boolean {
  if (message.source === "compaction" || message.source === "branch_summary") return false;
  if (part.type === "skillInvocation" || part.type === "skillRead" || part.type === "image" || part.type === "attachmentSummary" || part.type === "roundUsage") return true;
  return part.type === "text" && (message.role === "user" || message.role === "assistant" || message.role === "system" || message.role === "bash");
}
