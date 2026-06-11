import { describe, expect, it } from "vitest";
import { buildRoundUsageSnapshot, extractChildUsageFromToolResult, usageBreakdownFromStats } from "./roundUsage";

describe("round usage aggregation", () => {
  it("builds parent and child totals from cumulative snapshots", () => {
    const round = {
      roundId: "round-1",
      sessionId: "session-1",
      startedAt: "2026-06-11T00:00:00.000Z",
      start: usageBreakdownFromStats({ tokens: { input: 100, output: 50, cacheRead: 20, cacheWrite: 0, total: 170 }, cost: 0.01 }),
      children: [{ role: "qa-reviewer", tokens: { input: 30, output: 10, cacheRead: 5, cacheWrite: 0, total: 45 }, cost: 0.02, hasUsage: true }],
    };

    expect(buildRoundUsageSnapshot({
      round,
      end: usageBreakdownFromStats({ tokens: { input: 175, output: 80, cacheRead: 45, cacheWrite: 0, total: 300 }, cost: 0.04 }),
      status: "complete",
    })).toMatchObject({
      parent: { tokens: { input: 75, output: 30, cacheRead: 25, cacheWrite: 0, total: 130 }, cost: 0.03 },
      child: { tokens: { input: 30, output: 10, cacheRead: 5, cacheWrite: 0, total: 45 }, cost: 0.02 },
      total: { tokens: { input: 105, output: 40, cacheRead: 30, cacheWrite: 0, total: 175 }, cost: 0.05 },
      childRuns: 1,
    });
  });

  it("extracts formal child usage from tool result details", () => {
    expect(extractChildUsageFromToolResult({
      details: {
        evidence: {
          launcher: "ivyhouse-formal-role-launcher",
          role: "security-reviewer",
          child_session_id: "child-1",
          child_usage_path: "usage.json",
          summary_path: "summary.json",
          child_usage: {
            tokens: { input: 1000, output: 200, cacheRead: 800, cacheWrite: 0, total: 2000 },
            cost: 0.12,
            hasUsage: true,
          },
        },
      },
    })).toEqual({
      role: "security-reviewer",
      childSessionId: "child-1",
      summaryPath: "usage.json",
      evidencePath: "summary.json",
      tokens: { input: 1000, output: 200, cacheRead: 800, cacheWrite: 0, total: 2000 },
      cost: 0.12,
      hasUsage: true,
    });
  });
});
