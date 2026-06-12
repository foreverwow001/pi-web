import { LitElement, html } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { ChatDisclosureController } from "../chatDisclosure";
import { groupChatMessages, summarizeChatGroup, type ChatGroup } from "../chatGroups";
import { capturePrependScrollAnchor, PREPEND_RESTORE_SETTLE_FRAMES, restorePrependScrollAnchor, type PrependScrollAnchor } from "../chatScrollAnchoring";
import { shouldRequestEarlierMessages } from "../chatHistoryLoading";
import { ChatScrollController, distanceFromScrollBottom, findFirstVisibleArticle, isNearScrollBottom, type ChatAnchorScrollPosition, type ChatScrollRestoreResult } from "../chatScrollPosition";
import type { SessionActivity, SessionStatus } from "../api";
import { formatCost, formatTokenCount } from "../utils/format";
import type { ChatLine, ChatPart } from "./shared";
import { chatStyles } from "./shared";
import "./ConversationMeter";
import "./FormattedText";
import "./ToolExecutionView";
import "./UserPromptTimeline";
import type { UserPromptTimelineItem } from "./UserPromptTimeline";

const shortTimestampFormatter = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const fullTimestampFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });

const USER_TIMELINE_VISIBLE_ITEM_COUNT = 18;
const USER_TIMELINE_EDGE_MARGIN = 4;
const USER_TIMELINE_SYNC_THROTTLE_MS = 180;
const CONVERSATION_RAIL_SYNC_THROTTLE_MS = 120;

type UserPromptTimelinePrompt = Pick<UserPromptTimelineItem, "id" | "index" | "text">;

const partialStreamNoticeBodies = [
  "You opened this chat while the assistant was already replying. The complete answer will appear shortly.",
  "We joined mid-sentence. Holding the curtain until the full reply is ready.",
  "The assistant started before this tab arrived. We’ll show the full answer when it lands.",
  "Catching the reply in one piece — no spoilers, no half-answers.",
  "The tokens are still assembling themselves. Full answer incoming.",
  "We arrived fashionably late to this response. The complete version will appear soon.",
] as const;

function randomPartialStreamNoticeBody(): string {
  return partialStreamNoticeBodies[Math.floor(Math.random() * partialStreamNoticeBodies.length)] ?? partialStreamNoticeBodies[0];
}

function clampPercent(value: number): number {
  return clampNumber(value, 0, 100);
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

@customElement("chat-view")
export class ChatView extends LitElement {
  @property({ attribute: false }) messages: ChatLine[] = [];
  @property() sessionId = "";
  @property({ type: Number }) messageStart = 0;
  @property({ type: Number }) messageEnd = 0;
  @property({ type: Number }) messageTotal = 0;
  @property({ type: Boolean }) hasMore = false;
  @property({ type: Boolean }) loadingMore = false;
  @property({ type: Boolean }) isReceivingPartialStream = false;
  @property({ type: Boolean }) isCompacting = false;
  @property({ type: Number }) pendingMessageCount = 0;
  @property({ attribute: false }) status?: SessionStatus;
  @property({ attribute: false }) activity?: SessionActivity;
  @property({ attribute: false }) onLoadMore?: () => void;
  @property({ attribute: false }) onContinueFromLastToolResult?: () => void;
  @query(".chat") private chat?: HTMLDivElement;
  @state() private pinnedToBottom = true;
  @state() private expandedMetaKey: string | undefined;
  @state() private copiedMessageKey: string | undefined;
  @state() private currentConversationIndex: number | undefined;
  @state() private currentTimelineUserIndex: number | undefined;
  @state() private timelineWindowStartIndex = 0;
  private readonly disclosures = new ChatDisclosureController();
  private readonly scrollController = new ChatScrollController();
  private suppressScrollSave = false;
  private suppressLoadMoreRequests = false;
  private loadMoreCheckFrame: number | undefined;
  private scrollToBottomFrame: number | undefined;
  private conversationRailFrame: number | undefined;
  private conversationRailTimer: number | undefined;
  private timelineSyncTimer: number | undefined;
  private pendingTimelineConversationIndex: number | undefined;
  private visibleArticleObserver: IntersectionObserver | undefined;
  private readonly observedArticleElements = new Set<HTMLElement>();
  private readonly visibleArticleIndexes = new Set<number>();
  private primaryArticleElementsCache: HTMLElement[] = [];
  private articleElementsCache: HTMLElement[] = [];
  private scrollAnchorElementsCache: HTMLElement[] = [];
  private scrollMarkerElementsCache: HTMLElement[] = [];
  private scrollElementCacheDirty = true;
  private groupedMessagesInput?: ChatLine[];
  private groupedMessagesStart = 0;
  private groupedMessagesCache: ChatGroup[] = [];
  private userPromptTimelineInput?: ChatLine[];
  private userPromptTimelineStart = 0;
  private userPromptTimelineCache: UserPromptTimelinePrompt[] = [];
  private readonly messageMetaCache = new WeakMap<ChatLine, { short: string; full: string }>();
  private readonly messageCopyTextCache = new WeakMap<ChatLine, string>();
  private partialStreamNoticeBody: string | undefined;
  private lastScrollTop = 0;
  private lastClientHeight = 0;
  private touchStartY: number | undefined;
  private pendingScrollRestoreSessionId: string | undefined;
  private pendingScrollRestorePosition: ChatAnchorScrollPosition | undefined;
  private restoreScrollFrame: number | undefined;
  private prependRestoreToken = 0;
  @state() private loadMoreRequested = false;
  private readonly onViewportResize = () => {
    if (this.pinnedToBottom) this.scrollToBottom();
    else this.lastClientHeight = this.chat?.clientHeight ?? 0;
  };
  private readonly onPageHide = () => {
    this.saveScrollPosition();
  };

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("resize", this.onViewportResize);
    window.addEventListener("pagehide", this.onPageHide);
    window.visualViewport?.addEventListener("resize", this.onViewportResize);
  }

  protected override firstUpdated(): void {
    this.lastClientHeight = this.chat?.clientHeight ?? 0;
  }

  override disconnectedCallback(): void {
    this.saveScrollPosition();
    this.scrollController.dispose();
    this.prependRestoreToken += 1;
    if (this.restoreScrollFrame !== undefined) cancelAnimationFrame(this.restoreScrollFrame);
    if (this.loadMoreCheckFrame !== undefined) cancelAnimationFrame(this.loadMoreCheckFrame);
    if (this.scrollToBottomFrame !== undefined) cancelAnimationFrame(this.scrollToBottomFrame);
    if (this.conversationRailFrame !== undefined) cancelAnimationFrame(this.conversationRailFrame);
    if (this.conversationRailTimer !== undefined) window.clearTimeout(this.conversationRailTimer);
    if (this.timelineSyncTimer !== undefined) window.clearTimeout(this.timelineSyncTimer);
    this.disconnectVisibleArticleObserver();
    window.removeEventListener("resize", this.onViewportResize);
    window.removeEventListener("pagehide", this.onPageHide);
    window.visualViewport?.removeEventListener("resize", this.onViewportResize);
    super.disconnectedCallback();
  }

  private savePreviousSessionScrollPosition(previousSessionId: unknown): void {
    if (typeof previousSessionId !== "string" || previousSessionId === "" || previousSessionId === this.sessionId) return;
    this.saveScrollPosition(previousSessionId);
  }

  private prepareSessionUiState(): void {
    this.disclosures.syncSession(this.sessionId);
    this.scrollController.clearScheduledSave();
    this.suppressScrollSave = false;
    this.suppressLoadMoreRequests = false;
    this.pendingScrollRestoreSessionId = undefined;
    this.pendingScrollRestorePosition = undefined;
    this.prependRestoreToken += 1;
    if (this.restoreScrollFrame !== undefined) {
      cancelAnimationFrame(this.restoreScrollFrame);
      this.restoreScrollFrame = undefined;
    }
  }

  protected override willUpdate(changed: Map<string, unknown>): void {
    if (changed.has("sessionId")) {
      this.savePreviousSessionScrollPosition(changed.get("sessionId"));
      this.prepareSessionUiState();
    }
    if (changed.has("isReceivingPartialStream") || (changed.has("sessionId") && this.isReceivingPartialStream)) this.syncPartialStreamNoticeBody();
    if (changed.has("messages")) this.pinnedToBottom = this.pinnedToBottom && (this.didChatHeightChange() || this.isNearBottom());
  }

  protected override update(changed: Map<string, unknown>): void {
    const prependAnchor = this.isPrependingMessages(changed) ? this.capturePrependScrollAnchor() : undefined;
    super.update(changed);
    if (prependAnchor !== undefined) this.restorePrependScrollAnchor(prependAnchor);
  }

  protected override updated(changed: Map<string, unknown>): void {
    if (changed.has("loadingMore") && !this.loadingMore) this.loadMoreRequested = false;
    if (changed.has("hasMore") && !this.hasMore) this.loadMoreRequested = false;
    if (changed.has("sessionId")) this.forceScrollToLatest();
    if (!changed.has("sessionId") && this.didRefreshLatestPage(changed)) this.forceScrollToLatest();
    else if (!changed.has("sessionId") && changed.has("messages") && this.pinnedToBottom) this.scrollToBottom();
    if (changed.has("messages") || changed.has("messageStart") || changed.has("messageTotal") || changed.has("hasMore") || changed.has("loadingMore")) {
      this.refreshScrollElementCache();
      this.scheduleConversationRailUpdate({ immediate: true });
    }
    if (changed.has("messages") || changed.has("messageStart") || changed.has("hasMore") || changed.has("loadingMore")) this.continuePendingScrollRestore();
    if (changed.has("messages") || changed.has("hasMore") || changed.has("loadingMore")) this.requestLoadMoreIfNeeded();
  }

  override render() {
    const groups = this.groupedMessages();
    return html`
      <div class="chat-wrap">
        ${this.renderConversationRail()}
        ${this.renderUserPromptTimeline()}
        <div class="chat" @scroll=${() => { this.onScroll(); }} @wheel=${(event: WheelEvent) => { this.onWheel(event); }} @touchstart=${(event: TouchEvent) => { this.onTouchStart(event); }} @touchmove=${(event: TouchEvent) => { this.onTouchMove(event); }}>
          ${this.renderHistoryBoundary()}
          ${repeat(
            groups,
            (group) => group.kind === "message" ? this.messageAnchorKey(group.index) : this.groupRenderKey(group.startIndex),
            (group, index) => group.kind === "message"
              ? this.renderMessage(group.message, group.index)
              : this.renderMessageGroup(group.messages, group.startIndex, group.endIndex, this.isLiveTailGroup(groups, index)),
          )}
          ${this.renderQueuedMessages()}
          ${this.renderSessionActivity()}
          ${this.renderWorkflowPauseNotice()}
        </div>
        ${this.renderActivityDock()}
      </div>
    `;
  }

  private groupedMessages(): ChatGroup[] {
    if (this.groupedMessagesInput === this.messages && this.groupedMessagesStart === this.messageStart) return this.groupedMessagesCache;
    this.groupedMessagesInput = this.messages;
    this.groupedMessagesStart = this.messageStart;
    this.groupedMessagesCache = groupChatMessages(this.messages, this.messageStart);
    return this.groupedMessagesCache;
  }

  private isLiveTailGroup(groups: ChatGroup[], index: number): boolean {
    return index === groups.length - 1 && this.isSessionLive();
  }

  private isSessionLive(): boolean {
    return this.status?.isStreaming === true
      || this.status?.isCompacting === true
      || this.status?.isBashRunning === true
      || this.activity?.phase === "active";
  }

  private renderActivityDock() {
    const state = this.activityState();
    if (state === undefined) return null;
    const active = state !== "idle" || this.activity?.phase === "active";
    return html`
      <div class=${active ? "activity-dock active" : "activity-dock"} aria-live="polite">
        <span class="dot"></span>
        <span class="activity-text">${this.activityText(state)}</span>
      </div>
    `;
  }

  private renderQueuedMessages() {
    const queued = this.status?.queuedMessages ?? [];
    if (queued.length === 0) return null;
    return html`
      <aside class="queued-messages" aria-live="polite">
        <div class="queued-header">
          <strong>Queued messages</strong>
          <small>${queued.length} pending · Stop clears the queue</small>
        </div>
        ${queued.map((message, index) => html`
          <div class="queued-message">
            <span class="queued-kind">${message.kind === "steer" ? "Steer" : "Follow-up"} ${String(index + 1)}</span>
            <formatted-text .text=${message.text}></formatted-text>
          </div>
        `)}
      </aside>
    `;
  }

  private renderWorkflowPauseNotice() {
    if (!this.isPausedAfterToolResult()) return null;
    return html`
      <aside class="workflow-pause-notice" aria-live="polite">
        <div>
          <strong>Workflow paused after tool output</strong>
          <span>The session is idle with no pending gate. If this was a formal workflow, continue from the last retained tool result instead of rerunning earlier steps.</span>
        </div>
        <button type="button" @click=${() => this.onContinueFromLastToolResult?.()}>Continue from last tool result</button>
      </aside>
    `;
  }

  private isPausedAfterToolResult(): boolean {
    if (this.status?.isStreaming === true || this.status?.isCompacting === true || this.status?.isBashRunning === true) return false;
    if ((this.status?.pendingMessageCount ?? 0) > 0) return false;
    if (this.isReceivingPartialStream || this.loadingMore) return false;
    const lastMessage = this.messages.at(-1);
    if (lastMessage === undefined) return false;
    return lastMessage.role === "tool" || lastMessage.parts.some((part) => part.type === "toolResult" || part.type === "toolExecution");
  }

  private renderSessionActivity() {
    if (this.isReceivingPartialStream) return html`
      <aside class="session-activity receiving" aria-live="polite">
        <strong>Catching up…</strong>
        <span>${this.currentPartialStreamNoticeBody()}</span>
      </aside>
    `;
    if (!this.isCompacting) return null;
    return html`
      <aside class="session-activity compacting" aria-live="polite">
        <strong>Compacting history…</strong>
        <span>The agent is summarizing earlier context. New prompts will be queued until compaction finishes.</span>
        ${this.pendingMessageCount > 0 ? html`<small>${this.pendingMessageCount} queued ${this.pendingMessageCount === 1 ? "message" : "messages"}</small>` : null}
      </aside>
    `;
  }

  private syncPartialStreamNoticeBody(): void {
    this.partialStreamNoticeBody = this.isReceivingPartialStream ? randomPartialStreamNoticeBody() : undefined;
  }

  private currentPartialStreamNoticeBody(): string {
    this.partialStreamNoticeBody ??= randomPartialStreamNoticeBody();
    return this.partialStreamNoticeBody;
  }

  private activityState(): string | undefined {
    const status = this.status;
    if (status === undefined) return this.activity?.label;
    if (status.isCompacting) return "compacting";
    if (status.isBashRunning) return "bash";
    if (status.isStreaming) return "running";
    if (status.pendingMessageCount > 0) return "queued";
    return "idle";
  }

  private activityText(state: string): string {
    const activity = this.activity;
    if (activity === undefined) return state;
    if (state !== "idle" && activity.phase === "idle") return state;
    return activity.detail !== undefined && activity.detail !== "" ? `${activity.label}: ${activity.detail}` : activity.label;
  }

  private renderConversationRail() {
    if (!this.messages.length || this.messageTotal <= 0) return null;
    const total = this.conversationDisplayTotal();
    const position = this.conversationPositionPercent(total);
    const loadedPercent = this.hasMore ? clampPercent((this.messages.length / total) * 100) : 100;
    return html`<conversation-meter .positionPercent=${position} .loadedPercent=${loadedPercent}></conversation-meter>`;
  }

  private renderUserPromptTimeline() {
    const items = this.userPromptTimelineItems();
    if (items.length === 0) return null;
    return html`<user-prompt-timeline .items=${items} .onJump=${(index: number) => { this.jumpToMessage(index); }}></user-prompt-timeline>`;
  }

  private userPromptTimelineItems(): UserPromptTimelineItem[] {
    const prompts = this.userPromptTimelinePrompts();
    if (prompts.length === 0) return [];

    const currentIndex = this.currentConversationIndex ?? (this.pinnedToBottom ? this.messageStart + this.messages.length - 1 : this.messageStart);
    const activeIndex = this.currentTimelineUserIndex ?? this.userPromptTimelinePosition(currentIndex, prompts)?.index ?? prompts[0]?.index;
    if (activeIndex === undefined) return [];

    const timelineStart = this.clampedTimelineWindowStart(this.timelineWindowStartIndex, prompts.length);
    return prompts.slice(timelineStart, timelineStart + USER_TIMELINE_VISIBLE_ITEM_COUNT).map((prompt) => ({
      ...prompt,
      active: prompt.index === activeIndex,
    }));
  }

  private userPromptTimelinePrompts(): UserPromptTimelinePrompt[] {
    if (this.userPromptTimelineInput === this.messages && this.userPromptTimelineStart === this.messageStart) return this.userPromptTimelineCache;
    this.userPromptTimelineInput = this.messages;
    this.userPromptTimelineStart = this.messageStart;
    this.userPromptTimelineCache = this.messages.flatMap((message, offset): UserPromptTimelinePrompt[] => {
      if (message.role !== "user") return [];
      const text = this.firstTextPart(message);
      if (text === "") return [];
      const index = this.messageStart + offset;
      return [{ id: `user:${String(index)}`, index, text }];
    });
    return this.userPromptTimelineCache;
  }

  private centeredTimelineWindowStart(activePosition: number, totalItems: number): number {
    if (totalItems <= USER_TIMELINE_VISIBLE_ITEM_COUNT) return 0;
    const leadingItems = Math.floor((USER_TIMELINE_VISIBLE_ITEM_COUNT - 1) / 2);
    return Math.min(Math.max(0, activePosition - leadingItems), totalItems - USER_TIMELINE_VISIBLE_ITEM_COUNT);
  }

  private clampedTimelineWindowStart(start: number, totalItems: number): number {
    if (totalItems <= USER_TIMELINE_VISIBLE_ITEM_COUNT) return 0;
    return Math.min(Math.max(0, start), totalItems - USER_TIMELINE_VISIBLE_ITEM_COUNT);
  }

  private firstTextPart(message: ChatLine): string {
    return message.parts.find((part): part is Extract<ChatPart, { type: "text" }> => part.type === "text")?.text.trim() ?? "";
  }

  private jumpToMessage(index: number): void {
    const anchor = this.chat?.querySelector<HTMLElement>(`[data-scroll-anchor-id="${this.messageAnchorKey(index)}"]`);
    anchor?.scrollIntoView({ block: "start", behavior: "smooth" });
  }

  private conversationDisplayTotal(): number {
    if (!this.hasMore && this.messageStart === 0) return Math.max(1, this.messages.length);
    return Math.max(1, this.messageTotal, this.messageStart + this.messages.length);
  }

  private conversationPositionPercent(total = this.conversationDisplayTotal()): number {
    if (total <= 1) return 100;
    const fallbackIndex = this.pinnedToBottom ? this.messageStart + this.messages.length - 1 : this.messageStart;
    const index = clampNumber(this.currentConversationIndex ?? fallbackIndex, 0, total - 1);
    return clampPercent((index / (total - 1)) * 100);
  }

  private renderHistoryBoundary() {
    const range = this.historyRangeLabel();
    if (this.loadingMore) return html`<div class="history-boundary"><span>Loading earlier messages…</span>${range}</div>`;
    if (this.hasMore) return html`
      <div class="history-boundary">
        <button type="button" class="history-load-button" ?disabled=${this.loadMoreRequested} @click=${() => { this.requestLoadMore(); }}>Load earlier messages</button>
        <span>Scroll up to load earlier messages</span>
        ${range}
      </div>
    `;
    if (this.messages.length) return html`<div class="history-boundary"><span>Beginning of session</span>${range}</div>`;
    return null;
  }

  private historyRangeLabel() {
    if (!this.messages.length || this.messageTotal <= 0) return null;
    const from = this.messageStart + 1;
    const to = this.loadedRawMessageEnd();
    const total = Math.max(this.messageTotal, to);
    return html`<small>Showing messages ${from}–${to} of ${total}</small>`;
  }

  private loadedRawMessageEnd(): number {
    return Math.max(this.messageEnd, this.messageStart + this.messages.length);
  }

  private renderMessage(message: ChatLine, index: number) {
    const toolOnly = this.isToolExecutionOnlyMessage(message);
    return html`
      ${this.renderScrollMarker(this.messageScrollMarkerId(index))}
      <article class=${toolOnly ? "msg tool-execution-shell" : `msg ${message.role}`} data-index=${index} data-scroll-anchor-id=${this.messageAnchorKey(index)}>
        ${toolOnly ? null : this.renderMessageHeader(message, String(index))}
        ${message.parts.map((part) => this.renderPart(part, message))}
      </article>
    `;
  }

  private isToolExecutionOnlyMessage(message: ChatLine): boolean {
    return message.role === "tool" && message.parts.length > 0 && message.parts.every((part) => part.type === "toolExecution");
  }

  private renderMessageGroup(messages: ChatLine[], startIndex: number, endIndex: number, defaultOpen: boolean) {
    const disclosureKey = this.groupDisclosureKey(startIndex, endIndex, defaultOpen);
    const open = this.disclosures.isOpen(disclosureKey, defaultOpen);
    return html`
      ${this.renderScrollMarker(this.groupScrollMarkerId(endIndex))}
      <details class=${defaultOpen ? "msg event-group live" : "msg event-group"} data-index=${startIndex} data-scroll-anchor-id=${this.groupAnchorKey(startIndex)} ?open=${open} @toggle=${(event: Event) => { this.onGroupToggle(disclosureKey, event, defaultOpen); }}>
        <summary>
          <b class="label">${defaultOpen ? "live events" : "events"}</b>
          <span>${summarizeChatGroup(messages)}</span>
        </summary>
        ${open ? this.renderMessageGroupBody(messages, startIndex) : null}
      </details>
    `;
  }

  private renderMessageGroupBody(messages: ChatLine[], startIndex: number) {
    return html`
      <div class="group-body">
        ${messages.map((message, offset) => {
          const toolOnly = this.isToolExecutionOnlyMessage(message);
          return html`
            <section class=${toolOnly ? "group-msg tool-execution-shell" : `group-msg ${message.role}`} data-index=${startIndex + offset} data-scroll-anchor-id=${this.eventAnchorKey(startIndex + offset)}>
              ${toolOnly ? null : this.renderMessageHeader(message, `${String(startIndex)}:${String(offset)}`)}
              ${message.parts.map((part) => this.renderPart(part, message))}
            </section>
          `;
        })}
      </div>
    `;
  }

  private renderScrollMarker(markerId: string) {
    return html`<span class="scroll-marker" data-marker-id=${markerId} aria-hidden="true"></span>`;
  }

  private renderMessageHeader(message: ChatLine, key: string) {
    const meta = this.messageMetaLabel(message);
    const expanded = this.expandedMetaKey === key;
    return html`
      <div class="msg-header">
        <b class="label">${message.role}</b>
        <div class="msg-header-trailing">
          ${this.renderMessageActions(message, key)}
          <span class=${expanded ? "msg-meta expanded" : "msg-meta"} role="button" tabindex="0" title=${meta.full} aria-label=${meta.full} aria-expanded=${String(expanded)} @click=${() => { this.expandedMetaKey = expanded ? undefined : key; }} @keydown=${(event: KeyboardEvent) => { this.onMetaKeydown(event, key, expanded); }}>${meta.short}</span>
        </div>
      </div>
    `;
  }

  private renderMessageActions(message: ChatLine, key: string) {
    if (!this.isCopyableMessage(message)) return null;
    const copied = this.copiedMessageKey === key;
    return html`
      <div class="msg-actions" aria-label="Message actions">
        <button type="button" class="msg-action" title=${copied ? "Copied" : "Copy message"} aria-label=${`${copied ? "Copied" : "Copy"} ${message.role} message`} @click=${(event: MouseEvent) => { void this.copyMessage(message, key, event); }}>
          <span aria-hidden="true">${copied ? "✓" : "⧉"}</span>
        </button>
      </div>
    `;
  }

  private onMetaKeydown(event: KeyboardEvent, key: string, expanded: boolean) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    this.expandedMetaKey = expanded ? undefined : key;
  }

  private isCopyableMessage(message: ChatLine): boolean {
    return (message.role === "user" || message.role === "assistant") && this.messageCopyText(message) !== "";
  }

  private messageCopyText(message: ChatLine): string {
    const cached = this.messageCopyTextCache.get(message);
    if (cached !== undefined) return cached;
    const text = message.parts
      .filter((part): part is Extract<ChatPart, { type: "text" }> => part.type === "text")
      .map((part) => part.text.trim())
      .filter((partText) => partText !== "")
      .join("\n\n");
    this.messageCopyTextCache.set(message, text);
    return text;
  }

  private async copyMessage(message: ChatLine, key: string, event: MouseEvent): Promise<void> {
    event.stopPropagation();
    const ok = await this.writeClipboard(this.messageCopyText(message));
    if (!ok) return;
    this.copiedMessageKey = key;
    window.setTimeout(() => {
      if (this.copiedMessageKey === key) this.copiedMessageKey = undefined;
    }, 1200);
  }

  private async writeClipboard(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }

  private messageMetaLabel(message: ChatLine): { short: string; full: string } {
    const cached = this.messageMetaCache.get(message);
    if (cached !== undefined) return cached;
    const timestamp = message.meta?.timestamp;
    const model = this.modelLabel(message);
    if (timestamp === undefined && model === undefined) {
      const empty = { short: "no info", full: "No Pi message metadata available" };
      this.messageMetaCache.set(message, empty);
      return empty;
    }
    const time = timestamp === undefined ? undefined : this.formatTimestamp(timestamp);
    const parts = [time?.short, model].filter((part): part is string => part !== undefined && part !== "");
    const fullParts = [time?.full, model === undefined ? undefined : `Model: ${model}`].filter((part): part is string => part !== undefined && part !== "");
    const label = { short: parts.join(" · "), full: fullParts.join(" · ") };
    this.messageMetaCache.set(message, label);
    return label;
  }

  private formatTimestamp(timestamp: string): { short: string; full: string } | undefined {
    const date = new Date(timestamp);
    if (!Number.isFinite(date.getTime())) return undefined;
    return { short: shortTimestampFormatter.format(date), full: fullTimestampFormatter.format(date) };
  }

  private modelLabel(message: ChatLine): string | undefined {
    const model = message.meta?.model;
    if (model === undefined) return undefined;
    const id = model.responseId ?? model.id;
    if (id === undefined || id === "") return model.provider;
    return model.provider !== undefined && model.provider !== "" ? `${model.provider}/${id}` : id;
  }

  private renderPart(part: ChatPart, message?: ChatLine) {
    if (part.type === "text" && message?.role === "bash") return html`<pre class="part shell-output">${part.text}</pre>`;
    if (part.type === "text") return html`<formatted-text class="part" .text=${part.text}></formatted-text>`;
    if (part.type === "thinking") return html`<details class="part"><summary>thinking</summary><formatted-text .text=${part.text}></formatted-text></details>`;
    if (part.type === "skillInvocation") return html`
      <details class="part skill-invocation">
        <summary><b>[skill]</b> ${part.name}</summary>
        <small>${part.location}</small>
        <formatted-text .text=${part.content}></formatted-text>
      </details>
    `;
    if (part.type === "skillRead") return html`
      <div class="part skill-read">
        <strong>Loaded ${part.name}</strong>
        <small>read ${part.path}</small>
      </div>
    `;
    if (part.type === "toolCall") return html`<div class="part tool-line">▶ ${part.toolName}<span class="summary">${part.summary}</span></div>`;
    if (part.type === "toolExecution") return html`<tool-execution-view class="part" .execution=${part}></tool-execution-view>`;
    if (part.type === "toolResult") return html`
      <details class="part" ?open=${part.isError}>
        <summary>${part.isError ? "✖" : "✓"} ${part.toolName} result</summary>
        <formatted-text .text=${part.text}></formatted-text>
      </details>
    `;
    if (part.type === "attachmentSummary") return html`
      <div class="part attachment-summary">
        <strong>Attachments</strong>
        <ul>
          ${part.attachments.map((attachment) => html`<li><span>${attachment.filename}${attachment.warnings.length === 0 ? "" : ` — ${attachment.warnings.join("; ")}`}</span><small>${attachment.kind} · ${this.formatBytes(attachment.size)} · ${attachment.status}</small></li>`)}
        </ul>
      </div>
    `;
    if (part.type === "roundUsage") return html`
      <div class="part round-usage" title=${this.roundUsageTitle(part.usage)}>
        <span class="round-usage-chip" data-label="input">${formatTokenCount(part.usage.total.tokens.input)}</span>
        <span class="round-usage-chip" data-label="output">${formatTokenCount(part.usage.total.tokens.output)}</span>
        <span class="round-usage-chip" data-label="cache read">${formatTokenCount(part.usage.total.tokens.cacheRead)}</span>
        <span class="round-usage-chip" data-label="cache write">${formatTokenCount(part.usage.total.tokens.cacheWrite)}</span>
        ${part.usage.childRuns > 0 ? html`<span class="round-usage-chip child" data-label="child">${formatTokenCount(part.usage.child.tokens.total)} · ${part.usage.childRuns}</span>` : null}
        <span class="round-usage-chip" data-label="total">${formatTokenCount(part.usage.total.tokens.total)}</span>
        <span class="round-usage-chip" data-label="cost">${formatCost(part.usage.total.cost)}</span>
        ${part.usage.status === "partial" ? html`<span class="round-usage-chip partial" data-label="status">partial</span>` : null}
      </div>
    `;
    return null;
  }

  private roundUsageTitle(usage: Extract<ChatPart, { type: "roundUsage" }>["usage"]): string {
    const parent = `Parent: input ${formatTokenCount(usage.parent.tokens.input)} / output ${formatTokenCount(usage.parent.tokens.output)} / total ${formatTokenCount(usage.parent.tokens.total)}`;
    const child = usage.children.length === 0
      ? "Child: none"
      : usage.children.map((item, index) => `${item.role ?? `child ${String(index + 1)}`}: ${formatTokenCount(item.tokens.total)}${item.hasUsage ? "" : " (no usage reported)"}`).join("; ");
    return `${parent}\n${child}`;
  }

  private formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return "unknown size";
    if (bytes < 1024) return `${String(bytes)} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  private onGroupToggle(key: string, event: Event, defaultOpen: boolean) {
    const details = event.currentTarget;
    if (!(details instanceof HTMLDetailsElement)) return;
    if (!this.disclosures.applyToggle(key, details.open, defaultOpen)) return;
    this.scrollElementCacheDirty = true;
    this.requestUpdate();
    void this.updateComplete.then(() => {
      this.refreshScrollElementCache();
      this.scheduleConversationRailUpdate({ immediate: true });
    });
  }

  private onScroll() {
    this.requestLoadMoreIfNeeded();
    this.updatePinnedToBottomFromScroll();
    this.scheduleConversationRailUpdate();
    if (!this.suppressScrollSave) this.scheduleScrollPositionSave();
  }

  private onWheel(event: WheelEvent) {
    if (event.deltaY < 0 && this.canScrollUp()) this.pinnedToBottom = false;
  }

  private onTouchStart(event: TouchEvent) {
    this.touchStartY = event.touches[0]?.clientY;
  }

  private onTouchMove(event: TouchEvent) {
    const y = event.touches[0]?.clientY;
    if (this.touchStartY !== undefined && y !== undefined && y > this.touchStartY && this.canScrollUp()) this.pinnedToBottom = false;
  }

  private updatePinnedToBottomFromScroll() {
    const chat = this.chat;
    if (!chat) return;
    const heightChanged = this.didChatHeightChange();
    const wasPinnedToBottom = this.pinnedToBottom;
    const scrollingUp = chat.scrollTop < this.lastScrollTop;
    if (heightChanged && wasPinnedToBottom) {
      this.lastClientHeight = chat.clientHeight;
      this.scrollToBottom();
      return;
    }
    if (this.isAtBottom()) this.pinnedToBottom = true;
    else if (scrollingUp) this.pinnedToBottom = false;
    else this.pinnedToBottom = this.isNearBottom();
    this.lastScrollTop = chat.scrollTop;
    this.lastClientHeight = chat.clientHeight;
  }

  private didChatHeightChange(): boolean {
    const chat = this.chat;
    return chat !== undefined && this.lastClientHeight !== 0 && chat.clientHeight !== this.lastClientHeight;
  }

  private isPrependingMessages(changed: Map<string, unknown>): boolean {
    const oldMessageStart = changed.get("messageStart");
    return typeof oldMessageStart === "number" && this.messageStart < oldMessageStart;
  }

  private requestLoadMoreIfNeeded(): void {
    if (this.loadMoreCheckFrame !== undefined) return;
    this.loadMoreCheckFrame = requestAnimationFrame(() => {
      this.loadMoreCheckFrame = undefined;
      if (this.suppressLoadMoreRequests) return;
      const chat = this.chat;
      if (!chat) return;
      if (shouldRequestEarlierMessages({
        hasMore: this.hasMore,
        loadingMore: this.loadingMore || this.loadMoreRequested,
        canRequest: this.onLoadMore !== undefined,
        scrollTop: chat.scrollTop,
        scrollHeight: chat.scrollHeight,
        clientHeight: chat.clientHeight,
      })) this.requestLoadMore();
    });
  }

  private requestLoadMore(): void {
    if (this.loadMoreRequested) return;
    if (!this.hasMore || this.loadingMore || this.onLoadMore === undefined) return;
    this.loadMoreRequested = true;
    this.onLoadMore();
  }

  private isNearBottom(): boolean {
    const chat = this.chat;
    if (!chat) return true;
    return isNearScrollBottom(chat);
  }

  private isAtBottom(): boolean {
    const chat = this.chat;
    if (!chat) return true;
    return distanceFromScrollBottom(chat) < 2;
  }

  private canScrollUp(): boolean {
    const chat = this.chat;
    return chat !== undefined && chat.scrollTop > 0;
  }

  private didRefreshLatestPage(changed: Map<string, unknown>): boolean {
    return !this.loadingMore
      && (changed.has("messageEnd") || changed.has("messageTotal"))
      && this.messageTotal > 0
      && this.messageEnd >= this.messageTotal;
  }

  private forceScrollToLatest(): void {
    this.pinnedToBottom = true;
    this.pendingScrollRestoreSessionId = undefined;
    this.pendingScrollRestorePosition = undefined;
    if (this.restoreScrollFrame !== undefined) {
      cancelAnimationFrame(this.restoreScrollFrame);
      this.restoreScrollFrame = undefined;
    }
    if (this.scrollToBottomFrame !== undefined) {
      cancelAnimationFrame(this.scrollToBottomFrame);
      this.scrollToBottomFrame = undefined;
    }
    this.scrollToBottom({ settle: true });
  }

  private scrollToBottom(options?: { settle?: boolean | undefined }) {
    if (this.scrollToBottomFrame !== undefined) return;
    const settle = options?.settle === true;
    const token = settle ? this.prependRestoreToken + 1 : undefined;
    if (token !== undefined) {
      this.prependRestoreToken = token;
      this.suppressLoadMoreRequests = true;
    }
    let frames = 0;
    const apply = () => {
      this.scrollToBottomFrame = undefined;
      const chat = this.chat;
      if (token !== undefined && token !== this.prependRestoreToken) return;
      if (!chat) {
        if (token !== undefined) this.suppressLoadMoreRequests = false;
        return;
      }
      this.withSuppressedScrollSave(() => {
        chat.scrollTop = chat.scrollHeight;
        this.lastScrollTop = chat.scrollTop;
        this.lastClientHeight = chat.clientHeight;
      });
      frames += 1;
      if (settle && frames < PREPEND_RESTORE_SETTLE_FRAMES) {
        this.scrollToBottomFrame = requestAnimationFrame(apply);
        return;
      }
      if (token !== undefined) {
        requestAnimationFrame(() => {
          if (token === this.prependRestoreToken) this.suppressLoadMoreRequests = false;
        });
      }
    };
    this.scrollToBottomFrame = requestAnimationFrame(() => {
      this.scrollToBottomFrame = undefined;
      apply();
    });
  }

  restoreScrollPosition() {
    const sessionId = this.sessionId;
    if (this.restoreScrollFrame !== undefined) cancelAnimationFrame(this.restoreScrollFrame);
    this.restoreScrollFrame = requestAnimationFrame(() => {
      this.restoreScrollFrame = undefined;
      if (this.sessionId !== sessionId) return;
      this.withSuppressedScrollSave(() => {
        const result = this.scrollController.restorePosition(sessionId, this.chat, this.scrollAnchorElements(), { fallbackToBottom: this.shouldFallbackToBottomForMissingAnchor() });
        this.handleScrollRestoreResult(sessionId, result);
      });
    });
  }

  private continuePendingScrollRestore(): void {
    const sessionId = this.pendingScrollRestoreSessionId;
    const position = this.pendingScrollRestorePosition;
    if (sessionId === undefined || position === undefined || sessionId !== this.sessionId || this.restoreScrollFrame !== undefined) return;
    this.restoreScrollFrame = requestAnimationFrame(() => {
      this.restoreScrollFrame = undefined;
      if (this.sessionId !== sessionId) return;
      this.withSuppressedScrollSave(() => {
        const result = this.scrollController.restoreExplicitPosition(position, this.chat, this.scrollAnchorElements(), { fallbackToBottom: this.shouldFallbackToBottomForMissingAnchor() });
        this.handleScrollRestoreResult(sessionId, result);
      });
    });
  }

  private handleScrollRestoreResult(sessionId: string, result: ChatScrollRestoreResult): void {
    this.syncScrollMetrics();
    if (result.status !== "missing") {
      this.updatePinnedToBottomAfterRestore(result.status);
      if (result.status === "restored" || result.status === "bottom") this.cancelPrependRestore();
      this.pendingScrollRestoreSessionId = undefined;
      this.pendingScrollRestorePosition = undefined;
      return;
    }

    this.pinnedToBottom = false;
    this.pendingScrollRestoreSessionId = sessionId;
    this.pendingScrollRestorePosition = result.position;
    const chat = this.chat;
    if (chat === undefined || !this.hasMore || this.loadingMore) return;
    chat.scrollTop = 0;
    this.syncScrollMetrics();
    this.requestLoadMore();
  }

  private shouldFallbackToBottomForMissingAnchor(): boolean {
    // While catching up to a stream, history can temporarily omit the in-flight
    // assistant message that a previous scroll save anchored to. Keep retrying
    // until the final refreshed transcript has a chance to render that anchor.
    return !this.hasMore && !this.isReceivingPartialStream;
  }

  private updatePinnedToBottomAfterRestore(status: Exclude<ChatScrollRestoreResult["status"], "missing">): void {
    if (status === "bottom") this.pinnedToBottom = true;
    else if (status === "restored") this.pinnedToBottom = this.isNearBottom();
  }

  private syncScrollMetrics(): void {
    const chat = this.chat;
    if (chat === undefined) return;
    this.lastScrollTop = chat.scrollTop;
    this.lastClientHeight = chat.clientHeight;
  }

  private cancelPrependRestore(): void {
    this.prependRestoreToken += 1;
    this.suppressLoadMoreRequests = false;
  }

  capturePrependScrollAnchor(): PrependScrollAnchor | undefined {
    const chat = this.chat;
    if (!chat) return undefined;
    return capturePrependScrollAnchor(chat, this.scrollMarkers());
  }

  restorePrependScrollAnchor(anchor: PrependScrollAnchor | undefined): void {
    if (!this.chat || !anchor) return;
    this.suppressLoadMoreRequests = true;
    this.suppressScrollSave = true;
    const token = this.prependRestoreToken + 1;
    this.prependRestoreToken = token;
    let frames = 0;
    const settle = () => {
      const chat = this.chat;
      if (!chat || token !== this.prependRestoreToken) return;
      restorePrependScrollAnchor(chat, anchor, anchor.markerId === undefined ? undefined : this.scrollMarkerAt(anchor.markerId));
      this.lastScrollTop = chat.scrollTop;
      frames += 1;
      // Formatted markdown/code layout can settle after Lit's first render. Re-apply
      // the marker anchor briefly so late height changes above the viewport do not
      // move the user's reading position.
      if (frames < PREPEND_RESTORE_SETTLE_FRAMES) {
        requestAnimationFrame(settle);
        return;
      }
      requestAnimationFrame(() => {
        if (token !== this.prependRestoreToken) return;
        this.suppressScrollSave = false;
        this.suppressLoadMoreRequests = false;
      });
    };
    settle();
  }

  saveScrollPosition(sessionId = this.sessionId) {
    if (!sessionId) return;
    this.scrollController.savePosition(sessionId, this.chat, this.scrollAnchorElements());
  }

  private scheduleScrollPositionSave() {
    const sessionId = this.sessionId;
    this.scrollController.scheduleSave(sessionId, (scheduledSessionId) => {
      if (this.sessionId === scheduledSessionId) this.saveScrollPosition(scheduledSessionId);
    });
  }

  private scheduleConversationRailUpdate(options?: { immediate?: boolean | undefined }): void {
    if (options?.immediate === true) {
      if (this.conversationRailTimer !== undefined) {
        window.clearTimeout(this.conversationRailTimer);
        this.conversationRailTimer = undefined;
      }
      if (this.conversationRailFrame !== undefined) return;
      this.conversationRailFrame = requestAnimationFrame(() => {
        this.conversationRailFrame = undefined;
        this.updateConversationRailPosition();
      });
      return;
    }

    if (this.conversationRailTimer !== undefined || this.conversationRailFrame !== undefined) return;
    this.conversationRailTimer = window.setTimeout(() => {
      this.conversationRailTimer = undefined;
      this.conversationRailFrame = requestAnimationFrame(() => {
        this.conversationRailFrame = undefined;
        this.updateConversationRailPosition();
      });
    }, CONVERSATION_RAIL_SYNC_THROTTLE_MS);
  }

  private updateConversationRailPosition(): void {
    if (!this.messages.length || this.messageTotal <= 0) {
      this.setCurrentConversationIndex(undefined);
      this.applyTimelineConversationIndex(undefined);
      return;
    }
    const total = this.conversationDisplayTotal();
    const article = this.firstVisibleArticle();
    const index = Number(article?.dataset["index"]);
    const conversationIndex = Number.isFinite(index)
      ? clampNumber(index, 0, Math.max(0, total - 1))
      : clampNumber(this.pinnedToBottom ? this.messageStart + this.messages.length - 1 : this.messageStart, 0, Math.max(0, total - 1));
    this.setCurrentConversationIndex(conversationIndex);
    this.scheduleTimelineConversationIndex(conversationIndex);
  }

  private setCurrentConversationIndex(index: number | undefined): void {
    if (this.currentConversationIndex === index) return;
    this.currentConversationIndex = index;
  }

  private scheduleTimelineConversationIndex(index: number): void {
    this.pendingTimelineConversationIndex = index;
    if (this.currentTimelineUserIndex === undefined) {
      this.applyPendingTimelineConversationIndex();
      return;
    }
    if (this.timelineSyncTimer !== undefined) return;
    this.timelineSyncTimer = window.setTimeout(() => {
      this.timelineSyncTimer = undefined;
      this.applyPendingTimelineConversationIndex();
    }, USER_TIMELINE_SYNC_THROTTLE_MS);
  }

  private applyPendingTimelineConversationIndex(): void {
    const index = this.pendingTimelineConversationIndex;
    this.pendingTimelineConversationIndex = undefined;
    this.applyTimelineConversationIndex(index);
  }

  private applyTimelineConversationIndex(index: number | undefined): void {
    const prompts = this.userPromptTimelinePrompts();
    if (index === undefined || prompts.length === 0) {
      if (this.currentTimelineUserIndex !== undefined) this.currentTimelineUserIndex = undefined;
      if (this.timelineWindowStartIndex !== 0) this.timelineWindowStartIndex = 0;
      return;
    }

    const position = this.userPromptTimelinePosition(index, prompts);
    if (position === undefined) return;
    const nextWindowStart = this.nextTimelineWindowStart(position.position, prompts.length);
    if (this.currentTimelineUserIndex !== position.index) this.currentTimelineUserIndex = position.index;
    if (this.timelineWindowStartIndex !== nextWindowStart) this.timelineWindowStartIndex = nextWindowStart;
  }

  private userPromptTimelinePosition(index: number, prompts = this.userPromptTimelinePrompts()): { index: number; position: number } | undefined {
    if (prompts.length === 0) return undefined;
    let low = 0;
    let high = prompts.length - 1;
    let result = 0;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const prompt = prompts[mid];
      if (prompt === undefined) break;
      if (prompt.index <= index) {
        result = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    const prompt = prompts[result];
    return prompt === undefined ? undefined : { index: prompt.index, position: result };
  }

  private nextTimelineWindowStart(activePosition: number, totalItems: number): number {
    const currentStart = this.clampedTimelineWindowStart(this.timelineWindowStartIndex, totalItems);
    if (totalItems <= USER_TIMELINE_VISIBLE_ITEM_COUNT) return 0;
    const currentEnd = currentStart + USER_TIMELINE_VISIBLE_ITEM_COUNT;
    const insideStableWindow = activePosition >= currentStart + USER_TIMELINE_EDGE_MARGIN
      && activePosition < currentEnd - USER_TIMELINE_EDGE_MARGIN;
    if (insideStableWindow) return currentStart;
    return this.centeredTimelineWindowStart(activePosition, totalItems);
  }

  private scrollMarkers(): HTMLElement[] {
    this.ensureScrollElementCache();
    return this.scrollMarkerElementsCache;
  }

  private scrollMarkerAt(markerId: string): HTMLElement | undefined {
    this.ensureScrollElementCache();
    return this.scrollMarkerElementsCache.find((marker) => marker.dataset["markerId"] === markerId);
  }

  private firstVisibleArticle(): HTMLElement | undefined {
    this.ensureScrollElementCache();
    return this.firstObservedVisibleArticle()
      ?? this.firstVisibleArticleByRects(this.primaryArticleElementsCache)
      ?? this.firstVisibleArticleByRects(this.articleElementsCache);
  }

  private articles(): HTMLElement[] {
    this.ensureScrollElementCache();
    return this.articleElementsCache;
  }

  private scrollAnchorElements(): HTMLElement[] {
    this.ensureScrollElementCache();
    return this.scrollAnchorElementsCache;
  }

  private ensureScrollElementCache(): void {
    if (!this.scrollElementCacheDirty) return;
    this.refreshScrollElementCache();
  }

  private refreshScrollElementCache(): void {
    this.primaryArticleElementsCache = Array.from(this.renderRoot.querySelectorAll<HTMLElement>("article.msg"));
    this.articleElementsCache = Array.from(this.renderRoot.querySelectorAll<HTMLElement>("article.msg, details.msg"));
    this.scrollAnchorElementsCache = Array.from(this.renderRoot.querySelectorAll<HTMLElement>("[data-scroll-anchor-id]"));
    this.scrollMarkerElementsCache = Array.from(this.renderRoot.querySelectorAll<HTMLElement>(".scroll-marker"));
    this.scrollElementCacheDirty = false;
    this.syncVisibleArticleObserver();
  }

  private syncVisibleArticleObserver(): void {
    const chat = this.chat;
    if (chat === undefined || typeof IntersectionObserver === "undefined") {
      this.disconnectVisibleArticleObserver();
      return;
    }

    this.visibleArticleObserver ??= new IntersectionObserver((entries) => {
        for (const entry of entries) {
          const element = entry.target;
          if (!(element instanceof HTMLElement)) continue;
          const index = Number(element.dataset["index"]);
          if (!Number.isFinite(index)) continue;
          if (entry.isIntersecting) this.visibleArticleIndexes.add(index);
          else this.visibleArticleIndexes.delete(index);
        }
        this.scheduleConversationRailUpdate();
      }, { root: chat, threshold: 0 });

    const nextObserved = new Set(this.articleElementsCache);
    for (const element of this.observedArticleElements) {
      if (nextObserved.has(element)) continue;
      this.visibleArticleObserver.unobserve(element);
      this.observedArticleElements.delete(element);
      const index = Number(element.dataset["index"]);
      if (Number.isFinite(index)) this.visibleArticleIndexes.delete(index);
    }
    for (const element of nextObserved) {
      if (this.observedArticleElements.has(element)) continue;
      this.visibleArticleObserver.observe(element);
      this.observedArticleElements.add(element);
    }
  }

  private disconnectVisibleArticleObserver(): void {
    this.visibleArticleObserver?.disconnect();
    this.visibleArticleObserver = undefined;
    this.observedArticleElements.clear();
    this.visibleArticleIndexes.clear();
  }

  private firstObservedVisibleArticle(): HTMLElement | undefined {
    if (this.visibleArticleIndexes.size === 0) return undefined;
    const firstIndex = Math.min(...this.visibleArticleIndexes);
    return this.articleElementsCache.find((article) => Number(article.dataset["index"]) === firstIndex);
  }

  private firstVisibleArticleByRects(articles: HTMLElement[]): HTMLElement | undefined {
    const chat = this.chat;
    if (chat === undefined || articles.length === 0) return undefined;
    return findFirstVisibleArticle(chat, articles);
  }

  private withSuppressedScrollSave(callback: () => void) {
    this.suppressScrollSave = true;
    callback();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        this.suppressScrollSave = false;
      });
    });
  }

  private groupDisclosureKey(startIndex: number, endIndex: number, defaultOpen: boolean): string {
    return defaultOpen ? `${this.sessionId}:live:${String(startIndex)}` : `${this.sessionId}:${String(endIndex)}`;
  }

  private messageAnchorKey(index: number): string {
    return `m:${String(index)}`;
  }

  private groupRenderKey(startIndex: number): string {
    return `g:${String(startIndex)}`;
  }

  private groupAnchorKey(startIndex: number): string {
    return `g:${String(startIndex)}`;
  }

  private eventAnchorKey(index: number): string {
    return `e:${String(index)}`;
  }

  private messageScrollMarkerId(index: number): string {
    return `m:${String(index)}`;
  }

  private groupScrollMarkerId(endIndex: number): string {
    return `g:${String(endIndex)}`;
  }

  static override styles = chatStyles;
}
