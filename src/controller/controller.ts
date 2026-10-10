/*
 * The run controller: everything between the model's tool call and the
 * executor.
 *
 * It owns
 * the observation identity, invalidates evidence before dispatch, observes
 * after every command, recovers fresh evidence after a refusal, and classifies
 * every failure by whether dispatch had begun — read from the executor's
 * `Cancellation.dispatched`, never from the error class alone.
 *
 * Run scope and form-submission checks are asked of the agent loop through
 * `ScopeGate`; budgets and persistence live in the loop too.
 */

import type { Capture, ExecutorObservation, FrameInfo } from '../executor/commands.js';
import { Cancellation, CancelledError, PreconditionError, sentence, type Command, type CommandResult, type Observation } from '../executor/protocol.js';
import { boundObservation } from './observation.js';
import { originOf, type Decision, type SubmitTarget, type Verdict } from '../scope/scope.js';
import type { SubmitFingerprint } from '../executor/content.js';
import { ACTING, UNTRUSTED, commandSchema, type BrowserCommand } from './schema.js';

/** The slice of the executor the controller drives. `BrowserCommands` satisfies it. */
export interface ExecutorLike {
  run(command: Command, cancel?: Cancellation): Promise<CommandResult>;
  observe(session: string, cancel?: Cancellation, allowFrame?: (origin: string) => boolean): Promise<ExecutorObservation>;
  /** Step back after a blocked navigation left the tab on Chrome's error page. */
  back?(session: string): Promise<void>;
  /** Whether acting on a target would submit a form, and what it would send. */
  submitFacts?(session: string, target: unknown, via: 'click' | 'enter' | 'space'): Promise<{ submits: boolean; fingerprint?: Fingerprint }>;
  /** A screenshot of the active tab, frames outside the run painted over. */
  capture?(session: string, cancel?: Cancellation, allowOrigin?: (origin: string) => boolean): Promise<Capture>;
  /** The element under a point of the viewport, as a ref in the latest observation. */
  refAt?(session: string, point: { x: number; y: number }): Promise<{ ref: string; role: string; name: string; href?: string }>;
  /** Learning: the cursor onto where the next action would go, dispatching nothing. */
  preview?(session: string, aim: { target?: unknown; point?: { x: number; y: number } }): Promise<void>;
  /** Whether this session has a tab to observe at all (a navigate has opened one). */
  hasTab(session: string): boolean;
}

export type ToolResult =
  /** The command ran and here is what the page looks like now. */
  | { completed: true; observation: Observation; notice: string }
  /** Refused before dispatch: nothing happened. */
  | { refused: string; observation?: Observation; observed?: false; error?: string; notice: string }
  /** Dispatch had begun when it failed: the action may have happened. */
  | { completed: 'unknown'; error: string; notice: string }
  /** The command finished (or was an observe) but its observation failed. */
  | { completed: boolean; observed: false; error: string; message: string; notice: string }
  /** An unexpected failure before dispatch. */
  | { error: string; notice: string }
  /** A screenshot: shown to the owner, and to the model when it can see images. Its id is what a click by point names. */
  | { completed: true; screenshot: Capture & { id: string }; notice: string }
  /** `close` ran. */
  | { completed: true; closed: true; notice: string }
  /** A terminal guard: this call was not run and the turn ends. */
  | { skipped: string; terminal: 'stopped' | 'paused' };

export type ControllerState = 'running' | 'paused';

const STALE = 'Stale page observation. Use the latest observation.id and target ref.';
const STALE_SHOT = 'Stale screenshot. A point needs the id of a screenshot taken after the last action: take a new one.';
const OBSERVE_FIRST = 'A fresh observation is required: observe the current page before acting. Do not replay an earlier action.';
const WAIT = 'Wait a few seconds and observe again.';
const NO_REPEAT = 'Do not repeat the action; its effect may already have happened.';
const UNKNOWN = 'The action may have partially completed. Inspect it before resuming; do not repeat a submission.';
const REPEATED = 'Repeated targeting failures: ask the owner to inspect and resume. No input was dispatched.';
const MAX_REFUSALS = 3;
const MAX_INVALID = 3;
const MALFORMED = 'The model keeps sending malformed browser commands. It may not handle tool calls well: try a stronger model in Settings, then press Resume.';
const MAX_OBSERVATION_FAILURES = 3;

export type Fingerprint = SubmitFingerprint & { documentId?: string };

/** Why the owner is being asked about an origin. */
export type AskReason = 'navigate' | 'link' | 'blocked' | 'landed';

/**
 * Run scope, as the controller sees it. The loop implements
 * it: `verdict` from this conversation's decisions, `ask` by
 * showing the owner a card and resolving with their decision (already
 * recorded), `takeBlocked` from containment's blocked-navigation reports.
 */
export interface ScopeGate {
  verdict(origin: string): Verdict;
  ask(origin: string, reason: AskReason): Promise<Decision>;
  takeBlocked(): string[];
  /** Form submissions: this conversation's denials and approvals. */
  submitVerdict?(target: SubmitTarget): Verdict;
  /** Show the submission card; resolves with the decision (already recorded). */
  askSubmit?(fingerprint: Fingerprint): Promise<Decision>;
}

/** No scope: every origin allowed. For tests and the console. */
export const OPEN_SCOPE: ScopeGate = { verdict: () => 'allowed', ask: async () => 'once', takeBlocked: () => [] };

export interface ControllerOptions {
  session: string;
  gate?: ScopeGate;
  uuid?: () => string;
  now?: () => Date;
}

export class RunController {
  #executor: ExecutorLike;
  #session: string;
  #uuid: () => string;
  #now: () => Date;
  #latest?: Observation;
  #frames: FrameInfo[] = [];
  /** The latest screenshot, valid until the next dispatch: what a click by point is mapped through. */
  #shot?: Capture & { id: string };
  #gate: ScopeGate;

  state: ControllerState = 'running';
  pauseReason?: string;
  refusals = 0;
  /** Consecutive commands that failed validation: a model problem, not a targeting one. */
  invalidCommands = 0;
  observationFailures = 0;
  needsObservation = false;

  constructor(executor: ExecutorLike, options: ControllerOptions) {
    this.#executor = executor;
    this.#session = options.session;
    this.#uuid = options.uuid ?? (() => crypto.randomUUID());
    this.#now = options.now ?? (() => new Date());
    this.#gate = options.gate ?? OPEN_SCOPE;
  }

  /** The id of the observation an acting command must carry, if there is one. */
  get latestId(): string | undefined { return this.#latest?.id; }
  /** The latest observation's targets, to describe an action in words the owner knows. */
  get latestTargets(): readonly NonNullable<Observation['targets']>[number][] { return this.#latest?.targets ?? []; }
  /** Frame metadata of the latest observation, for redaction and scope. */
  get latestFrames(): readonly FrameInfo[] { return this.#frames; }

  /** Counters and flags. */
  /** A new run: not paused, whatever paused the last one; a fresh observation first, as always. */
  startRun(): void {
    this.state = 'running';
    this.pauseReason = undefined;
    this.refusals = 0;
    this.invalidCommands = 0;
  }
  resume(): void {
    this.state = 'running';
    this.pauseReason = undefined;
    this.refusals = 0;
    this.invalidCommands = 0;
    this.observationFailures = 0;
    this.needsObservation = true;
  }

  async run(input: unknown, cancel: Cancellation = new Cancellation()): Promise<ToolResult> {
    // 1. Guards: terminal for the turn, never a refusal.
    if (cancel.cancelled) return { skipped: 'Stopped by the owner; nothing was dispatched.', terminal: 'stopped' };
    if (this.state === 'paused') return { skipped: `The run is paused: ${this.pauseReason ?? 'waiting for the owner'}. Nothing was dispatched.`, terminal: 'paused' };

    // 2. Validate.
    const parsed = commandSchema.safeParse(input);
    if (!parsed.success) return this.#invalid(parsed.error.issues[0]);
    this.invalidCommands = 0;
    let command = parsed.data;
    const acting = (ACTING as readonly string[]).includes(command.action);

    // Observe first after a failed observation (acting commands only; navigate recovers a lost tab).
    if (acting && this.needsObservation) return { refused: OBSERVE_FIRST, notice: UNTRUSTED };

    // 3. Evidence.
    if (acting && (!this.#latest || command.observation !== this.#latest.id)) return this.#refuse(STALE, cancel);

    if (command.action === 'observe') return this.#observe(cancel, false);
    if (command.action === 'screenshot') return this.#screenshot(cancel);

    // An action by point becomes one on the element found there, checked like any other; a drag's end is a point in the viewport or a target.
    let point: { x: number; y: number } | undefined;
    let to: { target: BrowserCommand['target'] } | { point: { x: number; y: number } } | undefined;
    if (command.point) {
      const aimed = await this.#aimPoint(command.point, command.screenshot, cancel);
      if ('refused' in aimed) return aimed.refused;
      point = aimed.point;
      command = { ...command, point: undefined, target: { ref: aimed.ref, by: 'role', frame: 0 } };
    }
    if (command.to) {
      if (command.to.point) {
        const mapped = await this.#mapPoint(command.to.point, command.screenshot, cancel);
        if ('refused' in mapped) return mapped.refused;
        to = { point: mapped.point };
      } else to = { target: command.to.target };
      command = { ...command, to: undefined };
    }
    command = { ...command, screenshot: undefined };

    // 4. Scope, before dispatch.
    const scoped = await this.#scope(command, cancel);
    if (scoped) return scoped;

    // 5. Invalidate, then dispatch.
    this.#latest = undefined;
    this.#frames = [];
    this.#shot = undefined;
    try {
      const dispatched = toExecutor(command, this.#uuid(), this.#session);
      if (point) dispatched.args['point'] = point;
      if (to) dispatched.args['to'] = to;
      await this.#executor.run(dispatched, cancel);
    } catch (error) {
      return this.#failed(error, cancel);
    }

    if (command.action === 'close') {
      this.refusals = 0;
      this.observationFailures = 0;
      this.needsObservation = false;
      return { completed: true, closed: true, notice: UNTRUSTED };
    }
    this.refusals = 0;
    // Containment blocked a navigation this action caused: the action keeps its
    // own status, the blocked request never left, and nothing is re-run.
    const blocked = this.#gate.takeBlocked()[0];
    if (blocked) return this.#blocked(blocked, cancel);
    // 6. Observe.
    return this.#observe(cancel, true);
  }

  /**
   * A point on the latest screenshot, as a ref: mapped to the viewport, refused
   * on a painted-over frame, then resolved to the element under it.
   */
  /** A point of the latest screenshot as a point of the viewport, or a refusal: stale, outside, or on a painted-over frame. */
  async #mapPoint(at: { x: number; y: number }, shotId: string | undefined, cancel: Cancellation): Promise<{ point: { x: number; y: number } } | { refused: ToolResult }> {
    const shot = this.#shot;
    if (!shot || shotId !== shot.id) return { refused: await this.#refuse(STALE_SHOT, cancel) };
    if (at.x >= shot.width || at.y >= shot.height) return { refused: await this.#refuse(`The point (${at.x}, ${at.y}) is outside the screenshot, which is ${shot.width} by ${shot.height}.`, cancel) };
    const point = { x: Math.round(at.x * shot.viewport.width / shot.width), y: Math.round(at.y * shot.viewport.height / shot.height) };
    if (shot.masks.some((mask) => point.x >= mask.x && point.x < mask.x + mask.w && point.y >= mask.y && point.y < mask.y + mask.h)) {
      return { refused: await this.#refuse('That point is on a part of the page painted grey: content from a site outside this run, which cannot be touched.', cancel) };
    }
    return { point };
  }

  async #aimPoint(at: { x: number; y: number }, shotId: string | undefined, cancel: Cancellation): Promise<{ ref: string; point: { x: number; y: number } } | { refused: ToolResult }> {
    if (!this.#executor.refAt) return { refused: { refused: 'Acting by point is not available here. Use a ref.', notice: UNTRUSTED } };
    const mapped = await this.#mapPoint(at, shotId, cancel);
    if ('refused' in mapped) return mapped;
    const { point } = mapped;
    try {
      const found = await this.#executor.refAt(this.#session, point);
      // The link under the point is scope-checked like a link clicked by ref.
      if (found.href && this.#latest) this.#latest = { ...this.#latest, targets: [...(this.#latest.targets ?? []), { ref: found.ref, frame: 0, role: found.role, name: found.name, href: found.href }] };
      return { ref: found.ref, point };
    } catch (error) {
      if (error instanceof CancelledError) return { refused: { skipped: 'Stopped by the owner; nothing was dispatched.', terminal: 'stopped' } };
      if (error instanceof PreconditionError) return { refused: await this.#refuse(sentence(error), cancel) };
      return { refused: { error: sentence(error), notice: 'Nothing was dispatched.' } };
    }
  }

  /** Learning: show where the next action will go, before the owner lets it run. Nothing is dispatched, nothing fails. */
  async preview(input: unknown): Promise<void> {
    if (!this.#executor.preview) return;
    const parsed = commandSchema.safeParse(input);
    if (!parsed.success) return;
    const command = parsed.data;
    let point: { x: number; y: number } | undefined;
    if (command.point) {
      const shot = this.#shot;
      if (!shot || command.screenshot !== shot.id || command.point.x >= shot.width || command.point.y >= shot.height) return;
      point = { x: Math.round(command.point.x * shot.viewport.width / shot.width), y: Math.round(command.point.y * shot.viewport.height / shot.height) };
    }
    if (!point && !command.target) return;
    await this.#executor.preview(this.#session, { ...(command.target ? { target: command.target } : {}), ...(point ? { point } : {}) }).catch(() => undefined);
  }

  /** Scope checks before dispatch: navigate targets and link hrefs. */
  async #scope(command: BrowserCommand, cancel: Cancellation): Promise<ToolResult | undefined> {
    let origin: string | null = null;
    let reason: AskReason = 'navigate';
    if (command.action === 'navigate') origin = originOf(command.url ?? '');
    if (command.action === 'click' && command.target?.ref) {
      const href = this.#latest?.targets?.find((target) => target.ref === command.target!.ref)?.href;
      if (href) { origin = originOf(href); reason = 'link'; }
    }
    if (!origin) return this.#submission(command, cancel);
    let verdict = this.#gate.verdict(origin);
    if (verdict === 'ask') {
      verdict = (await this.#gate.ask(origin, reason)) === 'deny' ? 'denied' : 'allowed';
      // The owner may have pressed Stop while the card was up.
      if (cancel.cancelled) return { skipped: 'Stopped by the owner; nothing was dispatched.', terminal: 'stopped' };
      if (this.state === 'paused') return { skipped: `The run is paused: ${this.pauseReason ?? 'waiting for the owner'}. Nothing was dispatched.`, terminal: 'paused' };
    }
    if (verdict === 'denied') return { refused: `The owner did not allow ${origin} for this run; nothing was dispatched. Do not try it again — find another way or ask the owner.`, notice: UNTRUSTED };
    return undefined;
  }

  /**
   * A click or key press that would submit a form needs the owner's approval:
   * the card shows where it goes and what it sends. After
   * Allow, the facts are read again right before dispatch; if anything changed
   * — a value, the destination — the owner is asked again.
   */
  async #submission(command: BrowserCommand, cancel: Cancellation): Promise<ToolResult | undefined> {
    const via = command.action === 'click' ? 'click' : command.action === 'press' && command.key === 'Enter' ? 'enter' : command.action === 'press' && command.key === 'Space' ? 'space' : undefined;
    if (!via || !command.target || !this.#executor.submitFacts || !this.#gate.submitVerdict || !this.#gate.askSubmit) return undefined;
    // A stale or vanished target is left to the executor's own refusal, which
    // comes before any dispatch. Any other failure to read the form fails
    // closed: an unchecked submission is never sent.
    let unreadable: string | undefined;
    const read = () => this.#executor.submitFacts!(this.#session, command.target, via).catch((error: unknown) => {
      if (!(error instanceof PreconditionError)) unreadable = sentence(error);
      return { submits: false as const };
    });
    let facts = await read();
    if (unreadable) return { refused: `Could not check whether this action submits a form (${unreadable}); nothing was dispatched. Observe again.`, notice: UNTRUSTED };
    for (let round = 0; facts.submits && facts.fingerprint && round < 3; round += 1) {
      const fingerprint = facts.fingerprint;
      // Where the form goes is a site like any other.
      const destination = originOf(fingerprint.action);
      if (destination && this.#gate.verdict(destination) !== 'allowed') {
        const decision = this.#gate.verdict(destination) === 'denied' ? 'deny' : await this.#gate.ask(destination, 'navigate');
        if (decision === 'deny') return { refused: `The owner did not allow ${destination}, where this form would send its data; nothing was dispatched.`, notice: UNTRUSTED };
      }
      const target: SubmitTarget = { pageOrigin: fingerprint.frameOrigin, action: fingerprint.action, method: fingerprint.method };
      const verdict = this.#gate.submitVerdict(target);
      if (verdict === 'denied') return { refused: 'The owner denied this form submission for this run; nothing was dispatched. Do not try again.', notice: UNTRUSTED };
      if (verdict === 'allowed') return undefined;
      const decision = await this.#gate.askSubmit(fingerprint);
      if (cancel.cancelled) return { skipped: 'Stopped by the owner; nothing was dispatched.', terminal: 'stopped' };
      if (decision === 'deny') return { refused: 'The owner did not allow this form submission; nothing was dispatched. Do not try again.', notice: UNTRUSTED };
      // Approved: make sure the form still sends exactly what was approved. A read that fails here fails closed too.
      const again = await read();
      if (unreadable) return { refused: `Could not check that the form still sends what was approved (${unreadable}); nothing was dispatched. Observe again.`, notice: UNTRUSTED };
      if (JSON.stringify(again) === JSON.stringify(facts)) return undefined;
      facts = again;
    }
    if (facts.submits) return { refused: 'The form kept changing while it was being approved; nothing was dispatched. Observe again.', notice: UNTRUSTED };
    return undefined;
  }

  /** Nothing is dispatched, so the latest observation stays valid, and a failure is not a targeting refusal. */
  async #screenshot(cancel: Cancellation): Promise<ToolResult> {
    if (!this.#executor.capture) return { refused: 'Screenshots are not available here.', notice: UNTRUSTED };
    if (!this.#executor.hasTab(this.#session)) return { refused: 'There is no tab yet. Navigate first.', notice: UNTRUSTED };
    try {
      const screenshot = { ...await this.#executor.capture(this.#session, cancel, (origin) => this.#gate.verdict(origin) === 'allowed'), id: this.#uuid() };
      this.#shot = screenshot;
      return { completed: true, screenshot, notice: UNTRUSTED };
    } catch (error) {
      if (error instanceof CancelledError) return { skipped: 'Stopped by the owner.', terminal: 'stopped' };
      if (error instanceof PreconditionError) return { refused: sentence(error), notice: UNTRUSTED };
      return { error: `The screenshot failed: ${sentence(error)}`, notice: 'Nothing was dispatched.' };
    }
  }

  /** A navigation the action caused was blocked before it left the browser. */
  async #blocked(origin: string, cancel: Cancellation): Promise<ToolResult> {
    await this.#executor.back?.(this.#session).catch(() => undefined);
    const decision = await this.#gate.ask(origin, 'blocked');
    this.needsObservation = true;
    this.#latest = undefined;
    const said = decision === 'deny' ? 'The owner did not allow it.' : 'The owner has now allowed it for this run.';
    const notice = `The page tried to go to ${origin}, which was not approved; that request was blocked and nothing was sent there. ${said} The action itself may have taken effect on the approved site: do not repeat it. Observe before acting.`;
    if (cancel.cancelled) return { completed: 'unknown', error: notice, notice };
    return { completed: true, observed: false, error: `blocked: ${origin}`, message: notice, notice: UNTRUSTED };
  }

  /** A command that failed in the executor, classified by whether dispatch had begun. */
  async #failed(error: unknown, cancel: Cancellation): Promise<ToolResult> {
    if (cancel.dispatched) {
      this.#pause(UNKNOWN);
      return { completed: 'unknown', error: sentence(error), notice: UNKNOWN };
    }
    if (error instanceof CancelledError) return { skipped: 'Stopped by the owner; nothing was dispatched.', terminal: 'stopped' };
    if (error instanceof PreconditionError) return this.#refuse(sentence(error), cancel);
    this.#pause('An unexpected error stopped the browser before anything was dispatched.');
    return { error: sentence(error), notice: 'Nothing was dispatched.' };
  }

  /**
   * A command that failed validation. Nothing was dispatched and the page did
   * not change, so the latest observation stays valid: say so, show the shape
   * to copy, and skip the recovery observation. These are counted apart from
   * targeting refusals — three in a row is a model that cannot form commands,
   * and the pause says that instead of blaming targeting.
   */
  #invalid(issue: { path: PropertyKey[]; message: string } | undefined): ToolResult {
    this.invalidCommands += 1;
    const where = issue?.path.length ? `${issue.path.map(String).join('.')}: ` : '';
    const latest = this.#latest?.id;
    const shape = `{"action":"click","observation":"${latest ?? 'LATEST_OBSERVATION_ID'}","target":{"ref":"e12"}}`;
    let refused = `Invalid browser command — ${where}${(issue?.message ?? 'malformed input').slice(0, 200)}. Send a JSON object with separate fields, for example ${shape}.${latest ? ` The latest observation is still ${latest}.` : ' Observe first.'}`;
    if (this.invalidCommands >= MAX_INVALID) {
      refused = `${refused} ${MALFORMED}`;
      this.#pause(MALFORMED);
    }
    return { refused, notice: UNTRUSTED };
  }

  /** A refusal: nothing was dispatched. Count it, and recover fresh evidence rather than replay. */
  async #refuse(reason: string, cancel: Cancellation): Promise<ToolResult> {
    this.refusals += 1;
    let refused = reason;
    if (this.refusals >= MAX_REFUSALS) {
      refused = `${reason} ${REPEATED}`;
      this.#pause(REPEATED);
    }
    if (!this.#executor.hasTab(this.#session)) return { refused, notice: UNTRUSTED };
    const recovered = await this.#observe(cancel, false);
    if ('observation' in recovered) return { refused, observation: recovered.observation, notice: UNTRUSTED };
    const error = 'error' in recovered ? recovered.error : 'The page could not be observed.';
    return { refused, observed: false, error, notice: UNTRUSTED };
  }

  async #observe(cancel: Cancellation, afterAction: boolean): Promise<ToolResult> {
    let raw: ExecutorObservation;
    try {
      raw = await this.#executor.observe(this.#session, cancel, (origin) => this.#gate.verdict(origin) === 'allowed');
    } catch (error) {
      if (error instanceof CancelledError) return { skipped: 'Stopped by the owner.', terminal: 'stopped' };
      return this.#observationFailed(sentence(error), afterAction);
    }
    // The tab itself ended up somewhere out of scope (a page's own navigation):
    // withhold what it shows until the owner decides.
    const landed = originOf(raw.url);
    if (landed && this.#gate.verdict(landed) !== 'allowed') {
      const decision = this.#gate.verdict(landed) === 'denied' ? 'deny' : await this.#gate.ask(landed, 'landed');
      if (decision === 'deny') {
        this.#latest = undefined;
        this.needsObservation = true;
        const message = `The tab is on ${landed}, which the owner did not allow; its content is withheld.${afterAction ? ' Do not repeat the action.' : ''} Navigate somewhere approved.`;
        return { completed: afterAction, observed: false, error: `withheld: ${landed}`, message, notice: UNTRUSTED };
      }
    }
    const { frames, ...visible } = raw;
    const observation = boundObservation({ ...visible, id: this.#uuid(), capturedAt: this.#now().toISOString() });
    this.#latest = observation;
    this.#frames = frames;
    this.observationFailures = 0;
    this.needsObservation = false;
    return { completed: true, observation, notice: UNTRUSTED };
  }

  /** A failed observation. A gone tab does not pause the run: `navigate` recovers it. */
  #observationFailed(cause: string, afterAction: boolean): ToolResult {
    this.#latest = undefined;
    this.#frames = [];
    this.needsObservation = true;
    this.observationFailures += 1;
    const paused = this.observationFailures >= MAX_OBSERVATION_FAILURES;
    // The executor's own sentence may already say to wait and observe again; do not say it twice.
    const wait = paused ? 'Observation failed three times in a row: ask the owner to inspect and resume.'
      : /observe again\.?$/i.test(cause) ? '' : WAIT;
    const message = `${afterAction ? 'Action completed, but observation failed' : 'Observation failed'}: ${cause.replace(/\.$/, '')}.${wait ? ` ${wait}` : ''}${afterAction ? ` ${NO_REPEAT}` : ''}`;
    if (paused) this.#pause('Observation failed three times in a row.');
    return { completed: afterAction, observed: false, error: cause, message, notice: UNTRUSTED };
  }

  #pause(reason: string): void {
    // A pause already in force keeps its reason: the first cause is the one the owner sees.
    if (this.state === 'paused') return;
    this.state = 'paused';
    this.pauseReason = reason;
  }
}

/** The validated tool call as the executor's command. */
function toExecutor(command: BrowserCommand, id: string, session: string): Command {
  const { action, ...rest } = command;
  const args: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rest)) if (value !== undefined && key !== 'observation' && key !== 'screenshot' && key !== 'to') args[key] = value;
  return { id, name: action, session, args };
}
