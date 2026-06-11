import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";

export interface UserPromptTimelineItem {
  id: string;
  index: number;
  text: string;
  active: boolean;
}

@customElement("user-prompt-timeline")
export class UserPromptTimeline extends LitElement {
  @property({ attribute: false }) items: UserPromptTimelineItem[] = [];
  @property({ attribute: false }) onJump?: (index: number) => void;

  override render() {
    if (this.items.length === 0) return null;
    return html`
      <nav class="timeline" aria-label="User prompt timeline">
        ${repeat(
          this.items,
          (item) => item.id,
          (item) => html`
            <button
              type="button"
              class=${item.active ? "node active" : "node"}
              title=${this.itemTitle(item)}
              aria-label=${this.itemTitle(item)}
              @click=${() => this.onJump?.(item.index)}
            >
              <span aria-hidden="true">👤</span>
            </button>
          `,
        )}
      </nav>
    `;
  }

  private itemTitle(item: UserPromptTimelineItem): string {
    const text = item.text.replace(/\s+/g, " ").trim();
    return text === "" ? `User prompt ${String(item.index + 1)}` : `User prompt ${String(item.index + 1)}: ${text.slice(0, 120)}`;
  }

  static override styles = css`
    :host {
      position: absolute;
      top: 28px;
      right: 10px;
      bottom: 64px;
      z-index: 12;
      width: 42px;
      pointer-events: none;
    }
    .timeline {
      box-sizing: border-box;
      width: 100%;
      max-height: 100%;
      display: flex;
      flex-direction: column;
      gap: 5px;
      align-items: stretch;
      overflow-y: auto;
      overflow-x: hidden;
      padding: 4px;
      border: 1px solid color-mix(in srgb, var(--pi-border) 70%, transparent);
      border-radius: 10px;
      background: color-mix(in srgb, var(--pi-bg) 86%, transparent);
      box-shadow: 0 8px 24px var(--pi-shadow-soft);
      backdrop-filter: blur(6px);
      pointer-events: auto;
      scrollbar-width: thin;
    }
    .node {
      flex: 0 0 auto;
      display: grid;
      place-items: center;
      min-width: 0;
      width: 100%;
      height: 26px;
      border: 1px solid var(--pi-accent-border);
      border-radius: 6px;
      background: var(--pi-selection-bg);
      color: var(--pi-text);
      padding: 0;
      font-size: 13px;
      line-height: 1;
      cursor: pointer;
      opacity: .78;
    }
    .node:hover,
    .node:focus-visible {
      opacity: 1;
      outline: 2px solid var(--pi-accent);
      outline-offset: 1px;
      transform: translateY(-1px);
    }
    .node.active {
      border-color: var(--pi-accent);
      background: var(--pi-accent-bg);
      color: var(--pi-accent);
      opacity: 1;
      box-shadow: 0 0 0 1px color-mix(in srgb, var(--pi-accent) 45%, transparent);
    }
    @media (max-width: 760px) {
      :host { width: 34px; right: 6px; top: 22px; bottom: 58px; }
      .timeline { padding: 3px; gap: 4px; border-radius: 8px; }
      .node { height: 23px; font-size: 12px; }
    }
  `;
}
