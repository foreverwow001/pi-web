import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { SessionDaemonClient } from "../sessiond/sessionDaemonClient.js";
import type { SessionProxyDaemon } from "./sessiond/sessionProxyRoutes.js";

export type GateAutoAnswerMode = "manual" | "semi-auto" | "autopilot";
export type IvyhouseFooterMode = "default" | "build" | "plan";
export type IvyhouseFastOverride = "auto" | "on" | "off";

type StatusKind = "ready" | "configured" | "failed" | "gated" | "disabled";

interface IvyhouseFooterControlsResponse {
  cwd: string;
  mode: IvyhouseFooterMode;
  fastOverride: IvyhouseFastOverride;
  fastEnabled: boolean;
  stateFile: string;
}

interface IvyhouseStatusPanelResponse {
  generatedAt: string;
  cwd: string;
  sessionId?: string;
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
const FOOTER_CONTROLS_STATE_DIR = join(homedir(), ".local", "share", "ivyhouse", "pi-footer-controls");
const GATE_MODE_PATH = ".workflow-core/state/gate-autoanswer/mode-state.json";
const OPENAI_FAST_CONFIG_PATH = ".pi/openai-fast.json";
const READINESS_TTL_MS = 30_000;
const READINESS_TIMEOUT_MS = 8_000;

type RecordValue = Record<string, unknown>;
interface CachedReadiness {
  expiresAt: number;
  status: StatusKind;
}

const readinessCache = new Map<string, CachedReadiness>();

export function registerIvyhouseStatusPanelRoutes(app: FastifyInstance, daemon: SessionProxyDaemon = new SessionDaemonClient()): void {
  app.get<{ Querystring: { cwd?: string; sessionId?: string } }>("/api/ivyhouse/status-panel", async (request, reply) => {
    try {
      return await buildStatusPanel(resolveCwd(request.query.cwd), normalizeSessionId(request.query.sessionId), daemon);
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

  app.get<{ Querystring: { cwd?: string } }>("/api/ivyhouse/footer-controls", async (request, reply) => {
    try {
      return await readFooterControls(resolveCwd(request.query.cwd));
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Body: { cwd?: string; mode?: unknown } }>("/api/ivyhouse/footer-controls/mode", async (request, reply) => {
    try {
      const cwd = resolveCwd(request.body.cwd);
      const mode = normalizeFooterMode(request.body.mode);
      await writeFooterControls(cwd, { agent: mode });
      return await readFooterControls(cwd);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Body: { cwd?: string } }>("/api/ivyhouse/footer-controls/fast/toggle", async (request, reply) => {
    try {
      const cwd = resolveCwd(request.body.cwd);
      const current = await readFooterControlsState(cwd);
      const enabled = footerFastEnabled(cwd, normalizeFastOverride(current["fastOverride"]));
      await writeFooterControls(cwd, { fastOverride: enabled ? "off" : "on" });
      return await readFooterControls(cwd);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}

async function buildStatusPanel(cwd: string, sessionId: string | undefined, daemon: SessionProxyDaemon): Promise<IvyhouseStatusPanelResponse> {
  const [gate, sidebarSnapshot, todoSnapshot, mcpServers, lspServers, plugins, backgroundShells] = await Promise.all([
    readGateMode(cwd).then(normalizeGateMode),
    readSidebarSnapshot(cwd),
    readTodoSnapshot(cwd, sessionId),
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
    ...(sessionId === undefined ? {} : { sessionId }),
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

function sessionHash(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
}

function normalizeSessionId(sessionId: string | undefined): string | undefined {
  const normalized = typeof sessionId === "string" ? sessionId.trim() : "";
  return normalized.length > 0 && normalized.length <= 256 ? normalized : undefined;
}

function footerControlsStatePath(cwd: string): string {
  return join(FOOTER_CONTROLS_STATE_DIR, `state-${cwdHash(cwd)}.json`);
}

async function readFooterControls(cwd: string): Promise<IvyhouseFooterControlsResponse> {
  const state = await readFooterControlsState(cwd);
  const mode = normalizeFooterMode(state["agent"]);
  const fastOverride = normalizeFastOverride(state["fastOverride"]);
  return {
    cwd,
    mode,
    fastOverride,
    fastEnabled: footerFastEnabled(cwd, fastOverride),
    stateFile: footerControlsStatePath(cwd),
  };
}

async function readFooterControlsState(cwd: string): Promise<RecordValue> {
  const parsed = await readJson(footerControlsStatePath(cwd));
  return isRecord(parsed) ? parsed : { agent: "default", fastOverride: "auto" };
}

async function writeFooterControls(cwd: string, patch: RecordValue): Promise<void> {
  const next = { ...await readFooterControlsState(cwd), ...patch };
  await writeJson(footerControlsStatePath(cwd), next);
}

function normalizeFooterMode(value: unknown): IvyhouseFooterMode {
  if (value === "build" || value === "plan") return value;
  if (value === "default" || value === undefined || value === null) return "default";
  throw new Error("mode must be default, build, or plan");
}

function normalizeFastOverride(value: unknown): IvyhouseFastOverride {
  return value === "on" || value === "off" || value === "auto" ? value : "auto";
}

function footerFastEnabled(cwd: string, override: IvyhouseFastOverride): boolean {
  if (override === "on") return true;
  if (override === "off") return false;
  const config = readJsonSync(join(cwd, OPENAI_FAST_CONFIG_PATH));
  return isRecord(config) && config["enabled"] === true;
}

function readJsonSync(path: string): unknown {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
  } catch {
    return undefined;
  }
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

export function ivyhouseTodoSnapshotPath(cwd: string, sessionId: string, stateDir: string = STATE_DIR): string {
  return join(stateDir, `todo-state-${cwdHash(cwd)}-${sessionHash(sessionId)}.json`);
}

export async function readTodoSnapshot(cwd: string, sessionId: string | undefined, stateDir: string = STATE_DIR): Promise<IvyhouseStatusPanelResponse["plan"]["items"]> {
  if (sessionId === undefined) return [];
  const parsed = await readJson(ivyhouseTodoSnapshotPath(cwd, sessionId, stateDir));
  if (!isRecord(parsed) || parsed["sessionId"] !== sessionId || typeof parsed["cwd"] !== "string" || resolve(parsed["cwd"]) !== resolve(cwd)) return [];
  return parseTodoItems(parsed);
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
