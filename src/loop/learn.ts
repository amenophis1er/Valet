/*
 * Learn: one step at a time. Before each action the agent points at where it
 * will go and says, in a bubble on the page and a bar in the panel, what it
 * will do and why; the step waits for the owner's Next. Reads (observe,
 * screenshot) never wait. Stop releases a waiting step; the controller then
 * skips it as stopped.
 */

import { describeStep } from '../actions/index.js';
import type { Note } from '../executor/commands.js';
import type { LoopHost } from './host.js';
import { Waiter } from './waiter.js';

export interface LearnDeps {
  /** Read before each step, so turning it on or off applies at once. */
  learning: { get(): boolean; set(on: boolean): Promise<void> };
  /** The cursor onto where the step would go, and the bubble saying what it is. Both best effort. */
  preview(args: Record<string, unknown>): Promise<void>;
  note(note: Note | null): Promise<void>;
}

export class Learn {
  readonly #host: LoopHost;
  readonly #deps: LearnDeps;
  readonly #stopped: () => boolean;
  /** Learn's Next, waiting for the owner; lost on a restart (the run is then paused). */
  readonly #next = new Waiter<void>(undefined);
  /** A bubble ("Doing it…") is still in the page from the last step; the next step replaces it, or takes it away if Learn went off. */
  #noted = false;

  constructor(host: LoopHost, deps: LearnDeps, stopped: () => boolean) {
    this.#host = host;
    this.#deps = deps;
    this.#stopped = stopped;
  }

  get on(): boolean {
    return this.#deps.learning.get();
  }

  /** The owner's Next: the waiting step goes ahead. Nothing waiting, nothing happens. */
  next(): void {
    this.#next.answer();
  }

  /** Learn on or off. Off while a step waits lets that step go. */
  async set(on: boolean): Promise<void> {
    await this.#deps.learning.set(on);
    if (!on) this.next();
  }

  /** Before an action: show where it goes and what it is, and wait for Next (in Learn only). */
  async before(args: Record<string, unknown>, targets: ReadonlyArray<{ ref: string; role: string; name: string }>, why: string | undefined): Promise<void> {
    if (!this.on || ['observe', 'screenshot'].includes(String(args['action']))) {
      if (this.#noted && !this.on) await this.clear();
      return;
    }
    const text = describeStep(args, targets, false);
    const state = this.#host.state();
    // The waiter exists before the owner can see Next: a click during the preview is never lost.
    const proceed = this.#stopped() ? undefined : this.#next.ask();
    state.stepWait = { text, ...(why ? { why } : {}) };
    await this.#host.save();
    await this.#deps.preview(args).catch(() => undefined);
    await this.#deps.note({ text, ...(why ? { why } : {}), waiting: true }).catch(() => undefined);
    // Learn went off while the step was being shown: no wait after all.
    if (!this.on) this.next();
    if (proceed) await proceed;
    state.stepWait = undefined;
    this.#noted = !this.#stopped();
    await this.#deps.note(this.#stopped() ? null : { text, ...(why ? { why } : {}), waiting: false }).catch(() => undefined);
    await this.#host.save();
  }

  /** Take the bubble away (the run paused or ended). */
  async clear(): Promise<void> {
    this.#noted = false;
    await this.#deps.note(null).catch(() => undefined);
  }
}
