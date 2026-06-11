import type { PiWebPlugin, WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";

const STATUS_REFRESH_MS = 2_000;
const SECTION_STORAGE_KEY = "ivyhouse.piweb.statusPanel.collapsedSections";

type GateMode = "manual" | "semi-auto" | "autopilot";
type ItemStatus = "pending" | "in_progress" | "completed" | "deleted";
type ServiceStatus = "ready" | "configured" | "failed" | "gated" | "disabled";

interface StatusSnapshot {
  generatedAt: string;
  cwd: string;
  metrics?: {
    totalInput?: number;
    totalOutput?: number;
    cacheRead?: number;
    cacheWrite?: number;
    totalCost?: number;
    totalReasoning?: number | null;
  };
  gateAutoAnswer: {
    mode: GateMode;
    paused: boolean;
    permanent: boolean;
    scope: string;
  };
  plan: { items: { id: number; text: string; status: ItemStatus }[] };
  backgroundShells: { title: string; status: string }[];
  mcpServers: { name: string; status: ServiceStatus; disabled?: boolean }[];
  lspServers: { name: string; status: ServiceStatus }[];
  plugins: { name: string }[];
}

interface PanelState {
  snapshot?: StatusSnapshot;
  loading: boolean;
  loadedAt: number;
  error?: string;
  cyclingGate: boolean;
}

const panelStates = new Map<string, PanelState>();

function panelKey(context: WorkspacePanelContext): string {
  return `${context.machine.id}:${context.workspace.path}`;
}

function panelState(context: WorkspacePanelContext): PanelState {
  const key = panelKey(context);
  let state = panelStates.get(key);
  if (!state) {
    state = { loading: false, loadedAt: 0, cyclingGate: false };
    panelStates.set(key, state);
  }
  return state;
}

function statusUrl(context: WorkspacePanelContext): string {
  return `/api/ivyhouse/status-panel?cwd=${encodeURIComponent(context.workspace.path)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStatusSnapshot(value: unknown): value is StatusSnapshot {
  return isRecord(value) && isRecord(value["metrics"]) && isRecord(value["gateAutoAnswer"]);
}

function isGateCycleResponse(value: unknown): value is { gateAutoAnswer: StatusSnapshot["gateAutoAnswer"] } {
  return isRecord(value) && isRecord(value["gateAutoAnswer"]);
}

function scheduleSnapshotLoad(context: WorkspacePanelContext): void {
  const state = panelState(context);
  if (state.loading || Date.now() - state.loadedAt < STATUS_REFRESH_MS) return;
  state.loading = true;
  fetch(statusUrl(context), { cache: "no-store", credentials: "same-origin" })
    .then(async (response) => {
      if (!response.ok) throw new Error(response.statusText);
      const payload: unknown = await response.json();
      if (!isStatusSnapshot(payload)) throw new Error("Invalid status panel response");
      return payload;
    })
    .then((snapshot) => {
      state.snapshot = snapshot;
      delete state.error;
      state.loadedAt = Date.now();
    })
    .catch((error: unknown) => {
      state.error = error instanceof Error ? error.message : String(error);
      state.loadedAt = Date.now();
    })
    .finally(() => {
      state.loading = false;
      context.host.requestRender();
    });
}

function cycleGateMode(context: WorkspacePanelContext): void {
  const state = panelState(context);
  if (state.cyclingGate) return;
  state.cyclingGate = true;
  fetch("/api/ivyhouse/gate-autoanswer/cycle", {
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd: context.workspace.path }),
  })
    .then(async (response) => {
      if (!response.ok) throw new Error(response.statusText);
      const payload: unknown = await response.json();
      if (!isGateCycleResponse(payload)) throw new Error("Invalid gate mode response");
      return payload;
    })
    .then((payload) => {
      if (state.snapshot !== undefined) {
        state.snapshot = { ...state.snapshot, gateAutoAnswer: payload.gateAutoAnswer, generatedAt: new Date().toISOString() };
      }
      state.loadedAt = 0;
    })
    .catch((error: unknown) => {
      state.error = error instanceof Error ? error.message : String(error);
    })
    .finally(() => {
      state.cyclingGate = false;
      context.host.requestRender();
    });
}

function readCollapsedSections(): Set<string> {
  try {
    const raw = window.localStorage.getItem(SECTION_STORAGE_KEY);
    const parsed: unknown = raw !== null && raw !== "" ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

function toggleSection(sectionId: string, context: WorkspacePanelContext): void {
  const collapsed = readCollapsedSections();
  if (collapsed.has(sectionId)) collapsed.delete(sectionId);
  else collapsed.add(sectionId);
  try { window.localStorage.setItem(SECTION_STORAGE_KEY, JSON.stringify([...collapsed])); } catch { /* best-effort */ }
  context.host.requestRender();
}

function isSectionExpanded(sectionId: string): boolean {
  return !readCollapsedSections().has(sectionId);
}

function formatTokenTotal(value: number | undefined | null): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${String(Math.round(value / 1_000))}K`;
  return String(Math.round(value));
}

function formatCost(value: number | undefined | null): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "$0.00";
  return `$${value.toFixed(2)}`;
}

function serviceLabel(status: ServiceStatus): string {
  if (status === "ready") return "ready";
  if (status === "failed") return "failed";
  if (status === "gated") return "gated";
  if (status === "disabled") return "disabled";
  return "configured";
}

function serviceOn(status: ServiceStatus): boolean {
  return status === "ready" || status === "configured";
}

const plugin: PiWebPlugin = {
  apiVersion: 1,
  name: "Info Plugin",
  activate: ({ html, svg }) => {
    const renderMetric = (label: string, value: string) => html`
      <span class="ivy-status-pill"><span>${label}</span><strong>${value}</strong></span>
    `;

    const renderSection = (context: WorkspacePanelContext, id: string, title: string, tooltip: string, body: unknown) => {
      const expanded = isSectionExpanded(id);
      return html`
        <section class="ivy-status-section">
          <header class="ivy-status-section-header">
            <button class="ivy-status-section-trigger" title=${tooltip} @click=${() => { toggleSection(id, context); }}>
              <span>${title}</span>
              <span class=${expanded ? "ivy-status-chevron expanded" : "ivy-status-chevron"}>⌄</span>
            </button>
            <span class="ivy-status-info" title=${tooltip}>ⓘ</span>
          </header>
          ${expanded ? html`<div class="ivy-status-section-body">${body}</div>` : null}
        </section>
      `;
    };

    const renderGateAutoAnswer = (context: WorkspacePanelContext, snapshot: StatusSnapshot | undefined, state: PanelState) => {
      const fallbackGate: StatusSnapshot["gateAutoAnswer"] = { mode: "manual", paused: false, permanent: false, scope: "project" };
      const gate = snapshot?.gateAutoAnswer ?? fallbackGate;
      return html`
        <div class="ivy-status-card ivy-gate-card">
          <div class="ivy-status-card-text">
            <strong>Gate auto-answer</strong>
            <p>Manual by default. Click cycles manual → semi-auto → autopilot → manual.</p>
          </div>
          <button
            class=${`ivy-gate-toggle ivy-gate-${gate.mode}`}
            ?disabled=${state.cyclingGate}
            aria-label="Cycle Gate auto-answer mode"
            title="Cycle Gate auto-answer mode"
            @click=${() => { cycleGateMode(context); }}
          >
            <span class="ivy-gate-dot"></span>
            <span>${state.cyclingGate ? "..." : gate.paused ? "paused" : gate.mode}</span>
          </button>
        </div>
      `;
    };

    const renderPlan = (snapshot: StatusSnapshot | undefined) => {
      const items = snapshot?.plan.items.filter((item) => item.status !== "deleted") ?? [];
      if (items.length === 0) return html`<p class="ivy-status-empty">No plan items.</p>`;
      return html`<div class="ivy-plan-list">
        ${items.map((item) => html`
          <div class=${`ivy-plan-row ivy-plan-${item.status}`}>
            <span class="ivy-plan-check">${item.status === "completed" ? "✓" : item.status === "in_progress" ? "…" : "○"}</span>
            <span>${item.text}</span>
          </div>
        `)}
      </div>`;
    };

    const renderBackgroundShells = (context: WorkspacePanelContext, snapshot: StatusSnapshot | undefined) => {
      const rows = snapshot?.backgroundShells ?? [];
      if (rows.length > 0) return html`<div class="ivy-service-list">${rows.map((row) => html`<div class="ivy-status-card"><strong>${row.title}</strong><span>${row.status}</span></div>`)}</div>`;
      return html`<p class="ivy-status-empty">No background processes.</p>`;
    };

    const renderServiceList = (items: { name: string; status: ServiceStatus }[], empty: string) => {
      if (items.length === 0) return html`<p class="ivy-status-empty">${empty}</p>`;
      return html`<div class="ivy-service-list">
        ${items.map((item) => html`
          <div class="ivy-service-card">
            <strong>${item.name}</strong>
            <span class=${`ivy-service-right ivy-service-${item.status}`}>
              <span class="ivy-service-dot"></span>
              <span class=${serviceOn(item.status) ? "ivy-switch on" : "ivy-switch"}><span></span></span>
              <small>${serviceLabel(item.status)}</small>
            </span>
          </div>
        `)}
      </div>`;
    };

    const renderPlugins = (snapshot: StatusSnapshot | undefined) => {
      const plugins = snapshot?.plugins ?? [];
      if (plugins.length === 0) return html`<p class="ivy-status-empty">No plugins configured.</p>`;
      return html`<div class="ivy-plugin-list">${plugins.map((plugin) => html`<div class="ivy-plugin-card">${plugin.name}</div>`)}</div>`;
    };

    const renderStatusPanel = (context: WorkspacePanelContext) => {
      const state = panelState(context);
      scheduleSnapshotLoad(context);
      const snapshot = state.snapshot;
      const metrics = snapshot?.metrics;
      const input = metrics?.totalInput;
      const output = metrics?.totalOutput;
      const cacheRead = metrics?.cacheRead;
      const cacheWrite = metrics?.cacheWrite;
      const totalIn = metrics?.totalInput;
      const totalOut = metrics?.totalOutput;
      const totalCost = metrics?.totalCost;
      const totalReasoning = metrics?.totalReasoning ?? null;

      return html`
        <style>
          .ivy-status-panel { box-sizing: border-box; min-height: 100%; background: var(--pi-bg); color: var(--pi-text); font: 13px system-ui, sans-serif; }
          .ivy-status-metrics { display: flex; flex-wrap: wrap; gap: 8px; padding: 12px 14px; border-bottom: 1px solid var(--pi-border-muted); }
          .ivy-status-pill { display: inline-flex; align-items: baseline; gap: 5px; border: 1px solid var(--pi-border-muted); border-radius: 999px; background: var(--pi-surface); padding: 3px 8px; line-height: 1.2; }
          .ivy-status-pill span { color: var(--pi-muted); font-size: 10px; text-transform: uppercase; letter-spacing: .04em; }
          .ivy-status-pill strong { color: var(--pi-text); font-size: 12px; }
          .ivy-status-section { border-bottom: 1px solid var(--pi-border-muted); }
          .ivy-status-section-header { display: flex; align-items: center; gap: 8px; padding: 10px 14px 7px; }
          .ivy-status-section-trigger { flex: 1 1 auto; display: flex; align-items: center; justify-content: space-between; min-width: 0; border: 0; background: transparent; color: var(--pi-muted); padding: 0; font: inherit; font-size: 12px; text-transform: uppercase; letter-spacing: .045em; }
          .ivy-status-chevron { display: inline-block; transform: rotate(-90deg); color: var(--pi-muted); transition: transform .12s ease; }
          .ivy-status-chevron.expanded { transform: rotate(0deg); }
          .ivy-status-info { flex: 0 0 auto; color: var(--pi-muted); font-size: 13px; }
          .ivy-status-section-body { padding: 0 14px 10px; }
          .ivy-status-card, .ivy-service-card, .ivy-plugin-card { border: 1px solid var(--pi-border-muted); border-radius: 6px; background: var(--pi-surface); color: var(--pi-text); }
          .ivy-status-card { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 12px; }
          .ivy-status-card-text { min-width: 0; }
          .ivy-status-card strong, .ivy-service-card strong { display: block; font-size: 12px; }
          .ivy-status-card p { margin: 4px 0 0; color: var(--pi-muted); font-size: 12px; line-height: 1.35; }
          .ivy-gate-toggle { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 6px; min-width: 94px; justify-content: center; border: 1px solid var(--pi-border); border-radius: 999px; background: var(--pi-surface); color: var(--pi-text); padding: 5px 8px; font-size: 12px; }
          .ivy-gate-dot { width: 8px; height: 8px; border-radius: 999px; background: var(--pi-muted); }
          .ivy-gate-manual .ivy-gate-dot { background: #ef4444; }
          .ivy-gate-semi-auto .ivy-gate-dot { background: #facc15; }
          .ivy-gate-autopilot .ivy-gate-dot { background: #22c55e; }
          .ivy-gate-manual { border-color: color-mix(in srgb, #ef4444 35%, var(--pi-border)); }
          .ivy-gate-semi-auto { border-color: color-mix(in srgb, #facc15 45%, var(--pi-border)); }
          .ivy-gate-autopilot { border-color: color-mix(in srgb, #22c55e 45%, var(--pi-border)); }
          .ivy-plan-list, .ivy-service-list, .ivy-plugin-list { display: grid; gap: 7px; }
          .ivy-plan-list { border: 1px solid var(--pi-border-muted); background: color-mix(in srgb, var(--pi-surface) 70%, #000); }
          .ivy-plan-row { display: grid; grid-template-columns: 22px minmax(0, 1fr); gap: 7px; align-items: start; padding: 8px 10px; border-bottom: 1px solid var(--pi-border-muted); }
          .ivy-plan-row:last-child { border-bottom: 0; }
          .ivy-plan-check { display: inline-grid; place-items: center; width: 17px; height: 17px; border-radius: 999px; background: #0ea5e9; color: white; font-size: 12px; font-weight: 700; }
          .ivy-plan-pending .ivy-plan-check { background: var(--pi-surface-hover); color: var(--pi-muted); border: 1px solid var(--pi-border); }
          .ivy-plan-in_progress .ivy-plan-check { background: #facc15; color: #111827; }
          .ivy-service-card { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 9px 10px; }
          .ivy-service-right { display: inline-flex; align-items: center; gap: 8px; color: var(--pi-muted); }
          .ivy-service-dot { width: 5px; height: 5px; border-radius: 999px; background: var(--pi-muted); }
          .ivy-service-ready .ivy-service-dot, .ivy-service-configured .ivy-service-dot { background: #22c55e; }
          .ivy-service-failed .ivy-service-dot { background: #ef4444; }
          .ivy-service-gated .ivy-service-dot, .ivy-service-disabled .ivy-service-dot { background: #facc15; }
          .ivy-switch { position: relative; width: 31px; height: 16px; border-radius: 999px; background: var(--pi-border); }
          .ivy-switch span { position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 999px; background: var(--pi-muted); transition: transform .12s ease; }
          .ivy-switch.on { background: color-mix(in srgb, #22c55e 42%, var(--pi-border)); }
          .ivy-switch.on span { transform: translateX(15px); background: #66c276; }
          .ivy-plugin-card { padding: 8px 9px; overflow-wrap: anywhere; font-size: 12px; line-height: 1.35; }
          .ivy-status-empty { margin: 0; color: var(--pi-muted); font-size: 12px; font-style: italic; }
          .ivy-status-error { margin: 0; padding: 8px 14px; color: var(--pi-danger); border-bottom: 1px solid var(--pi-border-muted); }
        </style>
        <div class="ivy-status-panel">
          <div class="ivy-status-metrics">
            ${renderMetric("INPUT", formatTokenTotal(input))}
            ${renderMetric("OUTPUT", formatTokenTotal(output))}
            ${renderMetric("CACHE READ", formatTokenTotal(cacheRead))}
            ${renderMetric("CACHE WRITE", formatTokenTotal(cacheWrite))}
            ${renderMetric("TOTAL IN", formatTokenTotal(totalIn))}
            ${renderMetric("TOTAL OUT", formatTokenTotal(totalOut))}
            ${renderMetric("TOTAL COST", formatCost(totalCost))}
            ${renderMetric("TOTAL REASONING", formatTokenTotal(totalReasoning))}
          </div>
          ${state.error !== undefined && state.error !== "" ? html`<p class="ivy-status-error">${state.error}</p>` : null}
          ${renderSection(context, "gate-autoanswer", "Gate auto-answer", "Cycle local gate automation mode. This does not bypass hard safety rails.", renderGateAutoAnswer(context, snapshot, state))}
          ${renderSection(context, "plan", "Plan", "Current Ivyhouse todo/plan snapshot.", renderPlan(snapshot))}
          ${renderSection(context, "background-shells", "Background shells", "Background terminal or shell processes.", renderBackgroundShells(context, snapshot))}
          ${renderSection(context, "mcp", "MCP servers", "Configured Pi MCP servers. Configured does not claim live readiness.", renderServiceList(snapshot?.mcpServers ?? [], "No MCP servers detected."))}
          ${renderSection(context, "lsp", "LSP servers", "Configured read-only Pi LSP router servers.", renderServiceList(snapshot?.lspServers ?? [], "No LSP servers detected."))}
          ${renderSection(context, "plugins", "Plugins", "Configured Pi packages and Ivyhouse extensions.", renderPlugins(snapshot))}
        </div>
      `;
    };

    return {
      contributions: {
        actions: [
          {
            id: "workspace.show-path",
            title: "Show Current Workspace Path",
            group: "Info",
            enabled: (context) => context.state.selectedWorkspace !== undefined,
            run: (context) => {
              const path = context.state.selectedWorkspace?.path ?? "No workspace selected";
              window.alert(path);
            },
          },
        ],
        workspaceLabels: [
          {
            id: "workspace.kind-label",
            order: 100,
            items: (context) => [{ type: "text", text: context.workspace.isGitRepo ? "git" : "folder", title: context.workspace.path }],
          },
        ],
        workspacePanels: [
          {
            id: "workspace.info",
            title: "Status",
            icon: svg`
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="9"></circle>
                <path d="M12 11v5"></path>
                <path d="M12 8h.01"></path>
              </svg>
            `,
            order: 1000,
            render: renderStatusPanel,
          },
        ],
      },
    };
  },
};

export default plugin;
