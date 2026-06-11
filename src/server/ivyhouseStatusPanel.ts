import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { FastifyInstance } from "fastify";

export type GateAutoAnswerMode = "manual" | "semi-auto" | "autopilot";

type StatusKind = "ready" | "configured" | "failed" | "gated" | "disabled";

interface IvyhouseStatusPanelResponse {
  generatedAt: string;
  cwd: string;
  metrics: {
    totalInput?: number;
    totalOutput?: number;
    cacheRead?: number;
    cacheWrite?: number;
    totalCost?: number;
    totalReasoning?: number | null;
  };
  gateAutoAnswer: {
    mode: GateAutoAnswerMode;
    paused: boolean;
    permanent: boolean;
    scope: string;
  };
  plan: {
    items: { id: number; text: string; status: "pending" | "in_progress" | "completed" | "deleted" }[];
  };
  backgroundShells: { title: string; status: string }[];
  mcpServers: { name: string; status: StatusKind; disabled?: boolean }[];
  lspServers: { name: string; status: StatusKind }[];
  plugins: { name: string }[];
}

const STATE_DIR = join(homedir(), ".local", "share", "ivyhouse", "pi-sidebar");
const GATE_MODE_PATH = ".workflow-core/state/gate-autoanswer/mode-state.json";

type RecordValue = Record<string, unknown>;

export function registerIvyhouseStatusPanelRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: { cwd?: string } }>("/api/ivyhouse/status-panel", async (request, reply) => {
    try {
      return await buildStatusPanel(resolveCwd(request.query.cwd));
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Body: { cwd?: string } }>("/api/ivyhouse/gate-autoanswer/cycle", async (request, reply) => {
    try {
      const cwd = resolveCwd(request.body.cwd);
      const current = await readGateMode(cwd);
      const nextMode = nextGateMode(normalizeMode(current["mode"]));
      const next = {
        ...current,
        mode: nextMode,
        scope: typeof current["scope"] === "string" && current["scope"].trim() !== "" ? current["scope"] : "project",
        permanent: nextMode === "autopilot",
        paused: false,
        policy_version: Number.isInteger(current["policy_version"]) ? current["policy_version"] : 1,
      };
      await writeJson(join(cwd, GATE_MODE_PATH), next);
      return { gateAutoAnswer: normalizeGateMode(next), stateFile: join(cwd, GATE_MODE_PATH) };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}

async function buildStatusPanel(cwd: string): Promise<IvyhouseStatusPanelResponse> {
  const [gate, sidebarSnapshot, todoSnapshot, mcpServers, lspServers, plugins] = await Promise.all([
    readGateMode(cwd).then(normalizeGateMode),
    readSidebarSnapshot(cwd),
    readTodoSnapshot(cwd),
    readMcpServers(cwd),
    readLspServers(cwd),
    readPlugins(cwd),
  ]);

  const metrics: IvyhouseStatusPanelResponse["metrics"] = {};
  const totalInput = numberOrUndefined(sidebarSnapshot?.usage?.["input"]);
  const totalOutput = numberOrUndefined(sidebarSnapshot?.usage?.["output"]);
  const cacheRead = numberOrUndefined(sidebarSnapshot?.usage?.["cacheRead"]);
  const cacheWrite = numberOrUndefined(sidebarSnapshot?.usage?.["cacheWrite"]);
  const totalCost = numberOrUndefined(sidebarSnapshot?.usage?.["costTotal"]);
  if (totalInput !== undefined) metrics.totalInput = totalInput;
  if (totalOutput !== undefined) metrics.totalOutput = totalOutput;
  if (cacheRead !== undefined) metrics.cacheRead = cacheRead;
  if (cacheWrite !== undefined) metrics.cacheWrite = cacheWrite;
  if (totalCost !== undefined) metrics.totalCost = totalCost;
  metrics.totalReasoning = numberOrNull(sidebarSnapshot?.usage?.["reasoning"]);

  return {
    generatedAt: new Date().toISOString(),
    cwd,
    metrics,
    gateAutoAnswer: gate,
    plan: { items: todoSnapshot },
    backgroundShells: [],
    mcpServers,
    lspServers,
    plugins,
  };
}

function resolveCwd(cwd: string | undefined): string {
  const resolved = resolve(typeof cwd === "string" && cwd.trim() !== "" ? cwd : process.cwd());
  if (!existsSync(resolved)) throw new Error(`cwd does not exist: ${resolved}`);
  return resolved;
}

function cwdHash(cwd: string): string {
  return createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 16);
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null;
}

function normalizeMode(value: unknown): GateAutoAnswerMode {
  return value === "semi-auto" || value === "autopilot" ? value : "manual";
}

function nextGateMode(mode: GateAutoAnswerMode): GateAutoAnswerMode {
  if (mode === "manual") return "semi-auto";
  if (mode === "semi-auto") return "autopilot";
  return "manual";
}

async function readGateMode(cwd: string): Promise<RecordValue> {
  const parsed = await readJson(join(cwd, GATE_MODE_PATH));
  return isRecord(parsed) ? parsed : { mode: "manual", scope: "project", paused: false, permanent: false, policy_version: 1 };
}

function normalizeGateMode(raw: RecordValue): IvyhouseStatusPanelResponse["gateAutoAnswer"] {
  const mode = normalizeMode(raw["mode"]);
  const rawScope = raw["scope"];
  return {
    mode,
    paused: raw["paused"] === true,
    permanent: raw["permanent"] === true || mode === "autopilot",
    scope: typeof rawScope === "string" && rawScope.trim() !== "" ? rawScope : "project",
  };
}

async function readSidebarSnapshot(cwd: string): Promise<{ usage?: Record<string, unknown> } | undefined> {
  const parsed = await readJson(join(STATE_DIR, `sidebar-snapshot-${cwdHash(cwd)}.json`));
  if (!isRecord(parsed) || !isRecord(parsed["snapshot"])) return undefined;
  return isRecord(parsed["snapshot"]) ? parsed["snapshot"] : undefined;
}

async function readTodoSnapshot(cwd: string): Promise<IvyhouseStatusPanelResponse["plan"]["items"]> {
  const parsed = await readJson(join(STATE_DIR, `todo-state-${cwdHash(cwd)}.json`));
  if (!isRecord(parsed) || !Array.isArray(parsed["tasks"])) return [];
  return parsed["tasks"].flatMap((task) => {
    if (!isRecord(task)) return [];
    const id = typeof task["id"] === "number" ? task["id"] : Number(task["id"]);
    const status = typeof task["status"] === "string" ? task["status"] : "pending";
    const subject = typeof task["subject"] === "string" ? task["subject"] : typeof task["text"] === "string" ? task["text"] : "";
    if (!Number.isFinite(id) || subject.trim() === "") return [];
    if (status !== "pending" && status !== "in_progress" && status !== "completed" && status !== "deleted") return [];
    return [{ id, text: subject, status }];
  });
}

async function readMcpServers(cwd: string): Promise<IvyhouseStatusPanelResponse["mcpServers"]> {
  const parsed = await readJson(join(cwd, ".pi/mcp.json"));
  const mcpServers = isRecord(parsed) && isRecord(parsed["mcpServers"]) ? parsed["mcpServers"] : {};
  return Object.entries(mcpServers).map(([name, config]) => {
    const record = isRecord(config) ? config : {};
    const disabled = record["disabled"] === true;
    const policy = isRecord(record["ivyhousePolicy"]) ? record["ivyhousePolicy"] : {};
    const gated = policy["requiresExplicitOwnerApproval"] === true || policy["generalAgentAllowed"] === false || disabled;
    return { name, status: disabled ? "gated" : gated ? "configured" : "configured", ...(disabled ? { disabled: true } : {}) };
  });
}

async function readLspServers(cwd: string): Promise<IvyhouseStatusPanelResponse["lspServers"]> {
  const parsed = await readJson(join(cwd, ".pi/lsp.json"));
  const servers = isRecord(parsed) && isRecord(parsed["lsp"]) ? parsed["lsp"] : {};
  return Object.keys(servers).map((name) => ({ name, status: "configured" as const }));
}

async function readPlugins(cwd: string): Promise<IvyhouseStatusPanelResponse["plugins"]> {
  const names = new Set<string>();
  const settings = await readJson(join(cwd, ".pi/settings.json"));
  if (isRecord(settings) && Array.isArray(settings["packages"])) {
    for (const item of settings["packages"]) if (typeof item === "string" && item.trim() !== "") names.add(pluginDisplayName(item));
  }
  const extensionDir = join(cwd, ".pi/extensions");
  try {
    const entries = await readdir(extensionDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const maybePackage = join(extensionDir, entry.name, "package.json");
      const packageStat = await stat(maybePackage).catch(() => undefined);
      if (packageStat?.isFile() === true) names.add(entry.name);
    }
  } catch {
    // Optional extension list.
  }
  return [...names].sort((left, right) => left.localeCompare(right)).map((name) => ({ name }));
}

function pluginDisplayName(source: string): string {
  const normalized = source.replace(/^npm:/, "").replace(/^\.\//, "");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length >= 2 && typeof parts[0] === "string" && parts[0].startsWith("@") && typeof parts[1] === "string") return `${parts[0]}/${parts[1]}`;
  return parts.at(-1) ?? normalized;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
