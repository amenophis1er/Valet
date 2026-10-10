/*
 * The agent loop.
 *
 * One run: the owner's goal → model turn → tool calls through the run
 * controller, strictly in order → results back → until the model answers in
 * text, a guard trips (Stop, budget, time), or the controller pauses. Every
 * call id gets exactly one result before the next model turn. State is
 * persisted after every step; a restart mid-run pauses the run, answering any
 * call that may have started with "outcome unknown". The loop also keeps the
 * run's scope and raises the owner's approval cards.
 */

import type { AIChatRequest, AIChatResult, AIContentPart, AIMessage, AIToolCall } from '@amenophis1er/extension-ai-connect/types';
import type { AskReason, Fingerprint, RunController, ToolResult } from '../controller/controller.js';
import { BROWSER_TOOL, describeStep } from '../actions/index.js';
import { Cancellation } from '../executor/protocol.js';
import { SYSTEM_PROMPT, goalMessage, historyView } from './prompt.js';
import { decide, decideSubmission, newScope, nextRun, originOf, reachable, submitVerdict, verdict, type Decision, type Mode, type Scope, type SubmitTarget, type Verdict } from '../scope/scope.js';
import type { Approval, Media, OwnerAttachment, PanelState, RunStatus, TranscriptEntry } from './protocol.js';
import { PDF_TYPE, SAVE_FILE_TOOL, saveFile } from './files.js';
import { attachmentParts, checkAttachments, type Attachment } from './attachments.js';
import { MAX_SKILL_CHARS, applicable, skillsText, type Skill } from '../skills/skills.js';
import type { Note } from '../executor/commands.js';

export const MAX_ACTIONS = 40;
export const MAX_RUN_MS = 20 * 60_000;
/** Waits before sending a model request again after a dropped connection or a server failure. */
const RETRY_DELAYS_MS = [2_000, 5_000];
/** Screenshots the model still sees; older ones become a line of text. */
const MODEL_SCREENSHOTS = 2;
/** Screenshots the owner can still open in the panel: at most this many, and at most this many bytes. */
const KEPT_SCREENSHOTS = 12;
const KEPT_SCREENSHOT_BYTES = 2_500_000;
/** Files kept for download, newest first, up to this many bytes in all. */
const KEPT_FILE_BYTES = 2_000_000;
/** chrome.storage.session holds 10 MB: past this, the conversation must start over before the next model turn. */
const MAX_STATE_CHARS = 4_000_000;
const TOO_LONG = 'This conversation is too long to keep going. Start a new conversation (the + button) to continue.';
const TOO_BIG = 'These attachments would make the conversation too large to keep. Start a new conversation (the + button), or send smaller files.';
/** Errors that mean the model cannot take images, as providers word them. */
const IMAGE_ERROR = /image|vision|multimodal|modalit|media.?type|content.?type|not support|unsupported/i;
const NO_VISION = 'This model could not take images or PDFs, so from now on screenshots and attachments are shown only to you.';
const RESTART_NOTICE = 'The extension restarted during this run. Press Resume to continue: anything that was in flight is treated as uncertain, and the agent will look at the page before acting.';

export interface Connection { id: string; revision: number; label: string; model: string }

export interface LoopDeps {
  chat(request: AIChatRequest, options: { signal: AbortSignal }): Promise<AIChatResult>;
  controller: RunController;
  /** Hand the owner's tab to the session and give earlier ones back. */
  adopt(tabId: number): Promise<void>;
  release(): void;
  /** `close` through the executor: agent tabs closed, the handed tab released. */
  closeTabs(): Promise<void>;
  /** The halo and the agent's cursor in its tabs, while a run is active. */
  highlight(on: boolean): Promise<void>;
  tabInfo(tabId: number): Promise<{ title: string; url: string } | null>;
  /** The tab the conversation works in now (handed or its own), if any. */
  workspace(): Promise<{ title: string; url: string } | null>;
  activeConnection(): Promise<Connection | null>;
  storage: { get(): Promise<Persisted | undefined>; set(value: Persisted): Promise<void>;
    /** Drop the saved state: the conversation is over (`discard`). */
    remove?(): Promise<void> };
  /** The last approval mode the owner chose (chrome.storage.local): the next conversation starts in it. */
  mode: { get(): Promise<Mode>; set(mode: Mode): Promise<void> };
  /** Navigation containment over this session's tabs; cleared whenever no run is active. */
  containment: { apply(origins: string[]): Promise<void>; clear(): Promise<void> };
  /** Screenshots and files, stored apart from the transcript (chrome.storage.session). */
  media: { set(id: string, value: Media): Promise<void>; remove(ids: string[]): Promise<void> };
  /** Chrome prints the Markdown stored under a media id to a PDF, returned as base64 (pdf.ts). */
  pdf: { render(id: string): Promise<string> };
  /** The owner's skills (chrome.storage.sync), read when a run starts. */
  skills: { get(): Promise<Skill[]> };
  /** Learning: every step is explained and waits for the owner. Read before each step, so a change applies at once. */
  learning: { get(): boolean; set(on: boolean): Promise<void> };
  /** Learning: the cursor onto where the step would go, and the bubble saying what it is. Both best effort. */
  preview(args: Record<string, unknown>): Promise<void>;
  note(note: Note | null): Promise<void>;
  emit(state: PanelState): void;
  now?: () => number;
  /** Tests: shorter waits before sending a failed model request again. */
  retryDelaysMs?: number[];
}

export interface Persisted {
  history: AIMessage[];
  transcript: TranscriptEntry[];
  status: RunStatus;
  pauseReason?: string;
  actions: number;
  startedAt: number;
  connection: Connection | null;
  handedTab: { title: string; url: string } | null;
  /** This conversation's approvals: nothing here outlives it. */
  scope: Scope;
  /** A card the owner has not answered yet. */
  approval?: Approval;
  /** The model rejected images: screenshots go only to the owner for the rest of the conversation. */
  noVision?: boolean;
  /** The tab the conversation works in now, for the panel's "Will continue in". */
  workspace?: { title: string; url: string } | null;
  /** Skills already in this conversation's history: a site the agent comes back to does not repeat them. */
  usedSkillIds?: string[];
  /** Learning: the step waiting for the owner's Next. */
  stepWait?: { text: string; why?: string };
  /** Messages the owner sent mid-run, not yet given to the model: a restart must not lose them. */
  amendments?: Array<string | AIContentPart[]>;
}

/** The most of the model's own words shown as a step's "why". */
const WHY_CHARS = 240;

/** What "Save as skill" proposes; the owner edits and saves it, or not. */
export interface SkillDraft { name: string; sites: string[]; text: string }
/** The most the model may write for a skill draft: what a skill may hold, so nothing it writes is lost. */
export const DRAFT_CHARS = MAX_SKILL_CHARS;

/** At most `max` characters, cut at a line break when the text runs over, so a step is never left half written. */
export function trimDraft(text: string, max = DRAFT_CHARS): string {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf('\n', max);
  return (cut > max / 2 ? text.slice(0, cut) : text.slice(0, max)).trim();
}

function empty(): Persisted {
  return { history: [], transcript: [], status: 'idle', actions: 0, startedAt: 0, connection: null, handedTab: null, scope: newScope() };
}

/** A tool result's outcome, for the transcript and for `is_error`. */
type Outcome = Extract<TranscriptEntry, { kind: 'action' }>['outcome'];

function outcomeOf(result: ToolResult): Outcome {
  if ('skipped' in result) return 'skipped';
  if ('refused' in result) return 'refused';
  if ('completed' in result && result.completed === 'unknown') return 'unknown';
  if ('error' in result && !('completed' in result)) return 'error';
  return 'ok';
}

/** One line about what an action led to, for the expandable row in the panel. */
function detailOf(result: ToolResult): string {
  const r = result as Record<string, unknown>;
  const text = (key: string) => (typeof r[key] === 'string' ? (r[key] as string) : '');
  if (text('refused')) return text('refused');
  if (text('skipped')) return text('skipped');
  if (text('message')) return text('message');
  const observation = r['observation'] as { title?: string; url?: string } | undefined;
  if (observation) return `${observation.title || '(untitled)'} — ${observation.url ?? ''}`;
  return text('error') || (r['closed'] ? 'Closed the agent\'s tabs.' : '');
}

/** A stored screenshot, as its transcript entry names it. */
type KeptImage = { id: string; width: number; height: number; bytes: number };

function hasImage(message: AIMessage): boolean {
  return Array.isArray(message.content) && message.content.some((part) => part.type === 'image' || part.type === 'document');
}

/** The same message with its images and documents replaced by a line saying so. */
function withoutImages<M extends AIMessage>(message: M): M {
  if (!Array.isArray(message.content) || !hasImage(message)) return message;
  const text = message.content.filter((part): part is Extract<AIContentPart, { type: 'text' }> => part.type === 'text').map((part) => part.text);
  const what = message.role === 'tool' ? '(The screenshot was not sent to you: you do not know what it shows. Use observe to read the page.)' : '(attached images and PDFs not included: this model cannot read them)';
  return { ...message, content: [...text, what].join('\n') };
}

export class AgentLoop {
  #deps: LoopDeps;
  #now: () => number;
  #state: Persisted = empty();
  #amendments: Array<string | AIContentPart[]> = [];
  #abort?: AbortController;
  #cancel?: Cancellation;
  #stopRequested = false;
  #running?: Promise<void>;
  /** A start or a resume is under way (its checks await before the status says running): a second message meanwhile joins the run. */
  #starting = false;
  /** The target of the submission card on screen, to record the answer against. */
  #cardTarget?: SubmitTarget;
  /** The resolver of the card on screen; lost on a restart (the card is then re-raised by the next check). */
  #resolveCard?: (decision: Decision) => void;

  constructor(deps: LoopDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => Date.now());
  }

  get state(): PanelState {
    const s = this.#state;
    return { status: s.status, ...(s.pauseReason ? { pauseReason: s.pauseReason } : {}), transcript: s.transcript,
      handedTab: s.handedTab, connection: s.connection ? { label: s.connection.label, model: s.connection.model } : null, actions: s.actions,
      ...(s.approval ? { approval: s.approval } : {}), mode: s.scope.mode, workspace: s.workspace ?? null,
      ...(s.stepWait ? { stepWait: s.stepWait } : {}), learning: this.#deps.learning.get() };
  }

  /** Learning on or off, from the composer. Off while a step waits lets that step go. */
  async setLearning(on: boolean): Promise<void> {
    await this.#deps.learning.set(on);
    if (!on) this.step();
    this.#deps.emit(this.state);
  }

  /* ---- Learning: one step at a time ---- */

  /** The resolver of the step the loop is waiting with; lost on a restart (the run is then paused). */
  #resolveStep?: () => void;
  /** A bubble ("Doing it…") is still in the page from the last step; the next step replaces it, or takes it away if Learning went off. */
  #noted = false;

  /** The owner's Next: the waiting step goes ahead. Nothing waiting, nothing happens. */
  step(): void {
    const resolve = this.#resolveStep;
    this.#resolveStep = undefined;
    resolve?.();
  }

  /**
   * In Learning, before an action: show where it goes and what it is, and wait
   * for Next. Reads (observe, screenshot) never wait. A Stop while waiting lets
   * the call through to the controller, which skips it as stopped.
   */
  async #awaitStep(args: Record<string, unknown>, targets: ReadonlyArray<{ ref: string; role: string; name: string }>, why: string | undefined): Promise<void> {
    if (!this.#deps.learning.get() || ['observe', 'screenshot'].includes(String(args['action']))) {
      if (this.#noted && !this.#deps.learning.get()) { this.#noted = false; await this.#deps.note(null).catch(() => undefined); }
      return;
    }
    const text = describeStep(args, targets, false);
    const s = this.#state;
    // The waiter exists before the owner can see Next: a click during the preview is never lost.
    const proceed = this.#stopRequested ? undefined : new Promise<void>((resolve) => { this.#resolveStep = resolve; });
    s.stepWait = { text, ...(why ? { why } : {}) };
    await this.#save();
    await this.#deps.preview(args).catch(() => undefined);
    await this.#deps.note({ text, ...(why ? { why } : {}), waiting: true }).catch(() => undefined);
    // Learning went off while the step was being shown: no wait after all.
    if (!this.#deps.learning.get()) this.step();
    if (proceed) await proceed;
    s.stepWait = undefined;
    this.#noted = !this.#stopRequested;
    await this.#deps.note(this.#stopRequested ? null : { text, ...(why ? { why } : {}), waiting: false }).catch(() => undefined);
    await this.#save();
  }

  /* ---- approvals: the controller's gate ---- */

  verdict(origin: string): Verdict {
    return verdict(origin, this.#state.scope);
  }

  /** Show a card and wait for the owner. The decision is recorded before the promise resolves. */
  ask(origin: string, reason: AskReason): Promise<Decision> {
    // A Stop while the card is up answers it as Deny; nothing is dispatched.
    if (this.#stopRequested) return Promise.resolve('deny');
    this.#resolveCard?.('deny');
    const approval: Approval = { id: `a-${this.#now()}-${Math.random().toString(36).slice(2, 8)}`, kind: 'origin', origin, reason };
    this.#state.approval = approval;
    this.#note(reason === 'blocked' ? `The page tried to go to ${origin}. Allow it?` : `Asking you about ${origin}.`);
    void this.#save();
    return new Promise((resolve) => { this.#resolveCard = resolve; });
  }

  submitVerdict(target: SubmitTarget): Verdict {
    return submitVerdict(target, this.#state.scope);
  }

  /** The submission card: where the form goes and what the agent filled in. Asked in Auto too. */
  askSubmit(fingerprint: Fingerprint): Promise<Decision> {
    if (this.#stopRequested) return Promise.resolve('deny');
    this.#resolveCard?.('deny');
    this.#cardTarget = { pageOrigin: fingerprint.frameOrigin, action: fingerprint.action, method: fingerprint.method };
    const approval: Approval = {
      id: `s-${this.#now()}-${Math.random().toString(36).slice(2, 8)}`, kind: 'submit', origin: fingerprint.frameOrigin, reason: 'submit',
      submit: { action: fingerprint.action, method: fingerprint.method, submitter: fingerprint.submitter?.name ?? '', fields: fingerprint.fields },
    };
    this.#state.approval = approval;
    this.#note(`Asking you before submitting a form to ${fingerprint.action}.`);
    void this.#save();
    return new Promise((resolve) => { this.#resolveCard = resolve; });
  }

  /** The owner answered a card. An answer for any other card (or none) is ignored. */
  async decide(id: string, decision: Decision): Promise<void> {
    const approval = this.#state.approval;
    if (!approval || approval.id !== id) return;
    if (approval.kind === 'submit') {
      // Auto never covers forms: an "auto" answer here counts as once.
      const answer: Decision = decision === 'auto' ? 'once' : decision;
      if (this.#cardTarget) this.#state.scope = decideSubmission(this.#state.scope, this.#cardTarget, answer);
      this.#cardTarget = undefined;
      this.#state.approval = undefined;
      this.#note(answer === 'deny' ? 'Denied the form submission.'
        : answer === 'chat' ? `Allowed submissions to ${approval.submit?.action} for this conversation.` : 'Allowed this form submission.');
      await this.#save();
      const resolve = this.#resolveCard;
      this.#resolveCard = undefined;
      resolve?.(answer);
      return;
    }
    this.#state.scope = decide(this.#state.scope, approval.origin, decision);
    if (decision === 'auto') await this.#deps.mode.set('auto');
    await this.#contain();
    this.#state.approval = undefined;
    this.#note(decision === 'deny' ? `Denied ${approval.origin}.`
      : decision === 'chat' ? `Allowed ${approval.origin} for this conversation.`
        : decision === 'auto' ? 'Auto is on: sites are approved without asking for the rest of this conversation, and so are searches and filters. A form that sends data still asks.'
          : `Allowed ${approval.origin} for this request.`);
    await this.#save();
    const resolve = this.#resolveCard;
    this.#resolveCard = undefined;
    resolve?.(decision);
  }

  /** Turn Auto on or off from the panel; the next conversation starts in the same mode. */
  async setMode(mode: Mode): Promise<void> {
    if (this.#state.scope.mode === mode) return;
    this.#state.scope = { ...this.#state.scope, mode };
    await this.#deps.mode.set(mode);
    // In a conversation, the change is part of its story; before one, the composer shows it.
    if (this.#state.transcript.length > 0) this.#note(mode === 'auto' ? 'Auto is on: sites are approved without asking, and so are searches and filters. A form that sends data still asks.' : 'Auto is off: the agent asks before each new site again.');
    await this.#contain();
    await this.#save();
  }

  /** Containment and the halo follow the run: while it runs, rules and the halo; none otherwise. In Auto no site is blocked. */
  async #contain(): Promise<void> {
    if (this.#state.status === 'running') {
      const origins = reachable(this.#state.scope);
      if (origins) await this.#deps.containment.apply(origins); else await this.#deps.containment.clear();
      await this.#deps.highlight(true).catch(() => undefined);
    } else {
      await this.#deps.containment.clear();
      await this.#deps.highlight(false).catch(() => undefined);
    }
  }

  /** Called by the executor before any tab navigates, so the rules cover it first. */
  async beforeNavigate(): Promise<void> {
    await this.#contain();
  }

  /** Load persisted state. A run that was going when the worker died is paused. */
  async restore(): Promise<void> {
    const saved = await this.#deps.storage.get();
    if (!saved) {
      this.#state = { ...empty(), scope: newScope(await this.#deps.mode.get()) };
      await this.#deps.containment.clear();
      return;
    }
    // State saved before approvals became per conversation has no mode: start it fresh.
    const scope = saved.scope && 'mode' in saved.scope ? saved.scope : newScope(await this.#deps.mode.get());
    this.#state = { ...saved, scope };
    this.#amendments = saved.amendments ?? [];
    // A card that was up when the worker died is re-raised by the next check after Resume; a step waiting is raised again too.
    this.#state.approval = undefined;
    this.#state.stepWait = undefined;
    if (saved.status !== 'running') return;
    this.#answerDangling('The extension restarted while this action was running. Its outcome is unknown. Observe before acting and do not repeat a submission.');
    this.#state.status = 'paused';
    this.#state.pauseReason = RESTART_NOTICE;
    this.#note(RESTART_NOTICE);
    await this.#deps.containment.clear();
    await this.#save();
  }

  /**
   * A goal while idle starts a run. While a run is going (or starting), it is
   * an amendment for the next model turn; while paused, it resumes the run
   * with the message, so what the owner says after a pause is never swallowed.
   */
  async run(goal: string, tabId?: number, useNewTab = false, attachments: Attachment[] = [], skillIds: string[] = []): Promise<void> {
    const text = goal.trim() || (attachments.length > 0 ? 'Look at what I attached.' : '');
    if (!text) return;
    const refused = checkAttachments(attachments);
    if (refused) {
      this.#note(refused);
      await this.#save();
      return;
    }
    // What the conversation would hold with these attachments, amendments still queued included.
    const attached = attachments.reduce((sum, attachment) => sum + (attachment.data?.length ?? 0), 0);
    if (this.#storedChars() + attached > MAX_STATE_CHARS) {
      this.#note(attached > 0 ? TOO_BIG : TOO_LONG);
      await this.#save();
      return;
    }
    // Decided before anything awaits: two quick sends can never start two loops on one conversation.
    if (this.#starting || this.#state.status === 'running') return this.#amend(goal, text, attachments, skillIds);
    if (this.#state.status === 'paused') {
      this.#starting = true;
      try {
        await this.#amend(goal, text, attachments, skillIds);
        await this.#resumeRun();
      } finally {
        this.#starting = false;
      }
      return this.#running;
    }
    this.#starting = true;
    try {
      await this.#start(goal, text, tabId, useNewTab, attachments, skillIds);
    } finally {
      this.#starting = false;
    }
    return this.#running;
  }

  /** The owner's message joins the run: shown now, sent with the next model turn. */
  async #amend(goal: string, text: string, attachments: Attachment[], skillIds: string[]): Promise<void> {
    this.#skills = await this.#deps.skills.get().catch(() => []);
    const shown = await this.#keepAttachments(attachments);
    this.#state.transcript.push({ kind: 'owner', text: goal.trim(), ...(shown.length > 0 ? { attachments: shown } : {}) });
    // Skills the owner names with the message come along; the page's own are already in the history.
    const withNotes = this.#withSkills(text, this.#pickSkills(skillIds, null));
    this.#amendments.push(attachments.length > 0 ? attachmentParts(withNotes, attachments) : withNotes);
    await this.#save();
  }

  async #start(goal: string, text: string, tabId: number | undefined, useNewTab: boolean, attachments: Attachment[], skillIds: string[]): Promise<void> {
    // Shown before anything awaits, so a message sent right after this one lands below it; its attachments are filled in once kept.
    const entry: Extract<TranscriptEntry, { kind: 'owner' }> = { kind: 'owner', text: goal.trim() };
    this.#state.transcript.push(entry);
    this.#skills = await this.#deps.skills.get().catch(() => []);
    const connection = await this.#deps.activeConnection();
    if (!connection) {
      // Not taken: the owner sends it again once connected.
      this.#state.transcript.pop();
      this.#note('Add an AI connection in Settings first.');
      await this.#save();
      return;
    }
    // Where this request works: a tab the owner hands over, a tab of its own, or
    // — with neither — on where the conversation already is.
    const s = this.#state;
    let handed = s.handedTab;
    const continuing = tabId === undefined && !useNewTab;
    if (!continuing) {
      this.#deps.release();
      handed = null;
      if (!useNewTab && tabId !== undefined) {
        try {
          await this.#deps.adopt(tabId);
          handed = await this.#deps.tabInfo(tabId);
        } catch {
          this.#note('This page cannot be used by the agent (only http and https pages can); it will open its own tab.');
        }
      }
    }
    const here = continuing ? await this.#deps.workspace() : null;
    s.connection = connection;
    s.handedTab = handed;
    // A new request keeps the conversation's approvals; its one-request ones start over, with the page the owner handed over.
    const firstRequest = s.history.length === 0;
    s.scope = nextRun(s.scope);
    // The page it starts on is allowed for this request: the one handed over, or the one it continues in.
    const startOrigin = originOf((continuing ? here?.url : handed?.url) ?? '');
    if (startOrigin && verdict(startOrigin, s.scope) !== 'allowed') s.scope = decide(s.scope, startOrigin, 'once');
    if (firstRequest && s.scope.mode === 'auto') this.#note('Auto is on, as in your last conversation: sites are approved without asking, and so are searches and filters. A form that sends data still asks. Change it with the Auto button under the message box.');
    s.status = 'running';
    s.pauseReason = undefined;
    s.actions = 0;
    s.startedAt = this.#now();
    const shown = await this.#keepAttachments(attachments);
    if (shown.length > 0) entry.attachments = shown;
    // The owner's notes for this task: the ones they named, and those for the page it starts on.
    const goalText = this.#withSkills(goalMessage(text, handed, here), this.#pickSkills(skillIds, (continuing ? here?.url : handed?.url) ?? null));
    s.history.push({ role: 'user', content: attachments.length > 0 ? attachmentParts(goalText, attachments) : goalText });
    if (s.noVision && attachments.some((attachment) => attachment.kind === 'image' || attachment.kind === 'pdf')) this.#note(NO_VISION);
    this.#deps.controller.startRun();
    this.#stopRequested = false;
    this.#unknownStep = undefined;
    try {
      await this.#contain();
      await this.#save();
    } catch (error) {
      // Storage refused the new state: the run never starts, and the owner is told.
      s.history.pop();
      s.status = 'idle';
      this.#note(`The run could not start: ${error instanceof Error ? error.message : String(error)}`);
      await this.#contain().catch(() => undefined);
      await this.#save().catch(() => undefined);
      return;
    }
    this.#running = this.#loop();
  }

  /** Continue a paused run: the controller asks for a fresh observation first. */
  async resume(): Promise<void> {
    if (this.#state.status !== 'paused' || this.#starting) return;
    this.#starting = true;
    try {
      await this.#resumeRun();
    } finally {
      this.#starting = false;
    }
    return this.#running;
  }

  async #resumeRun(): Promise<void> {
    this.#skills = await this.#deps.skills.get().catch(() => []);
    this.#deps.controller.resume();
    this.#state.status = 'running';
    this.#state.pauseReason = undefined;
    this.#state.startedAt = this.#now();
    this.#state.actions = 0;
    this.#stopRequested = false;
    this.#unknownStep = undefined;
    await this.#contain();
    await this.#save();
    this.#running = this.#loop();
  }

  /** Stop: abort the model request and the executor command in flight. */
  async stop(): Promise<void> {
    this.#stopRequested = true;
    this.#abort?.abort();
    this.#cancel?.cancel();
    this.step();
    // A card on screen is answered as Deny: nothing it would have allowed is dispatched.
    if (this.#state.approval) await this.decide(this.#state.approval.id, 'deny');
    if (this.#state.status === 'paused') await this.#end('Stopped.');
    await this.#running;
  }

  async newConversation(): Promise<void> {
    await this.stop();
    await this.#deps.closeTabs().catch(() => undefined);
    await this.#deps.media.remove(this.#mediaIds()).catch(() => undefined);
    this.#state = { ...empty(), scope: newScope(await this.#deps.mode.get()) };
    this.#amendments = [];
    await this.#save();
  }

  /** The conversation is over (the tab it was opened on closed): the run stops, its media goes, and nothing of it is kept. Its tabs stay open. */
  async discard(): Promise<void> {
    await this.stop();
    await this.#deps.media.remove(this.#mediaIds()).catch(() => undefined);
    this.#state = { ...empty(), scope: newScope(await this.#deps.mode.get()) };
    this.#amendments = [];
    await this.#deps.storage.remove?.().catch(() => undefined);
    this.#deps.emit(this.state);
  }

  /* ---- skills: the owner's notes, where they apply ---- */

  /** This run's view of the owner's skills; read again when a run starts or resumes. */
  #skills: Skill[] = [];

  /**
   * The skills to put in front of the model now: those the owner named, and
   * the enabled ones for this page — each only once per conversation.
   */
  #pickSkills(named: string[], url: string | null): Skill[] {
    const used = new Set(this.#state.usedSkillIds ?? []);
    const picked = [...this.#skills.filter((skill) => named.includes(skill.id)), ...applicable(this.#skills, url).filter((skill) => !used.has(skill.id))];
    return [...new Map(picked.map((skill) => [skill.id, skill])).values()];
  }

  /** The text with the notes under it, the skills recorded as used and named in the transcript. */
  #withSkills(text: string, skills: Skill[]): string {
    if (skills.length === 0) return text;
    this.#state.usedSkillIds = [...new Set([...(this.#state.usedSkillIds ?? []), ...skills.map((skill) => skill.id)])];
    this.#note(`Using ${skills.length === 1 ? 'skill' : 'skills'}: ${skills.map((skill) => skill.name).join(', ')}`);
    return `${text}\n\n${skillsText(skills)}`;
  }

  /** A page the agent landed on: its skills, if new to this conversation, ride along in the tool result. */
  #notesFor(url: string | undefined): string | undefined {
    const skills = url ? this.#pickSkills([], url) : [];
    if (skills.length === 0) return undefined;
    this.#state.usedSkillIds = [...new Set([...(this.#state.usedSkillIds ?? []), ...skills.map((skill) => skill.id)])];
    this.#note(`Using ${skills.length === 1 ? 'skill' : 'skills'}: ${skills.map((skill) => skill.name).join(', ')}`);
    return skillsText(skills);
  }

  /**
   * "Save as skill": the model writes, from this conversation, a short note
   * for next time — what worked, as steps — for the owner to edit and keep.
   * One request; nothing is saved here.
   */
  async draftSkill(options: { focus?: string; previous?: string } = {}): Promise<SkillDraft | { error: string }> {
    const s = this.#state;
    const goal = s.transcript.find((entry) => entry.kind === 'owner');
    if (!goal || goal.kind !== 'owner' || s.status === 'running') return { error: s.status === 'running' ? 'Wait for the agent to finish first.' : 'There is no conversation to learn from yet.' };
    const connection = s.connection ?? await this.#deps.activeConnection();
    if (!connection) return { error: 'Add an AI connection in Settings first.' };
    // The sites it was about: the page handed over, the one it works in, and every page it read.
    const hosts = new Set<string>();
    const add = (url: string | undefined) => { if (url) { try { hosts.add(new URL(url).hostname); } catch { /* not a url */ } } };
    add(s.handedTab?.url);
    add(s.workspace?.url);
    for (const message of s.history) {
      if (message.role === 'tool' && typeof message.content === 'string') add(/"url":"(https?:\/\/[^"]+)"/.exec(message.content)?.[1]);
    }
    const focus = options.focus?.trim();
    const previous = options.previous?.trim();
    const ask = 'Write a note for a future run of a task like this one, for the owner to keep as a skill. In at most '
      + `${DRAFT_CHARS} characters: what the task was, the steps that worked (imperative, in order), and what to avoid. `
      + 'Name pages and controls, never the values the owner filled in or anything personal. Plain text only, no preamble. '
      + 'Then, on a last line, "NAME: " followed by a title of at most five words.'
      // The owner's steer: what the note is about, or what to change in the draft they have.
      + (previous ? `\n\nThe note as written before:\n${previous}\n\nWrite it again${focus ? `, changed as the owner asks: ${focus}` : ''}.` : '')
      + (focus && !previous ? `\n\nThe owner asks that the note be about this in particular: ${focus}` : '');
    const result = await this.#deps.chat({
      system: SYSTEM_PROMPT, messages: [...this.#view(), { role: 'user', content: ask }],
      connectionId: connection.id, connectionRevision: connection.revision, model: connection.model, maxTokens: 1000,
    }, { signal: new AbortController().signal });
    if (!result.ok || !result.text) return { error: `The model could not write the note: ${result.error ?? 'no answer'}` };
    const lines = result.text.trim().split('\n');
    const nameLine = [...lines].reverse().find((line) => /^\s*NAME:/i.test(line));
    const name = (nameLine ? nameLine.replace(/^\s*NAME:\s*/i, '').trim() : goal.text).replace(/["*]/g, '').slice(0, 60);
    const text = trimDraft(lines.filter((line) => line !== nameLine).join('\n').trim());
    return { name: name || 'New skill', sites: [...hosts], text };
  }

  async #loop(): Promise<void> {
    const s = this.#state;
    const deps = this.#deps;
    let visionProbe = false;
    try {
      for (;;) {
        // Guards before every model turn, not only before calls.
        if (this.#stopRequested) return this.#end('Stopped.');
        if (this.#controllerPaused()) return this.#pause(this.#pauseReason());
        if (s.actions >= MAX_ACTIONS) return this.#end(`Stopped after ${MAX_ACTIONS} browser actions, the limit for one run. Say "continue" to go on.`);
        if (this.#now() - s.startedAt > MAX_RUN_MS) return this.#end('Stopped after 20 minutes, the limit for one run. Say "continue" to go on.');
        if (this.#storedChars() > MAX_STATE_CHARS) return this.#end(TOO_LONG);
        for (const content of this.#amendments.splice(0)) s.history.push({ role: 'user', content });

        this.#abort = new AbortController();
        const connection = s.connection!;
        const ask = () => deps.chat({
          system: SYSTEM_PROMPT, messages: this.#view(), tools: [BROWSER_TOOL, SAVE_FILE_TOOL],
          connectionId: connection.id, connectionRevision: connection.revision, model: connection.model, maxTokens: 8000,
        }, { signal: this.#abort!.signal });
        let result = await ask();
        // A dropped connection or a provider hiccup: the request acted on nothing, so it is sent again, twice at most.
        for (const delay of deps.retryDelaysMs ?? RETRY_DELAYS_MS) {
          if (result.ok || !result.retryable || this.#stopRequested) break;
          this.#note(`${result.error ?? 'The model request failed.'} Trying again…`);
          await this.#save();
          await new Promise((resolve) => setTimeout(resolve, delay));
          if (this.#stopRequested) break;
          result = await ask();
        }
        if (this.#stopRequested) return this.#end('Stopped.');
        // A model that cannot take images fails the whole request: go on without them.
        if (!result.ok && !s.noVision && IMAGE_ERROR.test(result.error ?? '') && this.#view().some(hasImage)) {
          s.noVision = true;
          visionProbe = true;
          continue;
        }
        if (!result.ok) {
          // Without images it failed too: images were not the problem.
          if (visionProbe) s.noVision = false;
          return this.#end(`The model request failed: ${result.error ?? 'unknown error'}`);
        }
        if (visionProbe) { this.#note(NO_VISION); visionProbe = false; }

        s.history.push({ role: 'assistant', ...(result.text ? { content: result.text } : {}),
          ...(result.toolCalls ? { toolCalls: result.toolCalls } : {}),
          ...(result.providerState !== undefined ? { providerState: result.providerState } : {}) });
        if (result.text) s.transcript.push({ kind: 'agent', text: result.text });
        if (!result.toolCalls) {
          if (result.stopReason === 'length') this.#note('The model\'s answer was cut off at its length limit.');
          if (result.stopReason === 'refusal') this.#note('The model declined to continue.');
          // A message the owner sent while this answer was being written: the model hears it before the run ends.
          if (this.#amendments.length > 0) { await this.#save(); continue; }
          return this.#end();
        }
        await this.#save();

        const terminal = await this.#runBatch(result.toolCalls, result.text?.trim().replace(/\s+/g, ' ').slice(0, WHY_CHARS));
        if (terminal === 'stopped') return this.#end('Stopped.');
        if (terminal === 'paused' || this.#controllerPaused()) return this.#pause(this.#pauseReason());
      }
    } catch (error) {
      await this.#end(`Something went wrong: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Run one batch strictly in order; every call gets exactly one result. */
  async #runBatch(calls: AIToolCall[], why?: string): Promise<'stopped' | 'paused' | undefined> {
    const s = this.#state;
    let failed = false;
    let terminal: 'stopped' | 'paused' | undefined;
    for (const call of calls) {
      if (failed || terminal) {
        this.#answer(call, { skipped: 'An earlier call in this batch failed or paused; nothing was dispatched. Observe and decide again.' }, true);
        continue;
      }
      if (call.name === 'save_file' && !call.argsError) {
        try {
          await this.#saveFile(call);
        } catch (error) {
          this.#answer(call, { error: `The file could not be kept: ${error instanceof Error ? error.message : String(error)}`, notice: 'No file was made.' }, true);
          failed = true;
        }
        continue;
      }
      if (call.name !== 'browser') {
        this.#answer(call, { error: `There is no tool named ${call.name}.`, notice: 'Nothing was dispatched.' }, true);
        failed = true;
        continue;
      }
      if (call.argsError) {
        this.#answer(call, { error: `The arguments were not valid JSON: ${call.argsError.message}`, notice: 'Nothing was dispatched.' }, true);
        failed = true;
        continue;
      }
      // The run's limits hold inside a batch too: the rest of it is not run, and the loop ends the run with the reason.
      if (s.actions >= MAX_ACTIONS || this.#now() - s.startedAt > MAX_RUN_MS) {
        this.#answer(call, { skipped: 'The run reached its limit of browser actions or time; nothing was dispatched.' }, true);
        failed = true;
        continue;
      }
      this.#cancel = new Cancellation();
      if (this.#stopRequested) this.#cancel.cancel();
      // Named from the page as the model saw it, before the action changes it.
      const targets = [...this.#deps.controller.latestTargets];
      await this.#awaitStep(call.args ?? {}, targets, why);
      if (this.#stopRequested) this.#cancel.cancel();
      const ran = await this.#deps.controller.run(call.args, this.#cancel);
      const notes = 'observation' in ran && ran.observation ? this.#notesFor(ran.observation.url) : undefined;
      const result: ToolResult = notes ? { ...ran, ownerNotes: notes } as unknown as ToolResult : ran;
      const outcome = outcomeOf(result);
      const detail = detailOf(result);
      let image: KeptImage | undefined;
      if ('screenshot' in result) {
        try {
          image = await this.#keepScreenshot(call, result);
        } catch (error) {
          // Storage refused it: the call still gets its one answer, without the image.
          this.#answer(call, { error: `The screenshot could not be kept: ${error instanceof Error ? error.message : String(error)}`, notice: 'Nothing was dispatched.' }, true);
          s.transcript.push({ kind: 'action', text: describeStep(call.args, targets, false), outcome: 'error', detail: 'The screenshot could not be kept.' });
          failed = true;
          s.actions += 1;
          await this.#save();
          continue;
        }
      }
      if (image) {
        s.transcript.push({ kind: 'action', text: describeStep(call.args, targets, outcome === 'ok'), outcome, image });
        await this.#pruneMedia();
      } else {
        this.#answer(call, result, outcome !== 'ok');
        s.transcript.push({ kind: 'action', text: describeStep(call.args, targets, outcome === 'ok'), outcome, ...(detail ? { detail } : {}) });
      }
      s.actions += 1;
      if ('terminal' in result) terminal = result.terminal;
      else if (outcome !== 'ok' || ('observed' in result && result.observed === false)) failed = true;
      // The step was sent but its outcome is not known: the run pauses, and the owner is told which step and why, in their words.
      if (outcome === 'unknown') this.#unknownStep = { text: describeStep(call.args, targets, false), error: detail };
      await this.#save();
    }
    return terminal;
  }

  /** The step whose outcome is unknown, for the pause that follows it. */
  #unknownStep: { text: string; error: string } | undefined;

  /** Why the run paused, as the owner reads it. */
  #pauseReason(): string {
    const step = this.#unknownStep;
    this.#unknownStep = undefined;
    if (!step) return this.#deps.controller.pauseReason ?? 'Paused.';
    return `The step "${step.text}" was sent to the page, but whether it went through is not known${step.error ? ` (${step.error.replace(/\.$/, '')})` : ''}. Look at the page: if it did, carry on from there; if not, Resume lets the agent look again and retry. It will not repeat a form submission by itself.`;
  }

  /** What the model sees: old page evidence compacted, and no images for a model that cannot take them. */
  #view(): AIMessage[] {
    const view = historyView(this.#state.history);
    return this.#state.noVision ? view.map(withoutImages) : view;
  }

  /**
   * Store the screenshot for the owner, and answer the call with it: the image
   * goes to the model as part of the tool result. Only the newest few stay in
   * the history and in storage.
   */
  async #keepScreenshot(call: AIToolCall, result: Extract<ToolResult, { screenshot: unknown }>): Promise<KeptImage> {
    const { data, mediaType, width, height, masked, id: shotId } = result.screenshot;
    const id = this.#mediaId('shot');
    await this.#deps.media.set(id, { kind: 'image', mediaType, data });
    const text = JSON.stringify({ completed: true, screenshot: { id: shotId, width, height, ...(masked ? { maskedFrames: masked } : {}) },
      message: this.#state.noVision
        ? 'You did not receive this image: you know nothing about what it shows. The owner sees it. To learn what is on the page, use observe.'
        : 'The screenshot is attached and was also shown to the owner.',
      notice: result.notice });
    const content: AIContentPart[] = [{ type: 'text', text }, { type: 'image', mediaType, data }];
    this.#state.history.push({ role: 'tool', toolCallId: call.id, name: call.name, content });
    return { id, width, height, bytes: data.length };
  }

  /** Keep the newest screenshots and files within their budgets; the rest are forgotten. */
  async #pruneMedia(): Promise<void> {
    const s = this.#state;
    // Only screenshots age out; what the owner attached stays with their message.
    const withImages = s.history.filter((message) => message.role === 'tool' && hasImage(message));
    for (const message of withImages.slice(0, -MODEL_SCREENSHOTS)) {
      if (message.role === 'tool') message.content = withoutImages(message).content;
    }
    const expired: string[] = [];
    let shots = 0;
    let shotBytes = 0;
    let fileBytes = 0;
    for (const entry of [...s.transcript].reverse()) {
      if (entry.kind === 'action' && entry.image && !entry.image.expired) {
        shots += 1;
        shotBytes += entry.image.bytes ?? 0;
        if (shots > KEPT_SCREENSHOTS || shotBytes > KEPT_SCREENSHOT_BYTES) { entry.image.expired = true; expired.push(entry.image.id); }
      } else if (entry.kind === 'file' && !entry.expired) {
        fileBytes += entry.bytes;
        if (fileBytes > KEPT_FILE_BYTES) { entry.expired = true; expired.push(entry.id); }
      }
    }
    if (expired.length > 0) await this.#deps.media.remove(expired).catch(() => undefined);
  }

  async #saveFile(call: AIToolCall): Promise<void> {
    const saved = saveFile(call.args);
    if ('error' in saved) {
      this.#answer(call, { error: saved.error, notice: 'No file was made.' }, true);
      await this.#save();
      return;
    }
    const { name, mimeType, content } = saved.file;
    const id = this.#mediaId('file');
    const shown = 'The owner sees the file in the panel with a Download button. It is on their disk only once they click it; do not say it was downloaded.';
    if (mimeType === PDF_TYPE) {
      // The Markdown goes in first: document.html renders it from storage for Chrome to print,
      // and it stays, as a .md, when the PDF cannot be made.
      const source = `${name.replace(/\.pdf$/i, '')}.md`;
      await this.#deps.media.set(id, { kind: 'file', name: source, mimeType: 'text/markdown', content });
      let data: string | undefined;
      let reason = '';
      try { data = await this.#deps.pdf.render(id); }
      catch (error) { reason = error instanceof Error ? error.message : String(error); }
      if (data) {
        await this.#deps.media.set(id, { kind: 'pdf', name, data });
        const bytes = Math.floor(data.length * 3 / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
        this.#state.transcript.push({ kind: 'file', id, name, mimeType, bytes });
        await this.#pruneMedia();
        this.#answer(call, { saved: name, bytes, message: shown }, false);
      } else {
        const bytes = new TextEncoder().encode(content).length;
        this.#state.transcript.push({ kind: 'file', id, name: source, mimeType: 'text/markdown', bytes });
        await this.#pruneMedia();
        this.#answer(call, { saved: source, bytes, message: `The PDF could not be made (${reason || 'unknown reason'}), so the document was saved as Markdown instead; tell the owner. ${shown}` }, false);
      }
      await this.#save();
      return;
    }
    await this.#deps.media.set(id, { kind: 'file', name, mimeType, content });
    const bytes = new TextEncoder().encode(content).length;
    this.#state.transcript.push({ kind: 'file', id, name, mimeType, bytes });
    await this.#pruneMedia();
    this.#answer(call, { saved: name, bytes, message: shown }, false);
    await this.#save();
  }

  /** The persisted state's size, with the amendments waiting for the next turn. */
  #storedChars(): number {
    return JSON.stringify(this.#state).length + this.#amendments.reduce((sum, content) => sum + JSON.stringify(content).length, 0);
  }

  /** Store image attachments so the panel can show them in the owner's message; other files by name only. */
  async #keepAttachments(attachments: Attachment[]): Promise<OwnerAttachment[]> {
    const shown: OwnerAttachment[] = [];
    for (const attachment of attachments) {
      const entry: OwnerAttachment = { kind: attachment.kind, name: attachment.name, bytes: attachment.bytes };
      if (attachment.kind === 'image' && attachment.data) {
        const id = this.#mediaId('attached');
        try {
          // The panel's small copy when it sent one: the full image is already in the history once.
          const data = attachment.thumb && attachment.thumb.length < attachment.data.length ? attachment.thumb : attachment.data;
          await this.#deps.media.set(id, { kind: 'image', mediaType: 'image/jpeg', data });
          Object.assign(entry, { id, width: attachment.width, height: attachment.height });
        } catch { /* shown by name only */ }
      }
      shown.push(entry);
    }
    return shown;
  }

  #mediaId(kind: string): string {
    return `${kind}-${this.#now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /** Every screenshot and file this conversation stored. */
  #mediaIds(): string[] {
    return this.#state.transcript.flatMap((entry) => entry.kind === 'file' ? [entry.id]
      : entry.kind === 'action' && entry.image ? [entry.image.id]
        : entry.kind === 'owner' ? (entry.attachments ?? []).flatMap((attachment) => (attachment.id ? [attachment.id] : [])) : []);
  }

  /** Read fresh each time: the controller pauses itself during a batch. */
  #controllerPaused(): boolean {
    return this.#deps.controller.state === 'paused';
  }

  #answer(call: AIToolCall, result: unknown, isError: boolean): void {
    this.#state.history.push({ role: 'tool', toolCallId: call.id, name: call.name, content: JSON.stringify(result), ...(isError ? { isError: true } : {}) });
  }

  /** After a restart: any call of the last model turn without a result gets "outcome unknown". */
  #answerDangling(text: string): void {
    const history = this.#state.history;
    const lastAssistant = [...history].reverse().find((message) => message.role === 'assistant');
    if (!lastAssistant || lastAssistant.role !== 'assistant' || !lastAssistant.toolCalls) return;
    const answered = new Set(history.filter((message) => message.role === 'tool').map((message) => (message as { toolCallId: string }).toolCallId));
    for (const call of lastAssistant.toolCalls) {
      if (!answered.has(call.id)) this.#answer(call, { completed: 'unknown', error: text, notice: text }, true);
    }
  }

  #note(text: string): void {
    this.#state.transcript.push({ kind: 'notice', text });
  }

  async #pause(reason: string): Promise<void> {
    this.#state.status = 'paused';
    this.#state.pauseReason = reason;
    this.#noted = false;
    await this.#deps.note(null).catch(() => undefined);
    this.#note(`Paused: ${reason}`);
    await this.#contain();
    await this.#saveAtRest();
  }

  /**
   * The save that ends or pauses a run. Storage refusing it (quota) must not
   * leave the panel showing a run that is over: the owner is told, and the
   * state is shown as it is. (A worker restart before the next successful save
   * reads the old state and reports a restart.)
   */
  async #saveAtRest(): Promise<void> {
    try {
      await this.#save();
    } catch (error) {
      this.#note(`The conversation could not be saved (${error instanceof Error ? error.message : String(error)}). It is shown as it is; start a new conversation if this keeps happening.`);
      this.#deps.emit(this.state);
    }
  }

  async #end(notice?: string): Promise<void> {
    if (notice) this.#note(notice);
    this.#state.status = 'idle';
    this.#noted = false;
    this.#unknownStep = undefined;
    await this.#deps.note(null).catch(() => undefined);
    this.#state.pauseReason = undefined;
    this.#abort = undefined;
    this.#cancel = undefined;
    await this.#contain();
    await this.#saveAtRest();
  }

  async #save(): Promise<void> {
    this.#state.workspace = await this.#deps.workspace().catch(() => null);
    if (this.#amendments.length > 0) this.#state.amendments = this.#amendments; else delete this.#state.amendments;
    await this.#deps.storage.set(this.#state);
    this.#deps.emit(this.state);
  }
}
