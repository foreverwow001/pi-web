import { css, html, LitElement, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { PiWebConfigResponse, PiWebConfigValues } from "../../api";

@customElement("settings-sessiond-panel")
export class SettingsSessiondPanel extends LitElement {
  @property({ attribute: false }) configResponse: PiWebConfigResponse | undefined;
  @property({ type: Boolean }) loading = false;
  @property({ type: Boolean }) saving = false;
  @property() error = "";
  @property() savedMessage = "";
  @property({ attribute: false }) onReload?: () => void | Promise<void>;
  @property({ attribute: false }) onSave?: (config: PiWebConfigValues) => void | Promise<void>;

  override render(): TemplateResult {
    const config = this.configResponse;
    const spawnOverridden = config?.envOverrides.spawnSessions === true;
    // On by default: the effective config is the source of truth for the toggle
    // state, so an unset config file still shows the feature as enabled.
    const effectiveSpawn = config?.effectiveConfig.spawnSessions !== false;
    return html`
      <div class="section-heading">
        <div>
          <h2>Session daemon</h2>
          <p>These settings affect the long-lived session runtime. Changes are saved to the config file immediately but only take effect after the session daemon restarts.</p>
        </div>
        <button class="secondary" ?disabled=${this.loading} @click=${() => { void this.onReload?.(); }}>Reload</button>
      </div>
      ${this.renderMessages()}
      <div class="restart-note" role="note">Restart required: run <code>pi-web restart</code> (or restart the session daemon service) after changing these settings.</div>
      ${config === undefined && this.loading ? html`<div class="loading-card">Loading configuration…</div>` : html`
        <div class="config-path-card">
          <span>Config file</span>
          <code>${config?.path ?? "Unknown"}</code>
        </div>
        <div class="field">
          <span class="field-heading">
            <span>Allow agents to start sessions</span>
            ${spawnOverridden ? html`<span class="override-badge">environment override</span>` : null}
          </span>
          <label class="toggle">
            <input
              type="checkbox"
              .checked=${effectiveSpawn}
              ?disabled=${this.loading || this.saving || spawnOverridden}
              @change=${(event: Event) => { void this.toggleSpawnSessions(event); }}
            >
            <span>Enable the <code>spawn_session</code> tool</span>
          </label>
          <small>When enabled, LLMs can start new sessions, constrained to a workspace (any worktree) of the same registered project so every spawned session stays visible here. On by default.</small>
        </div>
        <section class="effective-card" aria-label="Effective configuration summary">
          <h3>Effective after environment overrides</h3>
          <dl>
            <div><dt>Spawn sessions</dt><dd>${effectiveSpawn ? "Enabled" : html`<span class="muted">Disabled</span>`}</dd></div>
          </dl>
        </section>
      `}
    `;
  }

  private renderMessages(): TemplateResult | null {
    if (this.error !== "") return html`<div class="message error-message">${this.error}</div>`;
    if (this.savedMessage !== "") return html`<div class="message success-message">${this.savedMessage}</div>`;
    return null;
  }

  private async toggleSpawnSessions(event: Event): Promise<void> {
    const enabled = event.target instanceof HTMLInputElement && event.target.checked;
    const baseConfig = this.configResponse?.config ?? {};
    await this.onSave?.({ ...baseConfig, spawnSessions: enabled });
  }

  static override styles = css`
    :host { display: block; }
    .section-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 14px; }
    .section-heading > div { display: grid; gap: 6px; min-width: 0; }
    h2, h3, p { margin: 0; }
    h2 { font-size: 17px; line-height: 1.25; }
    h3 { font-size: 13px; line-height: 1.3; }
    p { color: var(--pi-muted); line-height: 1.45; }
    button, input { font: inherit; }
    button { border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); color: var(--pi-text); padding: 7px 9px; cursor: pointer; }
    button:disabled { opacity: .55; cursor: not-allowed; }
    .secondary { flex: 0 0 auto; }
    .message, .loading-card, .config-path-card, .effective-card, .restart-note { border: 1px solid var(--pi-border); border-radius: 10px; background: var(--pi-surface); padding: 12px; }
    .message { margin-bottom: 12px; }
    .error-message { border-color: var(--pi-danger); color: var(--pi-danger); background: color-mix(in srgb, var(--pi-danger) 10%, var(--pi-surface)); }
    .success-message { border-color: var(--pi-success-border); color: var(--pi-success); background: var(--pi-success-surface); }
    .loading-card { color: var(--pi-muted); }
    .restart-note { margin-bottom: 14px; border-color: var(--pi-warning-border); color: var(--pi-warning); background: var(--pi-warning-surface); line-height: 1.45; }
    .config-path-card { display: grid; gap: 5px; margin-bottom: 14px; }
    .config-path-card span, .field-heading, dt { color: var(--pi-muted); font-size: 12px; font-weight: 700; text-transform: uppercase; }
    code { border: 1px solid var(--pi-border-muted); border-radius: 5px; background: var(--pi-bg); padding: 1px 4px; color: var(--pi-text); font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow-wrap: anywhere; }
    .field { display: grid; gap: 7px; margin-bottom: 14px; }
    .field small { color: var(--pi-muted); line-height: 1.45; }
    .field-heading { display: flex; align-items: center; gap: 8px; }
    .toggle { display: flex; align-items: center; gap: 9px; cursor: pointer; }
    .toggle input { width: 16px; height: 16px; }
    .toggle input:disabled { cursor: not-allowed; }
    .override-badge { border: 1px solid var(--pi-warning-border); border-radius: 999px; color: var(--pi-warning); background: var(--pi-warning-surface); padding: 2px 7px; font-size: 11px; font-weight: 600; text-transform: none; }
    .effective-card { display: grid; gap: 10px; }
    .effective-card dl { display: grid; gap: 8px; margin: 0; }
    .effective-card dl > div { display: grid; grid-template-columns: 130px minmax(0, 1fr); gap: 12px; align-items: baseline; }
    dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
    .muted { color: var(--pi-muted); }

    @media (max-width: 760px) {
      .section-heading { display: grid; gap: 12px; }
      .section-heading .secondary { justify-self: start; }
      .effective-card dl > div { grid-template-columns: minmax(0, 1fr); gap: 3px; }
    }
  `;
}
