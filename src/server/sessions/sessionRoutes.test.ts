import Fastify, { type FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionEventHub } from "../realtime/sessionEventHub.js";
import { PiSessionService, type PiSessionManagerGateway, type PiSessionRef } from "./piSessionService.js";
import { registerSessionRoutes } from "./sessionRoutes.js";

let app: FastifyInstance;
let service: PiSessionService;
let sessionManager: RejectingSessionManager;

beforeEach(async () => {
  app = Fastify({ logger: false });
  await app.register(fastifyWebsocket);
  sessionManager = new RejectingSessionManager();
  const eventHub = new SessionEventHub();
  service = new PiSessionService(eventHub, { sessionManager, heartbeatIntervalMs: 60_000 });
  registerSessionRoutes(app, service, eventHub);
});

afterEach(async () => {
  await service.dispose();
  await app.close();
});

describe("session routes", () => {
  it("rejects prompt payloads that omit text without opening a session", async () => {
    const response = await app.inject({ method: "POST", url: "/sessions/session-1/prompt", payload: { body: "Build the thing" } });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Prompt text is required" });
    expect(sessionManager.calls).toEqual({ create: 0, list: 0, listAll: 0, open: 0 });
  });

  it("keeps legacy per-session routes usable without cwd", async () => {
    const routeApp = Fastify({ logger: false });
    await routeApp.register(fastifyWebsocket);
    const eventHub = new SessionEventHub();
    const routeService = new CapturingRouteSessionService(eventHub);
    registerSessionRoutes(routeApp, routeService, eventHub);

    try {
      const statusResponse = await routeApp.inject({ method: "GET", url: "/sessions/session-1/status" });
      const promptResponse = await routeApp.inject({ method: "POST", url: "/sessions/session-1/prompt", payload: { text: "hello" } });

      expect(statusResponse.statusCode).toBe(200);
      expect(promptResponse.statusCode).toBe(200);
      expect(routeService.calls).toEqual(["session-1", { lookup: "session-1", text: "hello" }]);
    } finally {
      await routeService.dispose();
      await routeApp.close();
    }
  });

  it("passes cwd when per-session routes include workspace context", async () => {
    const routeApp = Fastify({ logger: false });
    await routeApp.register(fastifyWebsocket);
    const eventHub = new SessionEventHub();
    const routeService = new CapturingRouteSessionService(eventHub);
    registerSessionRoutes(routeApp, routeService, eventHub);

    try {
      const statusResponse = await routeApp.inject({ method: "GET", url: `/sessions/session-1/status?cwd=${encodeURIComponent("/repo")}` });
      const promptResponse = await routeApp.inject({ method: "POST", url: "/sessions/session-1/prompt", payload: { cwd: "/repo", text: "hello" } });

      expect(statusResponse.statusCode).toBe(200);
      expect(promptResponse.statusCode).toBe(200);
      expect(routeService.calls).toEqual([{ id: "session-1", cwd: "/repo" }, { lookup: { id: "session-1", cwd: "/repo" }, text: "hello" }]);
    } finally {
      await routeService.dispose();
      await routeApp.close();
    }
  });
});

class CapturingRouteSessionService extends PiSessionService {
  readonly calls: unknown[] = [];

  constructor(eventHub: SessionEventHub) {
    super(eventHub, { sessionManager: new RejectingSessionManager(), heartbeatIntervalMs: 60_000 });
  }

  override status(lookup: string | PiSessionRef) {
    this.calls.push(lookup);
    return Promise.resolve({
      sessionId: sessionIdFromLookup(lookup),
      isStreaming: false,
      isCompacting: false,
      isBashRunning: false,
      pendingMessageCount: 0,
      queuedMessages: [],
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
    });
  }

  override prompt(lookup: string | PiSessionRef, text: unknown): Promise<void> {
    this.calls.push({ lookup, text });
    return Promise.resolve();
  }
}

class RejectingSessionManager implements PiSessionManagerGateway {
  readonly calls = { create: 0, list: 0, listAll: 0, open: 0 };

  list() {
    this.calls.list += 1;
    return Promise.resolve([]);
  }

  create(): never {
    this.calls.create += 1;
    throw new Error("Session manager should not create sessions for invalid prompt payloads");
  }

  listAll() {
    this.calls.listAll += 1;
    return Promise.resolve([]);
  }

  open(): never {
    this.calls.open += 1;
    throw new Error("Session manager should not open sessions for invalid prompt payloads");
  }
}

function sessionIdFromLookup(lookup: string | PiSessionRef): string {
  return typeof lookup === "string" ? lookup : lookup.id;
}
