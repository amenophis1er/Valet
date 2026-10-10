/*
 * A run's lifecycle, as an explicit state machine.
 *
 *   idle ──run──▶ starting ──started──▶ running ──pause──▶ paused
 *    ▲               │                     │                 │
 *    └──── refused ──┘                     ├──── end ──▶ idle ◀── stop
 *                                          │                 │
 *                    starting ◀─ resume / message ───────────┘
 *
 * Stop is cleared on entering `starting`, never later: a Stop pressed during
 * the start-up awaits ends the run at its first guard.
 *
 * `starting` covers the awaits between the owner's message and the run
 * really going (reading skills, adopting the tab, saving): a second message
 * meanwhile joins the run instead of starting another. Every change of state
 * goes through `to()`, which refuses a transition the table does not allow —
 * a bug shows up as an error where it happens, not as a run stuck "running".
 *
 * Only idle, running and paused are persisted; a worker that restarts in
 * `starting` or `running` comes back paused (AgentLoop.restore).
 */

import type { RunStatus } from './protocol.js';

export type Phase = RunStatus | 'starting';

const ALLOWED: Record<Phase, readonly Phase[]> = {
  idle: ['starting'],
  // To running once it goes; back where it came from if it cannot start (no connection, storage refused).
  starting: ['running', 'idle', 'paused'],
  running: ['paused', 'idle'],
  paused: ['starting', 'idle'],
};

export class IllegalTransition extends Error {
  constructor(readonly from: Phase, readonly to: Phase) {
    super(`A run cannot go from ${from} to ${to}.`);
  }
}

export class Lifecycle {
  #phase: Phase = 'idle';
  #stopRequested = false;
  /** Called with every persisted status the run enters, to store it with the conversation. */
  readonly #persist: (status: RunStatus) => void;
  /** Told of every transition (the run trace). */
  readonly #changed?: (from: Phase, to: Phase) => void;

  constructor(persist: (status: RunStatus) => void, changed?: (from: Phase, to: Phase) => void) {
    this.#persist = persist;
    this.#changed = changed;
  }

  get phase(): Phase { return this.#phase; }
  /** The run is going, or about to: a message now is an amendment, not a new run. */
  get busy(): boolean { return this.#phase === 'starting' || this.#phase === 'running'; }
  /** The owner pressed Stop during this run; cleared when a run starts or resumes. */
  get stopRequested(): boolean { return this.#stopRequested; }

  /** The only way the phase changes. */
  to(next: Phase): void {
    if (!ALLOWED[this.#phase].includes(next)) throw new IllegalTransition(this.#phase, next);
    const from = this.#phase;
    this.#phase = next;
    this.#changed?.(from, next);
    // A Stop belongs to the run it was pressed in: a new start or resume begins without one, and a Stop
    // pressed while starting is kept, so the run ends at its first guard.
    if (next === 'starting') this.#stopRequested = false;
    if (next !== 'starting') this.#persist(next);
  }

  /** Take up a status read from storage (a new conversation, or the worker restarting), without a transition. */
  load(status: RunStatus): void {
    this.#phase = status;
  }

  requestStop(): void {
    this.#stopRequested = true;
  }
}
