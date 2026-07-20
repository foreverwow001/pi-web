import { defaultKeymap, history, historyKeymap, indentWithTab, insertNewlineAndIndent } from "@codemirror/commands";
import { markdown, deleteMarkupBackward, insertNewlineContinueMarkup } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { defaultHighlightStyle, indentOnInput, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { LitElement, html, type PropertyValues } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { api, type FileSuggestion, type IvyhouseFooterControlsResponse, type IvyhouseFooterMode, type SessionStatus, type SlashCommand } from "../api";
import { inputModeForDraft } from "../inputModes";
import type { PromptAttachmentPayload, PromptAttachmentSource } from "../../../shared/promptAttachments";
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

const ATTACHMENT_ACCEPT = ".txt,.md,.html,.csv,.pdf,.docx,.doc,.xlsx,.xls,.png,.jpg,.jpeg,.webp,.gif,text/plain,text/markdown,text/html,text/csv,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,image/*";
const MOBILE_ENTER_NEWLINE_QUERIES = ["(hover: none)", "(pointer: coarse)", "(display-mode: standalone)", "(display-mode: fullscreen)", "(display-mode: minimal-ui)"];

export function shouldUseMobileEnterNewline(matchMedia: (query: string) => Pick<MediaQueryList, "matches"> = window.matchMedia.bind(window)): boolean {
  return MOBILE_ENTER_NEWLINE_QUERIES.some((query) => matchMedia(query).matches);
}

export type PromptSendHandler = (text: string, streamingBehavior?: "steer" | "followUp", attachments?: PromptAttachmentPayload[]) => void;

export function promptSendArguments(
  text: string,
  streamingBehavior: "steer" | "followUp" | undefined,
  attachments: PromptAttachmentPayload[],
): Parameters<PromptSendHandler> {
  return [text, streamingBehavior, attachments];
}

@customElement("prompt-editor")
export class PromptEditor extends LitElement {
  @property({ type: Boolean }) disabled = false;
  @property() sessionId?: string;
  @property() cwd?: string;
  @property() machineId = "local";
  @property() projectId?: string;
  @property() workspaceId?: string;
  @property({ type: Boolean }) workspaceScopedFileSuggestions = false;
  @property({ type: Boolean }) canSteer = false;
  @property({ type: Boolean }) isCompacting = false;
  @property({ type: Boolean }) canStop = false;
  @property({ attribute: false }) status?: SessionStatus;
  @property({ type: Boolean }) sending = false;
  @property({ attribute: false }) onSend?: PromptSendHandler;
  @property({ attribute: false }) onStop?: () => void;
  @property({ attribute: false }) onSelectModel?: () => void;
  @property({ attribute: false }) onSelectThinking?: () => void;
  @query(".markdown-editor") private editorHost?: HTMLDivElement;
  @query(".file-input") private fileInput?: HTMLInputElement;
  @state() private draft = "";
  @state() private completions: CompletionItem[] = [];
  @state() private attachments: PromptAttachmentPayload[] = [];
  @state() private footerControls: IvyhouseFooterControlsResponse | undefined;
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
    void this.refreshFooterControls();
  }

  protected override updated(changed: PropertyValues) {
    if (changed.has("disabled")) this.updateEditorDisabledState();
    if (changed.has("draft") || changed.has("sessionId") || changed.has("machineId")) this.syncEditorDoc();
    if (changed.has("cwd") || changed.has("sessionId")) void this.refreshFooterControls();
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
    const busy = this.disabled || this.sending;
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
          <input class="file-input" type="file" multiple accept=${ATTACHMENT_ACCEPT} @change=${(event: Event) => { void this.handleFileInputChange(event); }} />
          <button class="attach-button" ?disabled=${busy} title="Attach files" aria-label="Attach files" @click=${() => { this.openFilePicker(); }}>📎</button>
          <button ?disabled=${busy} title=${queuesInput ? "Queue until the current activity finishes" : "Send message"} @click=${() => { this.send("followUp"); }}>${queuesInput ? "Queue" : "Send"}</button>
          ${this.canSteer && !this.isCompacting ? html`<button ?disabled=${busy} title="Steer the current response before the next model call" @click=${() => { this.send("steer"); }}>Steer</button>` : null}
          <button ?disabled=${this.disabled || !this.canStop} title=${this.canStop ? "Stop current work and clear queued messages" : "Nothing running"} @click=${() => this.onStop?.()}>Stop</button>
        </div>
      </footer>
    `;
  }

  focusInput() {
    this.editor?.focus();
  }

  /** Get the underlying CM6 EditorView, or undefined if not yet mounted. */
  get view(): EditorView | undefined {
    return this.editor;
  }

  private renderCompactStatus() {
    const status = this.status;
    if (status === undefined) return null;
    const model = status.model?.id ?? "no model";
    const provider = status.model?.provider !== undefined && status.model.provider !== "" ? `${status.model.provider}/` : "";
    const requestedMode = this.footerControls?.mode ?? "default";
    const effectiveMode = this.footerControls?.effectiveMode ?? "default";
    const modeTitle = this.footerControls?.requestedEffectiveMismatch === true
      ? `Requested ${requestedMode}; effective ${effectiveMode} until the next agent run applies the request`
      : `Mode ${requestedMode} is effective`;
    return html`
      <div class="compact-status status-primary" aria-label="Session mode and model">
        <select class="select-mode" title=${modeTitle} .value=${requestedMode} ?disabled=${this.disabled || this.cwd === undefined || this.cwd === "" || this.sessionId === undefined || this.sessionId === ""} @change=${(event: Event) => { this.setFooterModeFromEvent(event); }}>
          <option value="default">mode: default</option>
          <option value="build">mode: build</option>
          <option value="plan">mode: plan</option>
        </select>
        ${this.footerControls?.requestedEffectiveMismatch === true ? html`<span class="mode-effective-warning" title=${modeTitle}>effective: ${effectiveMode}</span>` : null}
        <button class="select-model" title="Select model" @click=${() => this.onSelectModel?.()}>${provider}${model}</button>
      </div>
      <div class="compact-status status-secondary" aria-label="Session thinking and fast mode">
        <button class="select-thinking" title="Select thinking level" @click=${() => this.onSelectThinking?.()}>think ${status.thinkingLevel ?? "off"}</button>
        <button class=${`fast-toggle ${this.footerControls?.fastEnabled === true ? "fast-on" : ""}`} title="Toggle Fast mode" aria-pressed=${String(this.footerControls?.fastEnabled === true)} ?disabled=${this.disabled || this.cwd === undefined || this.cwd === ""} @click=${() => { void this.toggleFast(); }}>fast</button>
      </div>
    `;
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
          EditorView.domEventHandlers({
            paste: (event) => this.handlePaste(event),
            beforeinput: (event) => this.handleBeforeInput(event),
          }),
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
            { key: "Enter", run: (view) => this.handleEditorEnter(view) },
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
      const files = await api.files(this.cwd, trigger.query, { scope: trigger.fileScope, machineId: this.machineId, projectId: this.projectId, workspaceId: this.workspaceId, workspaceScoped: this.workspaceScopedFileSuggestions }).catch(emptyFileSuggestions);
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

  private handleEditorEnter(view: EditorView): boolean {
    if (this.useMobileEnterNewline()) return this.insertEditorNewline(view);
    if (this.completions.length) {
      const completion = this.completions[this.selectedIndex];
      if (completion !== undefined) this.pick(completion);
      return true;
    }
    this.send(this.canSteer || this.isCompacting ? "followUp" : undefined);
    return true;
  }

  private handleBeforeInput(event: InputEvent): boolean {
    if (event.inputType !== "insertLineBreak" || !this.useMobileEnterNewline()) return false;
    const editor = this.editor;
    if (editor === undefined) return false;
    event.preventDefault();
    return this.insertEditorNewline(editor);
  }

  private insertEditorNewline(view: EditorView): boolean {
    return insertNewlineContinueMarkup(view) || insertNewlineAndIndent(view);
  }

  private useMobileEnterNewline(): boolean {
    return shouldUseMobileEnterNewline();
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

  private async refreshFooterControls(): Promise<void> {
    if (this.cwd === undefined || this.cwd === "" || this.sessionId === undefined || this.sessionId === "") {
      this.footerControls = undefined;
      return;
    }
    this.footerControls = await api.footerControls(this.cwd, this.sessionId).catch(() => this.footerControls);
  }

  private setFooterModeFromEvent(event: Event): void {
    const target = event.currentTarget;
    if (!(target instanceof HTMLSelectElement)) return;
    void this.setFooterMode(target.value);
  }

  private async setFooterMode(value: string): Promise<void> {
    if (this.cwd === undefined || this.cwd === "" || this.sessionId === undefined || this.sessionId === "") return;
    const mode = footerModeFromString(value);
    if (mode === undefined) return;
    this.footerControls = await api.setFooterMode(this.cwd, this.sessionId, mode).catch(() => this.footerControls);
  }

  private async toggleFast(): Promise<void> {
    if (this.cwd === undefined || this.cwd === "") return;
    this.footerControls = await api.toggleFast(this.cwd).catch(() => this.footerControls);
  }

  private openFilePicker(): void {
    if (this.disabled) return;
    this.fileInput?.click();
  }

  private async handleFileInputChange(event: Event): Promise<void> {
    const input = event.currentTarget instanceof HTMLInputElement ? event.currentTarget : this.fileInput;
    const files = Array.from(input?.files ?? []);
    if (input !== undefined) input.value = "";
    await this.addFilesAsAttachments(files, "picker");
  }

  private async handleDrop(event: DragEvent): Promise<void> {
    if (this.disabled || !hasFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    this.isDraggingFile = false;
    await this.addFilesAsAttachments(Array.from(event.dataTransfer?.files ?? []), "drop");
  }

  private handlePaste(event: ClipboardEvent): boolean {
    if (this.disabled) return false;
    const clipboard = event.clipboardData;
    if (clipboard === null) return false;
    const files = clipboardFiles(clipboard);
    if (files.length === 0) return false;
    event.preventDefault();
    event.stopPropagation();
    const text = clipboard.getData("text/plain");
    if (text !== "") this.insertTextAtSelection(text);
    void this.addFilesAsAttachments(files, "paste");
    return true;
  }

  private insertTextAtSelection(text: string): void {
    const editor = this.editor;
    if (!editor) return;
    const selection = editor.state.selection.main;
    editor.dispatch({ changes: { from: selection.from, to: selection.to, insert: text }, selection: EditorSelection.cursor(selection.from + text.length), scrollIntoView: true });
  }

  private async addFilesAsAttachments(files: File[], source: PromptAttachmentSource): Promise<void> {
    if (this.disabled || files.length === 0) return;
    const remaining = Math.max(0, MAX_ATTACHMENT_COUNT - this.attachments.length);
    const acceptedFiles = files.slice(0, remaining);
    const attachments = await Promise.all(acceptedFiles.map((file) => this.createAttachment(file, source)));
    const skipped = files.length - acceptedFiles.length;
    const skippedAttachment = skipped > 0 ? [this.unsupportedAttachment(`skipped-${String(Date.now())}`, `${String(skipped)} skipped files`, "", 0, `Only ${String(MAX_ATTACHMENT_COUNT)} attachments are allowed.`, source)] : [];
    this.attachments = [...this.attachments, ...attachments, ...skippedAttachment];
    this.editor?.focus();
  }

  private async createAttachment(file: File, source: PromptAttachmentSource): Promise<PromptAttachmentPayload> {
    const extension = extensionFromFilename(file.name);
    const warnings = isRiskyAttachmentFilename(file.name) ? ["Sensitive filename: content will not be attached."] : [];
    if (!isSupportedAttachmentExtension(extension)) return this.unsupportedAttachment(`att-${crypto.randomUUID()}`, file.name, file.type, file.size, "Unsupported file type.", source);
    if (warnings.length > 0) return this.metadataOnlyAttachment(file, extension, warnings, source);

    if (isTextAttachmentExtension(extension)) {
      if (file.size > MAX_TEXT_ATTACHMENT_BYTES) return this.metadataOnlyAttachment(file, extension, [`Text file is larger than ${formatBytes(MAX_TEXT_ATTACHMENT_BYTES)}; content not attached.`], source);
      return { id: `att-${crypto.randomUUID()}`, kind: "text", filename: file.name, extension, mime: file.type || mimeForExtension(extension), size: file.size, source, warnings, text: await file.text(), extractionStatus: "ready" };
    }

    if (isDocumentAttachmentExtension(extension)) {
      if (file.size > MAX_DOCUMENT_ATTACHMENT_BYTES) return this.metadataOnlyAttachment(file, extension, [`Document is larger than ${formatBytes(MAX_DOCUMENT_ATTACHMENT_BYTES)}; content not attached.`], source);
      return { id: `att-${crypto.randomUUID()}`, kind: "document", filename: file.name, extension, mime: file.type || mimeForExtension(extension), size: file.size, source, warnings, dataBase64: await fileToBase64(file), extractionStatus: "ready" };
    }

    if (isImageAttachmentExtension(extension)) {
      if (file.size > MAX_IMAGE_ATTACHMENT_BYTES) return this.metadataOnlyAttachment(file, extension, [`Image is larger than ${formatBytes(MAX_IMAGE_ATTACHMENT_BYTES)}; content not attached.`], source);
      const dataBase64 = await fileToBase64(file);
      const mime = file.type || mimeForExtension(extension);
      return { id: `att-${crypto.randomUUID()}`, kind: "image", filename: file.name, extension, mime, size: file.size, source, warnings, dataBase64, dataUrl: `data:${mime};base64,${dataBase64}`, extractionStatus: "ready" };
    }

    return this.unsupportedAttachment(`att-${crypto.randomUUID()}`, file.name, file.type, file.size, "Unsupported file type.", source);
  }

  private metadataOnlyAttachment(file: File, extension: string, warnings: string[], source: PromptAttachmentSource): PromptAttachmentPayload {
    const kind = isImageAttachmentExtension(extension) ? "image" : isDocumentAttachmentExtension(extension) ? "document" : isTextAttachmentExtension(extension) ? "text" : "unsupported";
    return { id: `att-${crypto.randomUUID()}`, kind, filename: file.name, extension, mime: file.type || mimeForExtension(extension), size: file.size, source, warnings, extractionStatus: "metadata-only", reason: warnings[0] ?? "Metadata only." };
  }

  private unsupportedAttachment(id: string, filename: string, mime: string, size: number, reason: string, source: PromptAttachmentSource): PromptAttachmentPayload {
    return { id, kind: "unsupported", filename, extension: extensionFromFilename(filename), mime: mime || "application/octet-stream", size, source, warnings: [reason], extractionStatus: "metadata-only", reason };
  }

  private removeAttachment(id: string): void {
    this.attachments = this.attachments.filter((attachment) => attachment.id !== id);
  }

  private send(streamingBehavior?: "steer" | "followUp") {
    const text = this.draft.trim();
    if ((text === "" && this.attachments.length === 0) || this.disabled || this.sending) return;
    const attachments = this.attachments;
    this.draft = "";
    this.attachments = [];
    const key = draftStorageKey(this.machineId, this.sessionId);
    if (key !== undefined) clearDraft(key);
    this.completions = [];
    this.onSend?.(...promptSendArguments(text, this.canSteer || this.isCompacting ? streamingBehavior : undefined, attachments));
  }

  static override styles = promptEditorStyles;
}

function hasFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

function clipboardFiles(data: DataTransfer): File[] {
  return Array.from(data.items)
    .filter((item) => item.kind === "file")
    .flatMap((item, index) => {
      const file = item.getAsFile();
      return file === null ? [] : [normalizeClipboardFile(file, index)];
    });
}

function normalizeClipboardFile(file: File, index: number): File {
  if (extensionFromFilename(file.name) !== "") return file;
  const extension = extensionForMime(file.type);
  if (extension === "") return file;
  const prefix = isImageAttachmentExtension(extension) ? "pasted-image" : "pasted-file";
  return new File([file], `${prefix}-${String(Date.now())}-${String(index + 1)}${extension}`, { type: file.type || mimeForExtension(extension), lastModified: file.lastModified });
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

function extensionForMime(mime: string): string {
  switch (mime.toLowerCase()) {
    case "text/plain": return ".txt";
    case "text/markdown": return ".md";
    case "text/html": return ".html";
    case "text/csv": return ".csv";
    case "application/pdf": return ".pdf";
    case "application/msword": return ".doc";
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document": return ".docx";
    case "application/vnd.ms-excel": return ".xls";
    case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": return ".xlsx";
    case "image/png": return ".png";
    case "image/jpeg": return ".jpg";
    case "image/webp": return ".webp";
    case "image/gif": return ".gif";
    default: return "";
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function footerModeFromString(value: string): IvyhouseFooterMode | undefined {
  if (value === "default" || value === "build" || value === "plan") return value;
  return undefined;
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

