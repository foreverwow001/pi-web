import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { SessionDaemonClient } from "../sessiond/sessionDaemonClient.js";
import type { SessionProxyDaemon } from "./sessiond/sessionProxyRoutes.js";

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
const READINESS_TTL_MS = 30_000;
const READINESS_TIMEOUT_MS = 8_000;

type RecordValue = Record<string, unknown>;
interface CachedReadiness {
  expiresAt: number;
  status: StatusKind;
}

const readinessCache = new Map<string, CachedReadiness>();

export function registerIvyhouseStatusPanelRoutes(app: FastifyInstance, daemon: SessionProxyDaemon = new SessionDaemonClient()): void {
  app.get<{ Querystring: { cwd?: string } }>("/api/ivyhouse/status-panel", async (request, reply) => {
    try {
      return await buildStatusPanel(resolveCwd(request.query.cwd), daemon);
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

async function buildStatusPanel(cwd: string, daemon: SessionProxyDaemon): Promise<IvyhouseStatusPanelResponse> {
  const [gate, sidebarSnapshot, todoSnapshot, mcpServers, lspServers, plugins, backgroundShells] = await Promise.all([
    readGateMode(cwd).then(normalizeGateMode),
    readSidebarSnapshot(cwd),
    readTodoSnapshot(cwd),
    readMcpServers(cwd),
    readLspServers(cwd),
    readPlugins(cwd),
    readBackgroundShells(cwd, daemon),
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
    backgroundShells,
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
  const exactPath = join(STATE_DIR, `todo-state-${cwdHash(cwd)}.json`);
  if (existsSync(exactPath)) return parseTodoItems(await readJson(exactPath));
  if (!await hasActiveSessionForCwd(cwd)) return [];
  const fallback = await readLatestTodoSnapshot();
  return parseTodoItems(fallback);
}

function parseTodoItems(parsed: unknown): IvyhouseStatusPanelResponse["plan"]["items"] {
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

async function hasActiveSessionForCwd(cwd: string): Promise<boolean> {
  const parsed = await readJson(join(STATE_DIR, `active-session-${cwdHash(cwd)}.json`));
  return isRecord(parsed) && parsed["cwd"] === cwd;
}

async function readLatestTodoSnapshot(): Promise<unknown> {
  try {
    let latest: { path: string; updatedAt: number } | undefined;
    for (const entry of await readdir(STATE_DIR)) {
      if (!entry.startsWith("todo-state-") || !entry.endsWith(".json")) continue;
      const path = join(STATE_DIR, entry);
      const parsed = await readJson(path);
      const updatedAt = isRecord(parsed) && typeof parsed["updatedAt"] === "number" ? parsed["updatedAt"] : (await stat(path)).mtimeMs;
      if (latest === undefined || updatedAt > latest.updatedAt) latest = { path, updatedAt };
    }
    return latest === undefined ? undefined : await readJson(latest.path);
  } catch {
    return undefined;
  }
}

async function readMcpServers(cwd: string): Promise<IvyhouseStatusPanelResponse["mcpServers"]> {
  const parsed = await readJson(join(cwd, ".pi/mcp.json"));
  const mcpServers = isRecord(parsed) && isRecord(parsed["mcpServers"]) ? parsed["mcpServers"] : {};
  return await Promise.all(Object.entries(mcpServers).map(async ([name, config]) => {
    const record = isRecord(config) ? config : {};
    const disabled = record["disabled"] === true;
    const policy = isRecord(record["ivyhousePolicy"]) ? record["ivyhousePolicy"] : {};
    const gated = policy["requiresExplicitOwnerApproval"] === true || policy["generalAgentAllowed"] === false || disabled;
    if (disabled || gated) return { name, status: "gated" as const, ...(disabled ? { disabled: true } : {}) };
    return { name, status: await checkMcpReadiness(cwd, name, record) };
  }));
}

async function readLspServers(cwd: string): Promise<IvyhouseStatusPanelResponse["lspServers"]> {
  const parsed = await readJson(join(cwd, ".pi/lsp.json"));
  const servers = isRecord(parsed) && isRecord(parsed["lsp"]) ? parsed["lsp"] : {};
  return await Promise.all(Object.entries(servers).map(async ([name, config]) => {
    const record = isRecord(config) ? config : {};
    const command = Array.isArray(record["command"]) && typeof record["command"][0] === "string" ? record["command"][0] : undefined;
    return { name, status: command === undefined ? "failed" as const : await checkExecutableReadiness(cwd, `lsp:${name}:${command}`, command) };
  }));
}

async function checkMcpReadiness(cwd: string, name: string, config: RecordValue): Promise<StatusKind> {
  const type = typeof config["type"] === "string" ? config["type"] : "stdio";
  if (type === "http") {
    const url = typeof config["url"] === "string" ? config["url"] : undefined;
    if (url === undefined || url.trim() === "") return "failed";
    const headers = resolveHeaders(config["headers"]);
    if (headers === undefined) return "failed";
    return await cachedReadiness(`mcp:http:${name}:${url}`, async () => await probeHttpMcp(url, headers));
  }
  const command = typeof config["command"] === "string" ? config["command"] : undefined;
  return command === undefined ? "failed" : await checkExecutableReadiness(cwd, `mcp:stdio:${name}:${command}`, command);
}

async function probeHttpMcp(url: string, headers: Record<string, string>): Promise<StatusKind> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "accept": "application/json, text/event-stream",
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "ivyhouse-pi-web-status", version: "1" } } }),
      signal: AbortSignal.timeout(READINESS_TIMEOUT_MS),
    });
    return response.status >= 200 && response.status < 300 ? "ready" : "failed";
  } catch {
    return "failed";
  }
}

function resolveHeaders(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return {};
  const headers: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== "string") return undefined;
    const resolved = raw.replace(/\$\{([A-Z0-9_]+)\}/gu, (_match, envName: string) => process.env[envName] ?? "");
    if (resolved.includes("${") || resolved.trim() === "Bearer") return undefined;
    headers[key] = resolved;
  }
  return headers;
}

async function checkExecutableReadiness(cwd: string, key: string, command: string): Promise<StatusKind> {
  return await cachedReadiness(key, async () => await execFileOk("bash", ["-lc", `command -v ${shellQuote(command)} >/dev/null`], {
    cwd,
    env: { ...process.env, PATH: `${join(cwd, ".pi", "node_modules", ".bin")}:${process.env["PATH"] ?? ""}` },
  }) ? "ready" : "failed");
}

async function cachedReadiness(key: string, probe: () => Promise<StatusKind>): Promise<StatusKind> {
  const cached = readinessCache.get(key);
  if (cached !== undefined && cached.expiresAt > Date.now()) return cached.status;
  const status = await probe();
  readinessCache.set(key, { status, expiresAt: Date.now() + READINESS_TTL_MS });
  return status;
}

function execFileOk(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<boolean> {
  return new Promise((resolveOk) => {
    execFile(command, args, { ...options, timeout: READINESS_TIMEOUT_MS }, (error) => { resolveOk(error === null); });
  });
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'"'"'`)}'`;
}

async function readBackgroundShells(cwd: string, daemon: SessionProxyDaemon): Promise<IvyhouseStatusPanelResponse["backgroundShells"]> {
  try {
    const [terminalsResponse, runsResponse] = await Promise.all([
      daemon.request("GET", `/terminals?cwd=${encodeURIComponent(cwd)}`),
      daemon.request("GET", "/terminal-command-runs?statuses=queued,running"),
    ]);
    const terminals = parseRecords(terminalsResponse.body).filter((terminal) => terminal["exited"] !== true);
    const runs = new Map(parseRecords(runsResponse.body).map((run) => [typeof run["terminalId"] === "string" ? run["terminalId"] : "", run]));
    return terminals.flatMap((terminal) => {
      const id = typeof terminal["id"] === "string" ? terminal["id"] : "";
      const title = typeof terminal["name"] === "string" && terminal["name"].trim() !== "" ? terminal["name"] : "Shell";
      const run = runs.get(id);
      const status = run !== undefined && typeof run["status"] === "string" ? run["status"] : terminal["commandRunId"] === undefined ? "interactive" : "running";
      if (id === "") return [];
      return [{ title, status }];
    }).slice(0, 20);
  } catch {
    return [];
  }
}

function parseRecords(body: string): RecordValue[] {
  if (body === "") return [];
  const parsed: unknown = JSON.parse(body);
  return Array.isArray(parsed) ? parsed.filter(isRecord) : [];
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
