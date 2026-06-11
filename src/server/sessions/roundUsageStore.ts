import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { piWebDataDir } from "../../config.js";
import type { RoundChildUsage, RoundUsageSnapshot, UsageBreakdown } from "../../shared/apiTypes.js";

interface StoredRoundUsage {
  messageId: string;
  usage: RoundUsageSnapshot;
}

export class RoundUsageStore {
  constructor(private readonly dataDir = piWebDataDir()) {}

  async getByMessageId(sessionId: string): Promise<Map<string, RoundUsageSnapshot>> {
    const entries = await this.read(sessionId);
    return new Map(entries.map((entry) => [entry.messageId, entry.usage]));
  }

  async upsert(sessionId: string, messageId: string | undefined, usage: RoundUsageSnapshot): Promise<void> {
    if (messageId === undefined || messageId === "") return;
    const entries = await this.read(sessionId);
    const next = [...entries.filter((entry) => entry.messageId !== messageId), { messageId, usage: { ...usage, assistantMessageId: messageId } }];
    const path = this.path(sessionId);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(next.slice(-200), null, 2) + "\n", "utf8");
  }

  private async read(sessionId: string): Promise<StoredRoundUsage[]> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path(sessionId), "utf8"));
      if (!Array.isArray(parsed)) return [];
      return parsed.flatMap((entry): StoredRoundUsage[] => {
        const messageId = getString(entry, "messageId");
        const usage = normalizeRoundUsage(getRecord(entry, "usage"));
        return messageId === undefined || usage === undefined ? [] : [{ messageId, usage }];
      });
    } catch (error) {
      return isNotFound(error) ? [] : [];
    }
  }

  private path(sessionId: string): string {
    return join(this.dataDir, "round-usage", `${sanitizeSessionId(sessionId)}.json`);
  }
}

function normalizeRoundUsage(value: Record<string, unknown> | undefined): RoundUsageSnapshot | undefined {
  if (value === undefined) return undefined;
  const roundId = getString(value, "roundId");
  const sessionId = getString(value, "sessionId");
  const statusValue = getString(value, "status");
  const status = statusValue === "partial" || statusValue === "complete" ? statusValue : undefined;
  const parent = usageBreakdownValue(getRecord(value, "parent"));
  const child = usageBreakdownValue(getRecord(value, "child"));
  const total = usageBreakdownValue(getRecord(value, "total"));
  if (roundId === undefined || sessionId === undefined || status === undefined || parent === undefined || child === undefined || total === undefined) return undefined;
  const assistantMessageId = getString(value, "assistantMessageId");
  return {
    roundId,
    sessionId,
    ...(assistantMessageId === undefined ? {} : { assistantMessageId }),
    status,
    parent,
    child,
    total,
    childRuns: getNumber(value, "childRuns"),
    childUsagePending: getBoolean(value, "childUsagePending") ?? false,
    children: normalizeChildren(getProperty(value, "children")),
  };
}

function normalizeChildren(value: unknown): RoundChildUsage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): RoundChildUsage[] => {
    const record = asRecord(entry);
    const breakdown = usageBreakdownValue(record);
    if (record === undefined || breakdown === undefined) return [];
    const role = getString(record, "role");
    const childSessionId = getString(record, "childSessionId");
    const summaryPath = getString(record, "summaryPath");
    const evidencePath = getString(record, "evidencePath");
    return [{
      ...breakdown,
      hasUsage: getBoolean(record, "hasUsage") ?? false,
      ...(role === undefined ? {} : { role }),
      ...(childSessionId === undefined ? {} : { childSessionId }),
      ...(summaryPath === undefined ? {} : { summaryPath }),
      ...(evidencePath === undefined ? {} : { evidencePath }),
    }];
  });
}

function usageBreakdownValue(value: unknown): UsageBreakdown | undefined {
  const tokens = getRecord(value, "tokens");
  if (tokens === undefined) return undefined;
  return {
    tokens: {
      input: getNumber(tokens, "input"),
      output: getNumber(tokens, "output"),
      cacheRead: getNumber(tokens, "cacheRead"),
      cacheWrite: getNumber(tokens, "cacheWrite"),
      total: getNumber(tokens, "total"),
    },
    cost: getNumber(value, "cost"),
  };
}

function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value)) : undefined;
}

function getProperty(value: unknown, key: string): unknown {
  return asRecord(value)?.[key];
}

function getRecord(value: unknown, key: string): Record<string, unknown> | undefined {
  return asRecord(getProperty(value, key));
}

function getString(value: unknown, key: string): string | undefined {
  const item = getProperty(value, key);
  return typeof item === "string" && item !== "" ? item : undefined;
}

function getNumber(value: unknown, key: string): number {
  const item = getProperty(value, key);
  return typeof item === "number" && Number.isFinite(item) ? item : 0;
}

function getBoolean(value: unknown, key: string): boolean | undefined {
  const item = getProperty(value, key);
  return typeof item === "boolean" ? item : undefined;
}

function isNotFound(error: unknown): boolean {
  return getString(error, "code") === "ENOENT";
}
