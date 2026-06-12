import { defaultKeymap, history, historyKeymap, indentWithTab, insertNewlineAndIndent } from "@codemirror/commands";
import { markdown, deleteMarkupBackward, insertNewlineContinueMarkup } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { defaultHighlightStyle, indentOnInput, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { LitElement, html, type PropertyValues } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { api, type FileSuggestion, type SessionStatus, type SlashCommand } from "../api";
import { inputModeForDraft } from "../inputModes";
import type { PromptAttachmentPayload } from "../../../shared/promptAttachments";
import {
  extensionFromFilename,
  isDocumentAttachmentExtension,
  isImageAttachmentExtension,
  isRiskyAttachmentFilename,
  isSupportedAttachmentExtension,
  isTextAttachmentExtension,
  MAX_ATTACHMENT_COUNT,
  MAX_DOCUMENT_ATTACHMENT_BYTES,
  MAX_IMAGE_ATTACHMENT_BYTES,
  MAX_TEXT_ATTACHMENT_BYTES,
} from "../../../shared/promptAttachments";
import { machineSessionKey } from "../machineKeys";
import { detectPromptCompletionTrigger, fileCompletionInsertText, type PromptCompletionTrigger } from "../promptCompletions";
import { clearDraft, loadDraft, saveDraft } from "../promptDraftStorage";
import { promptEditorStyles, type CompletionItem } from "./shared";
import "./AutocompleteMenu";
import "./PromptAttachmentBar";

@customElement("prompt-editor")
export class PromptEditor extends LitElement {
  @property({ type: Boolean }) disabled = false;
  @property() sessionId?: string;
  @property() cwd?: string;
  @property() machineId = "local";
  @property({ type: Boolean }) canSteer = false;
  @property({ type: Boolean }) isCompacting = false;
  @property({ type: Boolean }) canStop = false;
  @property({ attribute: false }) status?: SessionStatus;
  @property({ attribute: false }) onSend?: (text: string, attachments?: PromptAttachmentPayload[], streamingBehavior?: "steer" | "followUp") => void;
  @property({ attribute: false }) onStop?: () => void;
  @property({ attribute: false }) onSelectModel?: () => void;
  @property({ attribute: false }) onSelectThinking?: () => void;
  @query(".markdown-editor") private editorHost?: HTMLDivElement;
  @state() private draft = "";
  @state() private completions: CompletionItem[] = [];
  @state() private attachments: PromptAttachmentPayload[] = [];
  @state() private isDraggingFile = false;
  @state() private selectedIndex = 0;
  private requestVersion = 0;
  private editor: EditorView | undefined;
  private readonly editableCompartment = new Compartment();
  private readonly readOnlyCompartment = new Compartment();

  protected override willUpdate(changed: PropertyValues<this>) {
    if (!changed.has("sessionId") && !changed.has("machineId")) return;
    const previousSessionId = changed.has("sessionId") ? changed.get("sessionId") : this.sessionId;
    const previousMachineId = changed.has("machineId") ? changed.get("machineId") : this.machineId;
    const previousKey = draftStorageKey(previousMachineId, previousSessionId);
    if (previousKey !== undefined) saveDraft(previousKey, this.draft);
    const currentKey = draftStorageKey(this.machineId, this.sessionId);
    this.draft = currentKey !== undefined ? loadDraft(currentKey) : "";
    this.completions = [];
    this.attachments = [];
    this.isDraggingFile = false;
    this.selectedIndex = 0;
  }

  override firstUpdated(): void {
    this.createEditor();
  }

  protected override updated(changed: PropertyValues) {
    if (changed.has("disabled")) this.updateEditorDisabledState();
    if (changed.has("draft") || changed.has("sessionId") || changed.has("machineId")) this.syncEditorDoc();
  }

  override disconnectedCallback(): void {
    this.editor?.destroy();
    this.editor = undefined;
    super.disconnectedCallback();
  }

  override render() {
    const inputMode = inputModeForDraft(this.draft);
    const shellMode = inputMode.kind === "shell";
    const queuesInput = this.canSteer || this.isCompacting;
    return html`
      <footer
        class=${`${shellMode ? "shell-mode" : ""}${this.isDraggingFile ? " dragging-file" : ""}`}
        @dragover=${(event: DragEvent) => { this.handleDragOver(event); }}
        @dragleave=${(event: DragEvent) => { this.handleDragLeave(event); }}
        @drop=${(event: DragEvent) => { void this.handleDrop(event); }}
      >
        <div class="editor-wrap">
          <div class=${`markdown-editor${this.disabled ? " markdown-editor-disabled" : ""}`} aria-label="Message pi" aria-disabled=${this.disabled ? "true" : "false"}></div>
          ${shellMode ? html`<div class="mode-hint">Shell command${inputMode.excludeFromContext ? " · excluded from context" : ""}</div>` : null}
          ${this.isCompacting && !shellMode ? html`<div class="mode-hint">Compacting history · message will be queued</div>` : null}
          <autocomplete-menu .items=${this.completions} .selectedIndex=${this.selectedIndex} .onPick=${(item: CompletionItem) => { this.pick(item); }}></autocomplete-menu>
          <prompt-attachment-bar .attachments=${this.attachments} .onRemove=${(id: string) => { this.removeAttachment(id); }}></prompt-attachment-bar>
          ${this.isDraggingFile ? html`<div class="drop-overlay">Drop files to attach</div>` : null}
        </div>
        <div class="actions">
          ${this.renderCompactStatus()}
          <button ?disabled=${this.disabled} title=${queuesInput ? "Queue until the current activity finishes" : "Send message"} @click=${() => { this.send("followUp"); }}>${queuesInput ? "Queue" : "Send"}</button>
          ${this.canSteer && !this.isCompacting ? html`<button ?disabled=${this.disabled} title="Steer the current response before the next model call" @click=${() => { this.send("steer"); }}>Steer</button>` : null}
          <button ?disabled=${this.disabled || !this.canStop} title=${this.canStop ? "Stop current work and clear queued messages" : "Nothing running"} @click=${() => this.onStop?.()}>Stop</button>
        </div>
      </footer>
    `;
  }

  focusInput() {
    this.editor?.focus();
  }

  private renderCompactStatus() {
    const status = this.status;
    if (status === undefined) return null;
    const model = status.model?.id ?? "no model";
    const provider = status.model?.provider !== undefined && status.model.provider !== "" ? `${status.model.provider}/` : "";
    return html`
      <div class="compact-status" aria-label="Session status">
        <button class="select-model" title="Select model" @click=${() => this.onSelectModel?.()}>${provider}${model}</button>
        <button class="select-thinking" title="Select thinking level" @click=${() => this.onSelectThinking?.()}>think ${status.thinkingLevel ?? "off"}</button>
        ${this.renderExtensionStatus("ivyhouse-fast")}
      </div>
    `;
  }

  private renderExtensionStatus(key: string) {
    const item = this.status?.extensionStatuses?.find((status) => status.key === key);
    if (item === undefined || item.label.trim().length === 0) return null;
    return html`<span class="status-pill" title=${item.label}>${item.label}</span>`;
  }

  private createEditor() {
    if (!this.editorHost || this.editor !== undefined) return;
    this.editor = new EditorView({
      parent: this.editorHost,
      state: EditorState.create({
        doc: this.draft,
        extensions: [
          history(),
          markdown(),
          indentOnInput(),
          indentUnit.of("  "),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of((view) => inputAssistanceContentAttributes(view.state.sliceDoc(0, view.state.selection.main.head))),
          placeholder("Message pi... Use / for commands, @ for tracked files, @ space for all files"),
          this.editableCompartment.of(EditorView.editable.of(!this.disabled)),
          this.readOnlyCompartment.of(EditorState.readOnly.of(this.disabled)),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) this.updateDraft(update.state.doc.toString());
          }),
          keymap.of([
            { key: "ArrowDown", run: () => this.moveCompletion(1) },
            { key: "ArrowUp", run: () => this.moveCompletion(-1) },
            { key: "Escape", run: () => this.closeCompletions() },
            { key: "Enter", run: () => this.handleEditorEnter() },
            { key: "Shift-Enter", run: (view) => insertNewlineContinueMarkup(view) || insertNewlineAndIndent(view) },
            { key: "Tab", run: (view) => this.handleEditorTab(view) },
            { key: "Shift-Tab", run: (view) => indentWithTab.shift?.(view) ?? false },
            { key: "Backspace", run: (view) => deleteMarkupBackward(view) },
            ...historyKeymap,
            ...defaultKeymap,
          ]),
        ],
      }),
    });
  }

  private syncEditorDoc() {
    const editor = this.editor;
    if (!editor) return;
    const current = editor.state.doc.toString();
    if (current === this.draft) return;
    editor.dispatch({
      changes: { from: 0, to: current.length, insert: this.draft },
      selection: EditorSelection.cursor(this.draft.length),
    });
  }

  private updateEditorDisabledState() {
    this.editor?.dispatch({
      effects: [
        this.editableCompartment.reconfigure(EditorView.editable.of(!this.disabled)),
        this.readOnlyCompartment.reconfigure(EditorState.readOnly.of(this.disabled)),
      ],
    });
  }

  private updateDraft(value: string) {
    this.draft = value;
    const key = draftStorageKey(this.machineId, this.sessionId);
    if (key !== undefined) saveDraft(key, this.draft);
    void this.refreshCompletions();
  }

  private async refreshCompletions() {
    const trigger = this.currentTrigger();
    const version = ++this.requestVersion;
    this.selectedIndex = 0;
    if (trigger === undefined) {
      this.completions = [];
      return;
    }
    if (trigger.kind === "command" && this.sessionId !== undefined && this.sessionId !== "" && this.cwd !== undefined && this.cwd !== "") {
      const commands = await api.commands({ id: this.sessionId, cwd: this.cwd }, this.machineId).catch(emptySlashCommands);
      if (version !== this.requestVersion) return;
      this.completions = commands
        .filter((command) => command.name.toLowerCase().includes(trigger.query.toLowerCase()))
        .slice(0, 12)
        .map((command) => ({
          kind: "command",
          replaceFrom: trigger.from,
          replaceTo: trigger.to,
          insertText: `/${command.name}`,
          detail: command.source,
          ...(command.description === undefined ? {} : { description: command.description }),
        }));
    } else if (trigger.kind === "file" && this.cwd !== undefined && this.cwd !== "") {
      const files = await api.files(this.cwd, trigger.query, { scope: trigger.fileScope, machineId: this.machineId }).catch(emptyFileSuggestions);
      if (version !== this.requestVersion) return;
      this.completions = files
        .slice(0, 12)
        .map((file) => {
          const insertText = fileCompletionInsertText(file.path, trigger.quoted === true, file.path.endsWith("/") ? trigger.allPrefix : undefined);
          return {
            kind: "file",
            replaceFrom: trigger.from,
            replaceTo: trigger.to,
            insertText,
            detail: file.kind,
            ...(file.path.endsWith("/") && insertText.endsWith("\"") ? { cursorOffset: insertText.length - 1 } : {}),
          };
        });
    }
  }

  private currentTrigger(): PromptCompletionTrigger | undefined {
    return detectPromptCompletionTrigger(this.draft, this.editor?.state.selection.main.head ?? this.draft.length);
  }

  private moveCompletion(delta: number): boolean {
    if (!this.completions.length) return false;
    this.selectedIndex = (this.selectedIndex + delta + this.completions.length) % this.completions.length;
    return true;
  }

  private closeCompletions(): boolean {
    if (!this.completions.length) return false;
    this.completions = [];
    return true;
  }

  private handleEditorEnter(): boolean {
    if (this.completions.length) {
      const completion = this.completions[this.selectedIndex];
      if (completion !== undefined) this.pick(completion);
      return true;
    }
    this.send(this.canSteer || this.isCompacting ? "followUp" : undefined);
    return true;
  }

  private handleEditorTab(view: EditorView): boolean {
    if (this.completions.length) {
      const completion = this.completions[this.selectedIndex];
      if (completion !== undefined) this.pick(completion);
      return true;
    }
    const trigger = this.currentTrigger();
    if (trigger?.kind === "file") {
      void this.refreshCompletions();
      return true;
    }
    return indentWithTab.run?.(view) ?? false;
  }

  private pick(item: CompletionItem) {
    const editor = this.editor;
    if (!editor) return;
    const suffix = item.kind === "file" && (item.insertText.endsWith("/") || item.cursorOffset !== undefined) ? "" : " ";
    const cursor = item.replaceFrom + (item.cursorOffset ?? item.insertText.length) + suffix.length;
    const replaceTo = item.insertText.endsWith("\"") && this.draft.slice(item.replaceTo).startsWith("\"") ? item.replaceTo + 1 : item.replaceTo;
    editor.dispatch({
      changes: { from: item.replaceFrom, to: replaceTo, insert: `${item.insertText}${suffix}` },
      selection: EditorSelection.cursor(cursor),
      scrollIntoView: true,
    });
    this.completions = [];
  }

  private handleDragOver(event: DragEvent): void {
    if (this.disabled || !hasFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    this.isDraggingFile = true;
  }

  private handleDragLeave(event: DragEvent): void {
    const relatedTarget = event.relatedTarget;
    if (relatedTarget instanceof Node && this.contains(relatedTarget)) return;
    this.isDraggingFile = false;
  }

  private async handleDrop(event: DragEvent): Promise<void> {
    if (this.disabled || !hasFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    this.isDraggingFile = false;
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    const remaining = Math.max(0, MAX_ATTACHMENT_COUNT - this.attachments.length);
    const acceptedFiles = files.slice(0, remaining);
    const attachments = await Promise.all(acceptedFiles.map((file) => this.createAttachment(file)));
    const skipped = files.length - acceptedFiles.length;
    const skippedAttachment = skipped > 0 ? [this.unsupportedAttachment(`skipped-${String(Date.now())}`, `${String(skipped)} skipped files`, "", 0, `Only ${String(MAX_ATTACHMENT_COUNT)} attachments are allowed.`)] : [];
    this.attachments = [...this.attachments, ...attachments, ...skippedAttachment];
    this.editor?.focus();
  }

  private async createAttachment(file: File): Promise<PromptAttachmentPayload> {
    const extension = extensionFromFilename(file.name);
    const warnings = isRiskyAttachmentFilename(file.name) ? ["Sensitive filename: content will not be attached."] : [];
    if (!isSupportedAttachmentExtension(extension)) return this.unsupportedAttachment(`att-${crypto.randomUUID()}`, file.name, file.type, file.size, "Unsupported file type.");
    if (warnings.length > 0) return this.metadataOnlyAttachment(file, extension, warnings);

    if (isTextAttachmentExtension(extension)) {
      if (file.size > MAX_TEXT_ATTACHMENT_BYTES) return this.metadataOnlyAttachment(file, extension, [`Text file is larger than ${formatBytes(MAX_TEXT_ATTACHMENT_BYTES)}; content not attached.`]);
      return { id: `att-${crypto.randomUUID()}`, kind: "text", filename: file.name, extension, mime: file.type || mimeForExtension(extension), size: file.size, source: "drop", warnings, text: await file.text(), extractionStatus: "ready" };
    }

    if (isDocumentAttachmentExtension(extension)) {
      if (file.size > MAX_DOCUMENT_ATTACHMENT_BYTES) return this.metadataOnlyAttachment(file, extension, [`Document is larger than ${formatBytes(MAX_DOCUMENT_ATTACHMENT_BYTES)}; content not attached.`]);
      return { id: `att-${crypto.randomUUID()}`, kind: "document", filename: file.name, extension, mime: file.type || mimeForExtension(extension), size: file.size, source: "drop", warnings, dataBase64: await fileToBase64(file), extractionStatus: "ready" };
    }

    if (isImageAttachmentExtension(extension)) {
      if (file.size > MAX_IMAGE_ATTACHMENT_BYTES) return this.metadataOnlyAttachment(file, extension, [`Image is larger than ${formatBytes(MAX_IMAGE_ATTACHMENT_BYTES)}; content not attached.`]);
      const dataBase64 = await fileToBase64(file);
      const mime = file.type || mimeForExtension(extension);
      return { id: `att-${crypto.randomUUID()}`, kind: "image", filename: file.name, extension, mime, size: file.size, source: "drop", warnings, dataBase64, dataUrl: `data:${mime};base64,${dataBase64}`, extractionStatus: "ready" };
    }

    return this.unsupportedAttachment(`att-${crypto.randomUUID()}`, file.name, file.type, file.size, "Unsupported file type.");
  }

  private metadataOnlyAttachment(file: File, extension: string, warnings: string[]): PromptAttachmentPayload {
    const kind = isImageAttachmentExtension(extension) ? "image" : isDocumentAttachmentExtension(extension) ? "document" : isTextAttachmentExtension(extension) ? "text" : "unsupported";
    return { id: `att-${crypto.randomUUID()}`, kind, filename: file.name, extension, mime: file.type || mimeForExtension(extension), size: file.size, source: "drop", warnings, extractionStatus: "metadata-only", reason: warnings[0] ?? "Metadata only." };
  }

  private unsupportedAttachment(id: string, filename: string, mime: string, size: number, reason: string): PromptAttachmentPayload {
    return { id, kind: "unsupported", filename, extension: extensionFromFilename(filename), mime: mime || "application/octet-stream", size, source: "drop", warnings: [reason], extractionStatus: "metadata-only", reason };
  }

  private removeAttachment(id: string): void {
    this.attachments = this.attachments.filter((attachment) => attachment.id !== id);
  }

  private send(streamingBehavior?: "steer" | "followUp") {
    const text = this.draft.trim();
    if ((text === "" && this.attachments.length === 0) || this.disabled) return;
    const attachments = this.attachments;
    this.draft = "";
    this.attachments = [];
    const key = draftStorageKey(this.machineId, this.sessionId);
    if (key !== undefined) clearDraft(key);
    this.completions = [];
    this.onSend?.(text, attachments, this.canSteer || this.isCompacting ? streamingBehavior : undefined);
  }

  static override styles = promptEditorStyles;
}

function hasFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

async function fileToBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function mimeForExtension(extension: string): string {
  switch (extension.toLowerCase()) {
    case ".txt": return "text/plain";
    case ".md": return "text/markdown";
    case ".html": return "text/html";
    case ".csv": return "text/csv";
    case ".pdf": return "application/pdf";
    case ".doc": return "application/msword";
    case ".docx": return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".xls": return "application/vnd.ms-excel";
    case ".xlsx": return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    case ".gif": return "image/gif";
    default: return "application/octet-stream";
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function draftStorageKey(machineId: unknown, sessionId: unknown): string | undefined {
  if (typeof machineId !== "string" || machineId === "") return undefined;
  if (typeof sessionId !== "string" || sessionId === "") return undefined;
  return machineSessionKey(machineId, sessionId);
}

function emptySlashCommands(): SlashCommand[] {
  return [];
}

function emptyFileSuggestions(): FileSuggestion[] {
  return [];
}

const proseInputAssistanceAttributes: Record<string, string> = {
  spellcheck: "true",
  autocorrect: "on",
  autocapitalize: "sentences",
  writingsuggestions: "true",
};

const codeLikeInputAssistanceAttributes: Record<string, string> = {
  spellcheck: "false",
  autocorrect: "off",
  autocapitalize: "off",
  writingsuggestions: "false",
};

function inputAssistanceContentAttributes(draftBeforeCursor: string): Record<string, string> {
  // CodeMirror is optimized for code and disables these by default, but the chat prompt is usually prose.
  return inputModeForDraft(draftBeforeCursor).kind === "normal" ? proseInputAssistanceAttributes : codeLikeInputAssistanceAttributes;
}

