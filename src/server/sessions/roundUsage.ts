import type { RoundChildUsage, RoundUsageSnapshot, UsageBreakdown, UsageTokens } from "../../shared/apiTypes.js";

export interface SessionStatsLike {
  sessionId: string;
  tokens: UsageTokens;
  cost: number;
}

export interface ActiveRoundUsage {
  roundId: string;
  sessionId: string;
  startedAt: string;
  start: UsageBreakdown;
  children: RoundChildUsage[];
}

export function usageBreakdownFromStats(stats: Pick<SessionStatsLike, "tokens" | "cost">): UsageBreakdown {
  return {
    tokens: normalizeTokens(stats.tokens),
    cost: finiteNumber(stats.cost),
  };
}

export function diffUsage(end: UsageBreakdown, start: UsageBreakdown): UsageBreakdown {
  return {
    tokens: {
      input: positiveDelta(end.tokens.input, start.tokens.input),
      output: positiveDelta(end.tokens.output, start.tokens.output),
      cacheRead: positiveDelta(end.tokens.cacheRead, start.tokens.cacheRead),
      cacheWrite: positiveDelta(end.tokens.cacheWrite, start.tokens.cacheWrite),
      total: positiveDelta(end.tokens.total, start.tokens.total),
    },
    cost: positiveDelta(end.cost, start.cost),
  };
}

export function addUsage(items: readonly UsageBreakdown[]): UsageBreakdown {
  return items.reduce<UsageBreakdown>((total, item) => ({
    tokens: {
      input: total.tokens.input + item.tokens.input,
      output: total.tokens.output + item.tokens.output,
      cacheRead: total.tokens.cacheRead + item.tokens.cacheRead,
      cacheWrite: total.tokens.cacheWrite + item.tokens.cacheWrite,
      total: total.tokens.total + item.tokens.total,
    },
    cost: total.cost + item.cost,
  }), zeroUsage());
}

export function zeroUsage(): UsageBreakdown {
  return { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 };
}

export function buildRoundUsageSnapshot(input: {
  round: ActiveRoundUsage;
  end: UsageBreakdown;
  status: RoundUsageSnapshot["status"];
  childUsagePending?: boolean;
}): RoundUsageSnapshot {
  const parent = diffUsage(input.end, input.round.start);
  const child = addUsage(input.round.children);
  const total = addUsage([parent, child]);
  return {
    roundId: input.round.roundId,
    sessionId: input.round.sessionId,
    status: input.status,
    parent,
    child,
    total,
    childRuns: input.round.children.length,
    childUsagePending: input.childUsagePending ?? false,
    children: input.round.children,
  };
}

export function extractChildUsageFromToolResult(result: unknown): RoundChildUsage | undefined {
  const evidence = findEvidence(result);
  if (evidence === undefined) return undefined;
  const rawUsage = getRecord(evidence, "child_usage") ?? getRecord(evidence, "usage");
  if (rawUsage === undefined) return undefined;
  const tokens = normalizeTokens(getRecord(rawUsage, "tokens") ?? rawUsage);
  const cost = finiteNumber(getNumber(rawUsage, "cost") ?? getNumber(getRecord(rawUsage, "cost"), "total"));
  const hasUsage = getBoolean(rawUsage, "hasUsage") ?? getBoolean(rawUsage, "has_usage") ?? hasNonZeroUsage(tokens, cost);
  const role = getString(evidence, "role");
  const childSessionId = getString(evidence, "child_session_id");
  const summaryPath = getString(evidence, "child_usage_path");
  const evidencePath = getString(evidence, "summary_path");
  return {
    tokens,
    cost,
    hasUsage,
    ...(role === undefined ? {} : { role }),
    ...(childSessionId === undefined ? {} : { childSessionId }),
    ...(summaryPath === undefined ? {} : { summaryPath }),
    ...(evidencePath === undefined ? {} : { evidencePath }),
  };
}

function findEvidence(value: unknown): Record<string, unknown> | undefined {
  const direct = asRecord(value);
  if (direct === undefined) return undefined;
  const details = getRecord(direct, "details");
  const directEvidence = getRecord(direct, "evidence");
  const detailsEvidence = details === undefined ? undefined : getRecord(details, "evidence");
  return detailsEvidence ?? directEvidence ?? (getString(direct, "launcher") === "ivyhouse-formal-role-launcher" ? direct : undefined);
}

function normalizeTokens(value: unknown): UsageTokens {
  const record = asRecord(value);
  const input = finiteNumber(getNumber(record, "input"));
  const output = finiteNumber(getNumber(record, "output"));
  const cacheRead = finiteNumber(getNumber(record, "cacheRead"));
  const cacheWrite = finiteNumber(getNumber(record, "cacheWrite"));
  const explicitTotal = getNumber(record, "total") ?? getNumber(record, "totalTokens");
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: finiteNumber(explicitTotal ?? input + output + cacheRead + cacheWrite),
  };
}

function positiveDelta(end: number, start: number): number {
  return Math.max(0, finiteNumber(end) - finiteNumber(start));
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function hasNonZeroUsage(tokens: UsageTokens, cost: number): boolean {
  return tokens.input > 0 || tokens.output > 0 || tokens.cacheRead > 0 || tokens.cacheWrite > 0 || tokens.total > 0 || cost > 0;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value)) : undefined;
}

function getRecord(value: unknown, key: string): Record<string, unknown> | undefined {
  const record = asRecord(value);
  return record === undefined ? undefined : asRecord(record[key]);
}

function getString(value: unknown, key: string): string | undefined {
  const record = asRecord(value);
  const item = record?.[key];
  return typeof item === "string" && item !== "" ? item : undefined;
}

function getNumber(value: unknown, key: string): number | undefined {
  const record = asRecord(value);
  const item = record?.[key];
  return typeof item === "number" && Number.isFinite(item) ? item : undefined;
}

function getBoolean(value: unknown, key: string): boolean | undefined {
  const record = asRecord(value);
  const item = record?.[key];
  return typeof item === "boolean" ? item : undefined;
}
