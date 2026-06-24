import { afterEach, describe, expect, it, vi } from "vitest";
import { PI_WEB_CAPABILITIES } from "../../../shared/capabilities";
import type { TerminalCommandRun, Workspace } from "../../../shared/apiTypes";
import { filesApi, ivyhouseApi, machinesApi, piWebApi, sessionsApi, terminalsApi, workspacesApi } from "./clients";

const workspace: Workspace = {
  id: "w/1",
  projectId: "p 1",
  path: "/repo",
  label: "repo",
  isMain: true,
  isGitRepo: true,
  isGitWorktree: true,
};

const commandRun: TerminalCommandRun = {
  id: "run1",
  origin: "core",
  projectId: workspace.projectId,
  workspaceId: workspace.id,
  terminalId: "t1",
  title: "Build",
  command: "npm test",
  status: "running",
  createdAt: "2026-05-25T00:00:00.000Z",
  metadata: {},
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("machine-scoped runtime API", () => {
  it("reads machine PI WEB status through the gateway route", async () => {
    const fetchMock = stubJsonFetch({
      packageName: "@jmfederico/pi-web",
      generatedAt: "now",
      components: {
        web: { component: "web", label: "PI WEB", available: true, stale: false },
        sessiond: { component: "sessiond", label: "PI WEB Session Daemon", available: true, stale: false },
      },
      release: { packageName: "@jmfederico/pi-web", updateAvailable: false },
      commands: {},
      messages: [],
    });

    await piWebApi.piWebStatus("remote a");

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchCall(fetchMock, 0)[0]).toBe("/api/machines/remote%20a/pi-web/status");
  });

  it("reads machine runtime through the gateway route", async () => {
    const fetchMock = stubJsonFetch({ machineId: "remote a", ok: true, checkedAt: "now", capabilities: [PI_WEB_CAPABILITIES.sessionsDeleteArchived] });

    await machinesApi.runtime("remote a");

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchCall(fetchMock, 0)[0]).toBe("/api/machines/remote%20a/runtime");
  });
});

describe("Ivyhouse footer controls API", () => {
  it("reads footer controls with cwd context", async () => {
    const fetchMock = stubJsonFetch({ cwd: "/repo", mode: "default", fastOverride: "auto", fastEnabled: false, stateFile: "/state.json" });

    await ivyhouseApi.footerControls("/repo");

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchCall(fetchMock, 0)[0]).toBe("/api/ivyhouse/footer-controls?cwd=%2Frepo");
  });

  it("updates mode and toggles fast through the Ivyhouse bridge", async () => {
    const response = { cwd: "/repo", mode: "plan", fastOverride: "on", fastEnabled: true, stateFile: "/state.json" };
    const fetchMock = stubSequenceFetch([jsonResponse(response), jsonResponse(response)]);

    await ivyhouseApi.setFooterMode("/repo", "plan");
    await ivyhouseApi.toggleFast("/repo");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [modeUrl, modeInit] = fetchCall(fetchMock, 0);
    expect(modeUrl).toBe("/api/ivyhouse/footer-controls/mode");
    expect(modeInit?.method).toBe("POST");
    expect(JSON.parse(requestBody(modeInit))).toEqual({ cwd: "/repo", mode: "plan" });
    const [fastUrl, fastInit] = fetchCall(fetchMock, 1);
    expect(fastUrl).toBe("/api/ivyhouse/footer-controls/fast/toggle");
    expect(fastInit?.method).toBe("POST");
    expect(JSON.parse(requestBody(fastInit))).toEqual({ cwd: "/repo" });
  });
});

describe("session API compatibility", () => {
  it("keeps legacy session-id calls free of cwd context", async () => {
    const fetchMock = stubJsonFetch({ accepted: true });

    await sessionsApi.prompt("s 1", "hello", "followUp", "remote a");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchCall(fetchMock, 0);
    expect(url).toBe("/api/machines/remote%20a/sessions/s%201/prompt");
    expect(JSON.parse(requestBody(init))).toEqual({ text: "hello", streamingBehavior: "followUp" });
  });

  it("adds cwd context when session refs include a workspace", async () => {
    const fetchMock = stubJsonFetch({ accepted: true });

    await sessionsApi.prompt({ id: "s 1", cwd: "/repo" }, "hello", undefined, "remote a");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchCall(fetchMock, 0);
    expect(url).toBe("/api/machines/remote%20a/sessions/s%201/prompt");
    expect(JSON.parse(requestBody(init))).toEqual({ cwd: "/repo", text: "hello" });
  });
});

describe("machine-scoped file suggestion API", () => {
  it("uses the workspace-scoped route when the caller has enabled workspace-scoped suggestions", async () => {
    const fetchMock = stubJsonFetch([]);

    await filesApi.files("/repo", "README", { projectId: "p 1", workspaceId: "w/1", scope: "tracked", machineId: "remote a", workspaceScoped: true });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchCall(fetchMock, 0)[0]).toBe("/api/machines/remote%20a/projects/p%201/workspaces/w%2F1/files?q=README&scope=tracked");
  });

  it("falls back to the legacy cwd route when workspace-scoped suggestions are not enabled", async () => {
    const fetchMock = stubJsonFetch([]);

    await filesApi.files("/repo", "README", { projectId: "p 1", workspaceId: "w/1", scope: "tracked", machineId: "remote a" });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchCall(fetchMock, 0)[0]).toBe("/api/machines/remote%20a/files?q=README&scope=tracked&cwd=%2Frepo");
  });
});

describe("machine-scoped terminal command-run API", () => {
  it("deletes workspaces through the selected machine scope", async () => {
    const fetchMock = stubJsonFetch(commandRun);

    await workspacesApi.deleteWorkspace("p 1", "w/1", "remote a");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchCall(fetchMock, 0);
    expect(url).toBe("/api/machines/remote%20a/projects/p%201/workspaces/w%2F1");
    expect(init?.method).toBe("DELETE");
  });

  it("creates command runs through the selected machine scope", async () => {
    const fetchMock = stubJsonFetch(commandRun);

    await terminalsApi.runTerminalCommand("core", { workspace, title: "Build", command: "npm test", open: true }, "remote a");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchCall(fetchMock, 0);
    expect(url).toBe("/api/machines/remote%20a/projects/p%201/workspaces/w%2F1/terminal-command-runs");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(requestBody(init))).toEqual({ origin: "core", title: "Build", command: "npm test", metadata: {} });
  });

  it("closes all workspace terminals through the selected machine scope", async () => {
    const fetchMock = stubJsonFetch({ closed: true });

    await terminalsApi.closeWorkspaceTerminals("p 1", "w/1", "remote a");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchCall(fetchMock, 0);
    expect(url).toBe("/api/machines/remote%20a/projects/p%201/workspaces/w%2F1/terminals");
    expect(init?.method).toBe("DELETE");
  });

  it("lists, reads, and cancels command runs through the selected machine scope", async () => {
    const fetchMock = stubSequenceFetch([
      jsonResponse([commandRun]),
      jsonResponse(commandRun),
      jsonResponse(commandRun),
    ]);

    await terminalsApi.listCommandRuns({ projectId: "p 1", workspaceId: "w/1", statuses: ["running"], metadata: { "pi.operation": "workspace.delete" } }, "remote a");
    await terminalsApi.getCommandRun("run 1", "remote a");
    await terminalsApi.cancelCommandRun("run 1", "remote a");

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "/api/machines/remote%20a/terminal-command-runs?projectId=p+1&workspaceId=w%2F1&statuses=running&metadata=%7B%22pi.operation%22%3A%22workspace.delete%22%7D",
      "/api/machines/remote%20a/terminal-command-runs/run%201",
      "/api/machines/remote%20a/terminal-command-runs/run%201/cancel",
    ]);
    expect(fetchCall(fetchMock, 2)[1]?.method).toBe("POST");
  });

  it("returns undefined for missing command runs in the selected machine scope", async () => {
    const fetchMock = stubResponseFetch(new Response("{}", { status: 404 }));

    await expect(terminalsApi.getCommandRun("missing", "remote-a")).resolves.toBeUndefined();

    expect(fetchCall(fetchMock, 0)[0]).toBe("/api/machines/remote-a/terminal-command-runs/missing");
  });
});

type FetchLike = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
type FetchMock = ReturnType<typeof vi.fn<FetchLike>>;

function stubJsonFetch(value: unknown): FetchMock {
  return stubResponseFetch(jsonResponse(value));
}

function stubSequenceFetch(responses: Response[]): FetchMock {
  const fetchMock = vi.fn<FetchLike>(() => {
    const response = responses.shift();
    if (response === undefined) throw new Error("No fetch response queued");
    return Promise.resolve(response);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function stubResponseFetch(response: Response): FetchMock {
  const fetchMock = vi.fn<FetchLike>(() => Promise.resolve(response));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function fetchCall(fetchMock: FetchMock, index: number): Parameters<FetchLike> {
  const call = fetchMock.mock.calls[index];
  if (call === undefined) throw new Error(`Missing fetch call ${String(index)}`);
  return call;
}

function requestBody(init: RequestInit | undefined): string {
  if (typeof init?.body !== "string") throw new Error("Expected string request body");
  return init.body;
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}
