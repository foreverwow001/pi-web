import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import type { PromptAttachmentPayload } from "../../../shared/promptAttachments";

@customElement("prompt-attachment-bar")
export class PromptAttachmentBar extends LitElement {
  @property({ attribute: false }) attachments: PromptAttachmentPayload[] = [];
  @property({ attribute: false }) onRemove?: (id: string) => void;

  override render() {
    if (this.attachments.length === 0) return null;
    return html`
      <div class="bar" aria-label="Prompt attachments">
        ${repeat(
          this.attachments,
          (attachment) => attachment.id,
          (attachment) => html`
            <article class=${`chip ${attachment.kind} ${attachment.warnings.length > 0 ? "warning" : ""}`} title=${this.attachmentTitle(attachment)}>
              ${this.renderPreview(attachment)}
              <div class="meta">
                <strong>${attachment.filename}</strong>
                <small>${attachment.kind} · ${formatBytes(attachment.size)}${attachment.extractionStatus ? ` · ${attachment.extractionStatus}` : ""}</small>
                ${attachment.warnings.length > 0 ? html`<small class="warn">${attachment.warnings[0]}</small>` : null}
              </div>
              <button type="button" title=${`Remove ${attachment.filename}`} aria-label=${`Remove ${attachment.filename}`} @click=${() => this.onRemove?.(attachment.id)}>×</button>
            </article>
          `,
        )}
      </div>
    `;
  }

  private renderPreview(attachment: PromptAttachmentPayload) {
    if (attachment.kind === "image" && attachment.dataUrl !== undefined) return html`<img src=${attachment.dataUrl} alt="" />`;
    const icon = attachment.kind === "text" ? "TXT" : attachment.kind === "document" ? "DOC" : attachment.kind === "image" ? "IMG" : "?";
    return html`<span class="icon" aria-hidden="true">${icon}</span>`;
  }

  private attachmentTitle(attachment: PromptAttachmentPayload): string {
    const details = [attachment.filename, attachment.mime, formatBytes(attachment.size), ...attachment.warnings].filter((value) => value !== "");
    return details.join("\n");
  }

  static override styles = css`
    :host { display: block; min-width: 0; }
    .bar { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 8px 0; }
    .chip { min-width: 0; max-width: min(100%, 280px); display: grid; grid-template-columns: 36px minmax(0, 1fr) auto; align-items: center; gap: 7px; border: 1px solid var(--pi-border); border-radius: 9px; background: var(--pi-surface); color: var(--pi-text); padding: 5px; }
    .chip.warning { border-color: var(--pi-warning-border); background: var(--pi-warning-surface); }
    .chip.unsupported { opacity: .82; }
    .icon, img { width: 34px; height: 34px; border-radius: 7px; border: 1px solid var(--pi-border-muted); background: var(--pi-bg); }
    .icon { display: grid; place-items: center; color: var(--pi-muted); font: 10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    img { object-fit: cover; }
    .meta { min-width: 0; display: grid; gap: 1px; }
    strong, small { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    strong { font-size: 12px; font-weight: 650; }
    small { color: var(--pi-muted); font-size: 11px; }
    .warn { color: var(--pi-warning); }
    button { display: grid; place-items: center; width: 24px; height: 24px; border: 1px solid var(--pi-border); border-radius: 6px; background: var(--pi-bg); color: var(--pi-muted); padding: 0; font: 16px system-ui, sans-serif; line-height: 1; cursor: pointer; }
    button:hover, button:focus { color: var(--pi-danger); border-color: var(--pi-danger); }
  `;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown size";
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
