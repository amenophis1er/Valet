/*
 * The agent loop.
 *
 * One run: the owner's goal → model turn → tool calls through the run
 * controller, strictly in order → results back → until the model answers in
 * text, a guard trips (Stop, budget, time), or the controller pauses. Every
 * call id gets exactly one result before the next model turn. State is
 * persisted after every step; a restart mid-run pauses the run, answering any
 * call that may have started with "outcome unknown".
 *
 * This file is the run itself. Its states and their transitions are in
 * lifecycle.ts; the conversation's other concerns are parts of their own, each
 * given the conversation through a narrow host (host.ts): the owner's
 * approvals (approvals.ts), screenshots, files and attachments (media.ts),
 * skills and "Save as skill" (skill-notes.ts), Learn (learn.ts), and the
 * agent's questions to the owner (ask.ts).
 */

import type { AIChatRequest, AIChatResult, AIContentPart, AIMessage, AIToolCall } from '@amenophis1er/byok/types';
import type { AskReason, Fingerprint, RunController, ToolResult } from '../controller/controller.js';
import { BROWSER_TOOL, describeStep } from '../actions/index.js';
import { Cancellation } from '../executor/protocol.js';
import { targetInTree } from '../controller/observation.js';
import { SYSTEM_PROMPT, goalMessage, historyView } from './prompt.js';
import { decide, newScope, nextRun, originOf, reachable, verdict, type Decision, type Mode, type SubmitTarget, type Verdict } from '../scope/scope.js';
import { RUN_LIMITS, type Media, type PanelState, type RunLimit, type TranscriptEntry } from './protocol.js';
import { SAVE_FILE_TOOL } from './files.js';
import { attachmentParts, checkAttachments, type Attachment } from './attachments.js';
import type { Skill } from '../skills/skills.js';
import type { Note } from '../executor/commands.js';
import { Approvals } from './approvals.js';
import { ASK_TOOL, Questions } from './ask.js';
import type { LoopHost } from './host.js';
import { Learn } from './learn.js';
import { Lifecycle } from './lifecycle.js';
import { MediaKeeper, hasImage, withoutImages, type KeptImage } from './media.js';
import { SkillNotes, type SkillDraft } from './skill-notes.js';
import { empty, type Connection, type Persisted } from './state.js';
import { TRACE_VERSION, Trace, type TraceStore } from './trace.js';

export type { Connection, Persisted } from './state.js';

export { DRAFT_CHARS, trimDraft, type SkillDraft } from './skill-notes.js';

/** The default run limits (Settings → Check in after can raise them; protocol.ts). */
export const MAX_ACTIONS: number = RUN_LIMITS[0].actions;
export const MAX_RUN_MS: number = RUN_LIMITS[0].minutes * 60_000;
/** Waits before sending a model request again after a dropped connection or a server failure. */
const RETRY_DELAYS_MS = [2_000, 5_000];
/** The output cap of a model turn, and the one a turn gets after a reply was cut off at it. */
const MAX_TOKENS = 8_000;
const RAISED_MAX_TOKENS = 16_000;
/** What the model is told after its reply was cut off: nothing of it ran, do it again more briefly. */
const CUT_OFF = 'Your last reply was cut off at the length limit before it was complete, and nothing in it was run. '
  + 'Do it again, more briefly: if you were writing a file, write it in one save_file call with shorter content; keep any thinking short.';
/** chrome.storage.session holds 10 MB: past this, the conversation must start over before the next model turn. */
const MAX_STATE_CHARS = 4_000_000;
const TOO_LONG = 'This conversation is too long to keep going. Start a new conversation (the + button) to continue.';
const TOO_BIG = 'These attachments would make the conversation too large to keep. Start a new conversation (the + button), or send smaller files.';
/** Errors that mean the model cannot take images, as providers word them. */
const IMAGE_ERROR = /image|vision|multimodal|modalit|media.?type|content.?type|not support|unsupported/i;
const NO_VISION = 'This model could not take images or PDFs, so from now on screenshots and attachments are shown only to you.';
const RESTART_NOTICE = 'The extension restarted during this run. Press Resume to continue: anything that was in flight is treated as uncertain, and the agent will look at the page before acting.';


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
  /** How long a run goes before it checks in (Settings), read as a run starts or resumes; the default without it. */
  limit?: { get(): Promise<RunLimit> };
  note(note: Note | null): Promise<void>;
  emit(state: PanelState): void;
  /** Where the run trace is kept, beside the conversation (trace.ts); without it, the trace lives in memory only. */
  trace?: TraceStore;
  now?: () => number;
  /** Tests: shorter waits before sending a failed model request again. */
  retryDelaysMs?: number[];
}


/** The most of the model's own words shown as a step's "why". */
const WHY_CHARS = 240;


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

export class AgentLoop {
  #deps: LoopDeps;
  #now: () => number;
  #state: Persisted = empty();
  #amendments: Array<string | AIContentPart[]> = [];
  #abort?: AbortController;
  #cancel?: Cancellation;
  #running?: Promise<void>;
  /** The run's state machine (lifecycle.ts): every change of status goes through it. */
  #life = new Lifecycle((status) => { this.#state.status = status; }, (from, to) => this.#trace.record({ kind: 'phase', from, to }));
  /** What happened, for diagnosing a run (trace.ts). */
  readonly #trace: Trace;
  /** The model turn this run is on, for the trace; and when the tool call in flight started. */
  #turn = 0;
  #callStarted?: number;
  /** This run's limits, read from the owner's setting as it starts or resumes. */
  #limit: { actions: number; ms: number } = { actions: MAX_ACTIONS, ms: MAX_RUN_MS };
  /** The loop's parts, each owning one concern of the conversation. */
  readonly #approvals: Approvals;
  readonly #media: MediaKeeper;
  readonly #notes: SkillNotes;
  readonly #learn: Learn;
  readonly #questions: Questions;

  constructor(deps: LoopDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => Date.now());
    this.#trace = new Trace(this.#now, deps.trace);
    const host: LoopHost = {
      state: () => this.#state,
      note: (text) => this.#note(text),
      save: () => this.#save(),
      contain: () => this.#contain(),
      answer: (call, result, isError) => this.#answer(call, result, isError),
      now: () => this.#now(),
      trace: (event) => this.#trace.record(event),
    };
    const stopped = () => this.#life.stopRequested;
    this.#approvals = new Approvals(host, deps.mode, stopped);
    this.#media = new MediaKeeper(host, deps);
    this.#notes = new SkillNotes(host, { skills: deps.skills, chat: deps.chat, activeConnection: deps.activeConnection, view: () => this.#view() });
    this.#learn = new Learn(host, deps, stopped);
    this.#questions = new Questions(host, stopped);
  }

  get state(): PanelState {
    const s = this.#state;
    return { status: s.status, ...(s.pauseReason ? { pauseReason: s.pauseReason } : {}), transcript: s.transcript,
      handedTab: s.handedTab, connection: s.connection ? { label: s.connection.label, model: s.connection.model } : null, actions: s.actions,
      ...(s.approval ? { approval: s.approval } : {}), mode: s.scope.mode, workspace: s.workspace ?? null,
      ...(s.stepWait ? { stepWait: s.stepWait } : {}), learning: this.#learn.on, ...(s.question ? { question: s.question } : {}),
      ...(s.atLimit ? { atLimit: true } : {}) };
  }

  /** Learn on or off, from the composer. Off while a step waits lets that step go. */
  async setLearning(on: boolean): Promise<void> {
    await this.#learn.set(on);
    this.#deps.emit(this.state);
  }

  /** The owner's Next in Learn: the waiting step goes ahead. */
  step(): void {
    this.#learn.next();
  }

  /** The owner picked options for the agent's question, or skipped it (`null`). */
  answer(id: string, picked: string[] | null): void {
    this.#questions.pick(id, picked);
  }

  /** The owner's own words for the question `id` ("Something else…"). */
  answerText(id: string, text: string): void {
    this.#questions.type(id, text);
  }

  /* ---- approvals: the controller's gate (approvals.ts) ---- */

  verdict(origin: string): Verdict { return this.#approvals.verdict(origin); }
  ask(origin: string, reason: AskReason): Promise<Decision> { return this.#approvals.ask(origin, reason); }
  submitVerdict(target: SubmitTarget): Verdict { return this.#approvals.submitVerdict(target); }
  askSubmit(fingerprint: Fingerprint): Promise<Decision> { return this.#approvals.askSubmit(fingerprint); }
  /** The owner answered a card. An answer for any other card (or none) is ignored. */
  decide(id: string, decision: Decision): Promise<void> { return this.#approvals.decide(id, decision); }
  /** Turn Auto on or off from the panel; the next conversation starts in the same mode. */
  setMode(mode: Mode): Promise<void> { return this.#approvals.setMode(mode); }

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
    await this.#trace.restore();
    const saved = await this.#deps.storage.get();
    if (!saved) {
      this.#state = { ...empty(), scope: newScope(await this.#deps.mode.get()) };
      this.#life.load('idle');
      await this.#deps.containment.clear();
      return;
    }
    // State saved before approvals became per conversation has no mode: start it fresh.
    const scope = saved.scope && 'mode' in saved.scope ? saved.scope : newScope(await this.#deps.mode.get());
    this.#state = { ...saved, scope };
    this.#life.load(saved.status);
    this.#amendments = saved.amendments ?? [];
    // A card that was up when the worker died is re-raised by the next check after Resume; a step waiting is raised again too.
    this.#state.approval = undefined;
    this.#state.stepWait = undefined;
    this.#state.question = undefined;
    // A step that was going when the worker died never came back: its outcome is not known.
    for (const entry of this.#state.transcript) if (entry.kind === 'action' && entry.outcome === 'pending') entry.outcome = 'unknown';
    if (saved.status !== 'running') return;
    this.#answerDangling('The extension restarted while this action was running. Its outcome is unknown. Observe before acting and do not repeat a submission.');
    this.#life.to('paused');
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
    if (this.#life.busy) return this.#amend(goal, text, attachments, skillIds);
    if (this.#life.phase === 'paused') {
      await this.#starting('paused', async () => {
        await this.#amend(goal, text, attachments, skillIds);
        await this.#resumeRun();
      });
      return this.#running;
    }
    await this.#starting('idle', () => this.#start(goal, text, tabId, useNewTab, attachments, skillIds));
    return this.#running;
  }

  /** Through `starting`: the run goes, or — if it could not start — back to where it was. */
  async #starting(from: 'idle' | 'paused', body: () => Promise<void>): Promise<void> {
    this.#life.to('starting');
    // Continue is offered only until something starts.
    this.#state.atLimit = undefined;
    try {
      await body();
    } finally {
      if (this.#life.phase === 'starting') this.#life.to(from);
    }
  }

  /** The owner's message joins the run: shown now, sent with the next model turn. */
  async #amend(goal: string, text: string, attachments: Attachment[], skillIds: string[]): Promise<void> {
    await this.#notes.refresh();
    const shown = await this.#media.keepAttachments(attachments);
    this.#state.transcript.push({ kind: 'owner', text: goal.trim(), ...(shown.length > 0 ? { attachments: shown } : {}) });
    // Skills the owner names with the message come along; the page's own are already in the history.
    const withNotes = this.#notes.withNotes(text, skillIds, null);
    this.#amendments.push(attachments.length > 0 ? attachmentParts(withNotes, attachments) : withNotes);
    await this.#save();
  }

  /** `carryOn`: Continue after a limit, the same request going on, its one-request approvals and refusals kept. */
  async #start(goal: string, text: string, tabId: number | undefined, useNewTab: boolean, attachments: Attachment[], skillIds: string[], carryOn = false): Promise<void> {
    // Shown before anything awaits, so a message sent right after this one lands below it; its attachments are filled in once kept.
    const entry: Extract<TranscriptEntry, { kind: 'owner' }> = { kind: 'owner', text: goal.trim() };
    this.#state.transcript.push(entry);
    await this.#notes.refresh();
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
    if (!carryOn) s.scope = nextRun(s.scope);
    // The page it starts on is allowed for this request: the one handed over, or the one it continues in.
    const startOrigin = originOf((continuing ? here?.url : handed?.url) ?? '');
    if (startOrigin && verdict(startOrigin, s.scope) !== 'allowed') s.scope = decide(s.scope, startOrigin, 'once');
    this.#turn = 0;
    this.#trace.record({ kind: 'run', goal: text, where: (continuing ? here?.url : handed?.url) ?? (useNewTab ? 'a new tab' : 'its own tab'), mode: s.scope.mode, learn: this.#learn.on, model: `${connection.label} · ${connection.model}` });
    if (firstRequest && s.scope.mode === 'auto') this.#note('Auto is on, as in your last conversation: sites are approved without asking, and so are searches and filters. A form that sends data still asks. Change it with the Auto button under the message box.');
    await this.#readLimit();
    this.#life.to('running');
    s.pauseReason = undefined;
    s.atLimit = undefined;
    s.actions = 0;
    s.startedAt = this.#now();
    const shown = await this.#media.keepAttachments(attachments);
    if (shown.length > 0) entry.attachments = shown;
    // The owner's notes for this task: the ones they named, and those for the page it starts on.
    const goalText = this.#notes.withNotes(goalMessage(text, handed, here), skillIds, (continuing ? here?.url : handed?.url) ?? null);
    s.history.push({ role: 'user', content: attachments.length > 0 ? attachmentParts(goalText, attachments) : goalText });
    if (s.noVision && attachments.some((attachment) => attachment.kind === 'image' || attachment.kind === 'pdf')) this.#note(NO_VISION);
    this.#deps.controller.startRun();
    this.#unknownStep = undefined;
    try {
      await this.#contain();
      await this.#save();
    } catch (error) {
      // Storage refused the new state: the run never starts, and the owner is told.
      s.history.pop();
      this.#life.to('idle');
      this.#note(`The run could not start: ${error instanceof Error ? error.message : String(error)}`);
      await this.#contain().catch(() => undefined);
      await this.#save().catch(() => undefined);
      return;
    }
    this.#running = this.#loop();
  }

  /** Continue after the run stopped at its limit: the request goes on where it was, as the owner's "Continue". */
  async continueRun(): Promise<void> {
    if (this.#life.phase !== 'idle' || !this.#state.atLimit) return;
    await this.#starting('idle', () => this.#start('Continue', 'Continue', undefined, false, [], [], true));
    return this.#running;
  }

  /** Continue a paused run: the controller asks for a fresh observation first. */
  async resume(): Promise<void> {
    if (this.#life.phase !== 'paused') return;
    await this.#starting('paused', () => this.#resumeRun());
    return this.#running;
  }

  async #resumeRun(): Promise<void> {
    await this.#notes.refresh();
    await this.#readLimit();
    this.#deps.controller.resume();
    this.#life.to('running');
    this.#state.pauseReason = undefined;
    this.#state.startedAt = this.#now();
    this.#state.actions = 0;
    this.#unknownStep = undefined;
    await this.#contain();
    await this.#save();
    this.#running = this.#loop();
  }

  /** The owner's run limits, for the run that starts or resumes now. */
  async #readLimit(): Promise<void> {
    const limit = await this.#deps.limit?.get().catch(() => undefined);
    this.#limit = limit ? { actions: limit.actions, ms: limit.minutes * 60_000 } : { actions: MAX_ACTIONS, ms: MAX_RUN_MS };
  }

  /** Stop: abort the model request and the executor command in flight. */
  async stop(): Promise<void> {
    this.#life.requestStop();
    this.#abort?.abort();
    this.#cancel?.cancel();
    this.step();
    this.#questions.release();
    // A card on screen is answered as Deny: nothing it would have allowed is dispatched.
    if (this.#state.approval) await this.decide(this.#state.approval.id, 'deny');
    if (this.#life.phase === 'paused') await this.#end('Stopped.');
    await this.#running;
  }

  async newConversation(): Promise<void> {
    await this.stop();
    await this.#deps.closeTabs().catch(() => undefined);
    await this.#media.forget();
    await this.#trace.clear();
    this.#state = { ...empty(), scope: newScope(await this.#deps.mode.get()) };
    this.#life.load('idle');
    this.#amendments = [];
    await this.#save();
  }

  /** The conversation is over (the tab it was opened on closed): the run stops, its media goes, and nothing of it is kept. Its tabs stay open. */
  async discard(): Promise<void> {
    await this.stop();
    await this.#media.forget();
    await this.#trace.clear();
    this.#state = { ...empty(), scope: newScope(await this.#deps.mode.get()) };
    this.#life.load('idle');
    this.#amendments = [];
    await this.#deps.storage.remove?.().catch(() => undefined);
    this.#deps.emit(this.state);
  }

  /** "Save as skill": a draft the model writes from this conversation, for the owner to edit and keep (skill-notes.ts). */
  draftSkill(options: { focus?: string; previous?: string } = {}): Promise<SkillDraft | { error: string }> {
    return this.#notes.draft(options);
  }

  async #loop(): Promise<void> {
    const s = this.#state;
    const deps = this.#deps;
    let visionProbe = false;
    /** The output cap; raised once in a run after a reply was cut off at it. */
    let maxTokens = MAX_TOKENS;
    let cutOff = 0;
    try {
      for (;;) {
        // Guards before every model turn, not only before calls.
        if (this.#life.stopRequested) return this.#end('Stopped.');
        if (this.#controllerPaused()) return this.#pause(this.#pauseReason());
        if (s.actions >= this.#limit.actions) return this.#end(`Stopped after ${this.#limit.actions} browser actions, the limit for one run. Continue to go on; Settings → Check in after sets the limit.`, true);
        if (this.#now() - s.startedAt > this.#limit.ms) return this.#end(`Stopped after ${Math.round(this.#limit.ms / 60_000)} minutes, the limit for one run. Continue to go on; Settings → Check in after sets the limit.`, true);
        if (this.#storedChars() > MAX_STATE_CHARS) return this.#end(TOO_LONG);
        for (const content of this.#amendments.splice(0)) s.history.push({ role: 'user', content });

        this.#abort = new AbortController();
        const connection = s.connection!;
        const ask = async () => {
          const messages = this.#view();
          this.#turn += 1;
          const turn = this.#turn;
          this.#trace.record({ kind: 'model-request', turn, messages: messages.length, chars: JSON.stringify(messages).length });
          const sent = this.#now();
          const answer = await deps.chat({
            system: SYSTEM_PROMPT, messages, tools: [BROWSER_TOOL, SAVE_FILE_TOOL, ASK_TOOL],
            connectionId: connection.id, connectionRevision: connection.revision, model: connection.model, maxTokens,
          }, { signal: this.#abort!.signal });
          this.#trace.record({ kind: 'model-response', turn, ms: this.#now() - sent, ok: answer.ok,
            ...(answer.stopReason ? { stopReason: answer.stopReason } : {}), ...(answer.text ? { text: answer.text } : {}),
            ...(answer.toolCalls ? { calls: Trace.calls(answer.toolCalls) } : {}),
            ...(answer.error ? { error: answer.error, retryable: answer.retryable === true } : {}) });
          return answer;
        };
        let result = await ask();
        // A dropped connection or a provider hiccup: the request acted on nothing, so it is sent again, twice at most.
        for (const delay of deps.retryDelaysMs ?? RETRY_DELAYS_MS) {
          if (result.ok || !result.retryable || this.#life.stopRequested) break;
          this.#note(`${result.error ?? 'The model request failed.'} Trying again…`);
          await this.#save();
          this.#trace.record({ kind: 'retry', turn: this.#turn, delayMs: delay, ...(result.error ? { error: result.error } : {}) });
          await new Promise((resolve) => setTimeout(resolve, delay));
          if (this.#life.stopRequested) break;
          result = await ask();
        }
        if (this.#life.stopRequested) return this.#end('Stopped.');
        // A raised cap the provider refuses (a model with a smaller output limit): back to the usual one.
        if (!result.ok && maxTokens > MAX_TOKENS && /token|length|max/i.test(result.error ?? '')) {
          maxTokens = MAX_TOKENS;
          result = await ask();
        }
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
          // Cut off before it finished (a long file, or a model that thinks at length): once per run, it gets
          // more room and is asked to do it again, more briefly. Nothing of the cut reply was run.
          if (result.stopReason === 'length' && cutOff < 1) {
            cutOff += 1;
            maxTokens = RAISED_MAX_TOKENS;
            this.#note('The model\'s answer was cut off at its length limit. Asking it to finish, more briefly.');
            s.history.push({ role: 'user', content: CUT_OFF });
            await this.#save();
            continue;
          }
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
    let asked = false;
    let terminal: 'stopped' | 'paused' | undefined;
    for (const call of calls) {
      if (asked) {
        this.#answer(call, { skipped: 'Not run: you asked the owner a question earlier in this batch. Decide again with their answer.' }, true);
        continue;
      }
      if (failed || terminal) {
        this.#answer(call, { skipped: 'An earlier call in this batch failed or paused; nothing was dispatched. Observe and decide again.' }, true);
        continue;
      }
      if (call.argsError) {
        this.#answer(call, { error: `The arguments were not valid JSON: ${call.argsError.message}`, notice: 'Nothing was dispatched.' }, true);
        failed = true;
        continue;
      }
      if (call.name === 'save_file') {
        try {
          await this.#media.saveFile(call);
        } catch (error) {
          this.#answer(call, { error: `The file could not be kept: ${error instanceof Error ? error.message : String(error)}`, notice: 'No file was made.' }, true);
          failed = true;
        }
        continue;
      }
      if (call.name === ASK_TOOL.name) {
        if (await this.#questions.ask(call)) asked = true; else failed = true;
        if (this.#life.stopRequested) terminal = 'stopped';
        continue;
      }
      if (call.name !== 'browser') {
        this.#answer(call, { error: `There is no tool named ${call.name}.`, notice: 'Nothing was dispatched.' }, true);
        failed = true;
        continue;
      }
      // The run's limits hold inside a batch too: the rest of it is not run, and the loop ends the run with the reason.
      if (s.actions >= this.#limit.actions || this.#now() - s.startedAt > this.#limit.ms) {
        this.#answer(call, { skipped: 'The run reached its limit of browser actions or time; nothing was dispatched.' }, true);
        failed = true;
        continue;
      }
      this.#cancel = new Cancellation();
      if (this.#life.stopRequested) this.#cancel.cancel();
      // Named from the page as the model saw it, before the action changes it.
      const targets = this.#targetsFor(call.args);
      await this.#learn.before(call.args ?? {}, targets, why);
      if (this.#life.stopRequested) this.#cancel.cancel();
      // Shown as it starts: the page changes long before the step's result is back (it waits for the page and reads it again).
      const started: TranscriptEntry = { kind: 'action', text: describeStep(call.args, targets, false), outcome: 'pending' };
      s.transcript.push(started);
      await this.#save();
      /** The step's row, now with its outcome, where it started. */
      const settle = (entry: TranscriptEntry) => {
        const at = s.transcript.indexOf(started);
        if (at >= 0) s.transcript[at] = entry; else s.transcript.push(entry);
      };
      this.#callStarted = this.#now();
      const ran = await this.#deps.controller.run(call.args, this.#cancel);
      const notes = 'observation' in ran && ran.observation ? this.#notes.notesFor(ran.observation.url) : undefined;
      const result: ToolResult = notes ? { ...ran, ownerNotes: notes } as unknown as ToolResult : ran;
      const outcome = outcomeOf(result);
      const detail = detailOf(result);
      let image: KeptImage | undefined;
      if ('screenshot' in result) {
        try {
          image = await this.#media.keepScreenshot(call, result);
        } catch (error) {
          // Storage refused it: the call still gets its one answer, without the image.
          this.#answer(call, { error: `The screenshot could not be kept: ${error instanceof Error ? error.message : String(error)}`, notice: 'Nothing was dispatched.' }, true);
          settle({ kind: 'action', text: describeStep(call.args, targets, false), outcome: 'error', detail: 'The screenshot could not be kept.' });
          failed = true;
          s.actions += 1;
          await this.#save();
          continue;
        }
      }
      if (image) {
        this.#traceCall(call, { completed: true, screenshot: { width: image.width, height: image.height } }, false);
        settle({ kind: 'action', text: describeStep(call.args, targets, outcome === 'ok'), outcome, image });
        await this.#media.prune();
      } else {
        this.#answer(call, result, outcome !== 'ok');
        settle({ kind: 'action', text: describeStep(call.args, targets, outcome === 'ok'), outcome, ...(detail ? { detail } : {}) });
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

  /** The targets a step can be named from: the latest list, and a ref it names that the bound left only in the tree. */
  #targetsFor(args: Record<string, unknown> | undefined): Array<{ ref: string; role: string; name: string }> {
    const controller = this.#deps.controller;
    const targets: Array<{ ref: string; role: string; name: string }> = [...controller.latestTargets];
    const refs = [(args?.['target'] as { ref?: unknown } | undefined)?.ref, ((args?.['to'] as { target?: { ref?: unknown } } | undefined)?.target)?.ref];
    for (const ref of refs) {
      if (typeof ref !== 'string' || targets.some((target) => target.ref === ref)) continue;
      const found = targetInTree(controller.latestTree, ref);
      if (found) targets.push(found);
    }
    return targets;
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

  /** The persisted state's size, with the amendments waiting for the next turn. */
  #storedChars(): number {
    return JSON.stringify(this.#state).length + this.#amendments.reduce((sum, content) => sum + JSON.stringify(content).length, 0);
  }

  /** Read fresh each time: the controller pauses itself during a batch. */
  #controllerPaused(): boolean {
    return this.#deps.controller.state === 'paused';
  }

  #answer(call: AIToolCall, result: unknown, isError: boolean): void {
    this.#traceCall(call, result, isError);
    this.#state.history.push({ role: 'tool', toolCallId: call.id, name: call.name, content: JSON.stringify(result), ...(isError ? { isError: true } : {}) });
  }

  /**
   * A run that ends or pauses mid-step (a throw, a refused save) leaves no call
   * without its result and no step shown as under way: both become "unknown".
   */
  #settleLeftovers(): void {
    this.#answerDangling('The run ended while this action was going. Its outcome is unknown. Observe before acting and do not repeat a submission.');
    for (const entry of this.#state.transcript) if (entry.kind === 'action' && entry.outcome === 'pending') entry.outcome = 'unknown';
  }

  /** Any call of the last model turn without a result gets "outcome unknown" (after a restart, or a run cut short). */
  #answerDangling(text: string): void {
    const history = this.#state.history;
    const lastAssistant = [...history].reverse().find((message) => message.role === 'assistant');
    if (lastAssistant?.role !== 'assistant' || !lastAssistant.toolCalls) return;
    const answered = new Set(history.filter((message) => message.role === 'tool').map((message) => (message as { toolCallId: string }).toolCallId));
    for (const call of lastAssistant.toolCalls) {
      if (answered.has(call.id)) continue;
      if (call.name === ASK_TOOL.name) this.#answer(call, { skipped: 'The extension restarted before the owner answered. Ask again if you still need to.' }, true);
      else this.#answer(call, { completed: 'unknown', error: text, notice: text }, true);
    }
  }

  #note(text: string): void {
    this.#state.transcript.push({ kind: 'notice', text });
    this.#trace.record({ kind: 'note', text });
  }

  /** A tool call's one result, for the trace: what was asked, how long it took, and what the model got back. */
  #traceCall(call: AIToolCall, result: unknown, isError: boolean): void {
    const ms = this.#callStarted === undefined ? 0 : this.#now() - this.#callStarted;
    this.#callStarted = undefined;
    const outcome = result && typeof result === 'object' ? outcomeOf(result as ToolResult) : isError ? 'error' : 'ok';
    this.#trace.record({ kind: 'call', turn: this.#turn, id: call.id, name: call.name, args: call.argsError ? { invalidJson: call.argsError.raw } : call.args, ms, outcome, result });
  }

  /**
   * The trace as a file the owner can save and share: the events, and the
   * conversation as the model had it (images left out). It holds what the
   * agent read on pages and typed into them.
   */
  exportTrace(): string {
    const s = this.#state;
    const history = s.history.map((message) => (Array.isArray(message.content)
      ? { ...message, content: message.content.map((part) => (part.type === 'image' || part.type === 'document' ? { type: part.type, omitted: true } : part)) }
      : message));
    return JSON.stringify({
      valetTrace: TRACE_VERSION,
      exportedAt: new Date(this.#now()).toISOString(),
      note: 'What the agent read on pages and typed into them is in here. Share it with care.',
      conversation: { status: s.status, connection: s.connection ? `${s.connection.label} · ${s.connection.model}` : null, mode: s.scope.mode, actions: s.actions },
      events: this.#trace.events,
      transcript: s.transcript,
      history,
    }, null, 2);
  }

  async #pause(reason: string): Promise<void> {
    this.#settleLeftovers();
    this.#life.to('paused');
    this.#state.pauseReason = reason;
    await this.#learn.clear();
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

  /** `atLimit`: the run stopped at its limit of actions or time, and the panel offers Continue. */
  async #end(notice?: string, atLimit = false): Promise<void> {
    this.#settleLeftovers();
    if (notice) this.#note(notice);
    if (atLimit) this.#state.atLimit = true;
    this.#life.to('idle');
    this.#unknownStep = undefined;
    await this.#learn.clear();
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
    this.#trace.persist();
    this.#deps.emit(this.state);
  }
}
