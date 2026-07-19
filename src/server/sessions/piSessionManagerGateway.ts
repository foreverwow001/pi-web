import type { Dirent } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { canonicalizeStoredCwd, cwdPathsEqual } from "../workingDirectory.js";
import type { PiSessionListEntry, PiSessionManager, PiSessionManagerGateway } from "./piSessionService.js";

type SessionDirSource = "env" | "settings" | "pi-default";

export interface SessionDirResolution {
  source: SessionDirSource;
  sessionDir: string;
  usesConfiguredSessionDir: boolean;
}

export interface SessionDirResolverOptions {
  agentDir: string;
  env: Readonly<NodeJS.ProcessEnv>;
  sessionDirEnvKeys: readonly string[];
}

export class SessionDirResolver {
  private readonly agentDir: string;
  private readonly envSessionDir: string | undefined;
  private readonly homeDir: string;

  constructor(options: SessionDirResolverOptions) {
    this.agentDir = options.agentDir;
    this.envSessionDir = options.sessionDirEnvKeys
      .map((key) => options.env[key])
      .find((value) => value !== undefined && value !== "");
    const configuredHome = options.env["HOME"];
    this.homeDir = configuredHome !== undefined && configuredHome !== "" && isAbsolute(configuredHome) ? configuredHome : homedir();
  }

  defaultSessionsRoot(): string {
    return defaultPiSessionsRoot(this.agentDir);
  }

  globalEnvSessionDir(): string | undefined {
    if (this.envSessionDir === undefined) return undefined;
    const expanded = expandTildePath(this.envSessionDir, this.homeDir);
    return isAbsolute(expanded) ? expanded : undefined;
  }

  resolve(cwd: string): SessionDirResolution {
    if (this.envSessionDir !== undefined) {
      return { source: "env", sessionDir: resolveConfiguredPath(this.envSessionDir, cwd, this.homeDir), usesConfiguredSessionDir: true };
    }

    const settingsSessionDir = SettingsManager.create(cwd, this.agentDir).getSessionDir();
    if (settingsSessionDir !== undefined && settingsSessionDir !== "") {
      return { source: "settings", sessionDir: resolveConfiguredPath(settingsSessionDir, cwd, this.homeDir), usesConfiguredSessionDir: true };
    }

    return { source: "pi-default", sessionDir: defaultPiSessionDir(cwd, this.agentDir), usesConfiguredSessionDir: false };
  }
}

export type PiSessionManagerGatewayOptions = SessionDirResolverOptions;

export function createPiSessionManagerGateway(options: PiSessionManagerGatewayOptions): PiSessionManagerGateway {
  return new SettingsAwarePiSessionManagerGateway(new SessionDirResolver(options));
}

class SettingsAwarePiSessionManagerGateway implements PiSessionManagerGateway {
  constructor(private readonly resolver: SessionDirResolver) {}

  async list(cwd: string): Promise<PiSessionListEntry[]> {
    const resolution = this.resolver.resolve(cwd);
    return filterSessionsForCwd(await listSessionsInDir(resolution.sessionDir), cwd);
  }

  create(cwd: string, options?: { parentSession?: string }): PiSessionManager {
    const resolution = this.resolver.resolve(cwd);
    return SessionManager.create(cwd, resolution.sessionDir, options?.parentSession === undefined ? undefined : { parentSession: options.parentSession });
  }

  async listAll(): Promise<PiSessionListEntry[]> {
    const envSessionDir = this.resolver.globalEnvSessionDir();
    const [defaultSessions, envSessions] = await Promise.all([
      listSessionsInDefaultPiStore(this.resolver.defaultSessionsRoot()),
      envSessionDir === undefined ? Promise.resolve([]) : listSessionsInDir(envSessionDir),
    ]);
    return uniqueSessionsByPath([...defaultSessions, ...envSessions]);
  }

  open(path: string): PiSessionManager {
    return SessionManager.open(path, dirname(path));
  }
}

export async function listSessionsInDir(sessionDir: string): Promise<PiSessionListEntry[]> {
  // listAll(sessionDir) lists without the SDK's internal cwd filter, which would
  // otherwise compare against this process's cwd and drop other projects' sessions.
  // Cwd filtering is applied explicitly by filterSessionsForCwd where needed.
  // Session file headers are written by external tools (Pi CLI, SDK consumers),
  // so their cwd is canonicalized here before it enters pi-web.
  const sdkSessions = await SessionManager.listAll(sessionDir);
  if (sdkSessions.length > 0) return sdkSessions.map((session) => ({ ...session, cwd: canonicalizeStoredCwd(session.cwd) }));
  return listSessionsInDirFromJsonl(sessionDir);
}

async function listSessionsInDirFromJsonl(sessionDir: string): Promise<PiSessionListEntry[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(sessionDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const sessions = await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map(async (entry) => sessionEntryFromJsonl(join(sessionDir, entry.name))));
  return sessions
    .filter((entry): entry is PiSessionListEntry => entry !== undefined)
    .sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

async function sessionEntryFromJsonl(path: string): Promise<PiSessionListEntry | undefined> {
  try {
    const [fileStat, content] = await Promise.all([stat(path), readFile(path, "utf8")]);
    const lines = content.split(/\r?\n/u).filter((line) => line.trim() !== "");
    let id = sessionIdFromFilePath(path);
    let cwd = "";
    let firstMessage = "";
    let name: string | undefined;
    for (const line of lines) {
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { continue; }
      if (!isRecord(parsed)) continue;
      const record = parsed;
      if (record["type"] === "session") {
        if (typeof record["id"] === "string" && record["id"] !== "") id = record["id"];
        if (typeof record["cwd"] === "string" && record["cwd"] !== "") cwd = canonicalizeStoredCwd(record["cwd"]);
        if (typeof record["name"] === "string" && record["name"] !== "") name = record["name"];
      }
      const message = isRecord(record["message"]) ? record["message"] : undefined;
      if (firstMessage === "" && message?.["role"] === "user") firstMessage = messageContentText(message["content"]);
      if (firstMessage === "" && record["role"] === "user") firstMessage = messageContentText(record["content"]);
    }
    if (id === "" || cwd === "") return undefined;
    return { id, path, cwd, created: fileStat.birthtime, modified: fileStat.mtime, messageCount: lines.length, firstMessage, allMessagesText: content, ...(name === undefined ? {} : { name }) };
  } catch {
    return undefined;
  }
}

export async function listSessionsInDefaultPiStore(storeRoot: string): Promise<PiSessionListEntry[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(storeRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const sessionDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => join(storeRoot, entry.name));
  const sessions = (await Promise.all(sessionDirs.map((dir) => listSessionsInDir(dir)))).flat();
  return sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

export function filterSessionsForCwd(sessions: readonly PiSessionListEntry[], cwd: string): PiSessionListEntry[] {
  // Sessions with an empty cwd (old session files) are excluded: resolve("") would
  // resolve to this process's cwd and produce false matches.
  return sessions.filter((session) => session.cwd !== "" && cwdPathsEqual(session.cwd, cwd));
}

function uniqueSessionsByPath(sessions: readonly PiSessionListEntry[]): PiSessionListEntry[] {
  const byPath = new Map<string, PiSessionListEntry>();
  for (const session of sessions) byPath.set(session.path, session);
  return [...byPath.values()].sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

export function defaultPiSessionsRoot(agentDir: string): string {
  return join(agentDir, "sessions");
}

export function defaultPiSessionDir(cwd: string, agentDir: string): string {
  return sessionDirInDefaultPiStore(defaultPiSessionsRoot(agentDir), cwd);
}

export function sessionDirInDefaultPiStore(storeRoot: string, cwd: string): string {
  const safePath = `--${cwd.replace(/^[/\\]/u, "").replace(/[/\\:]/gu, "-")}--`;
  return join(storeRoot, safePath);
}

export function resolveConfiguredPath(path: string, cwd: string, homeDir: string): string {
  const expanded = expandTildePath(path, homeDir);
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

function expandTildePath(path: string, homeDir: string): string {
  if (path === "~") return homeDir;
  if (path.startsWith("~/")) return join(homeDir, path.slice(2));
  return path;
}

function sessionIdFromFilePath(path: string): string {
  const fileName = path.split(/[/\\]/u).pop()?.replace(/\.jsonl$/u, "") ?? "";
  const separator = fileName.lastIndexOf("_");
  return separator >= 0 ? fileName.slice(separator + 1) : fileName;
}

function messageContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => isRecord(part) && part["type"] === "text" && typeof part["text"] === "string" ? part["text"] : "")
    .filter((text) => text !== "")
    .join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
