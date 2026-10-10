/*
 * The executor's vocabulary: commands, observations and the errors that say
 * whether anything happened.
 *
 * The run controller calls the executor in-process: there is no wire, only
 * the shared shapes and the stop switch.
 */

export interface ObservedTarget {
  ref: string;
  frame: number;
  role: string;
  name: string;
  href?: string;
  bounds?: { x: number; y: number; width: number; height: number };
}

/** The observation contract. */
export interface Observation {
  id: string;
  url: string;
  title: string;
  tree: string;
  targets?: ObservedTarget[];
  tabs: Array<{ id: string; url: string; title: string }>;
  capturedAt: string;
  screenshotSize?: { width: number; height: number };
}

/** Everything the model's `browser` tool can name. */
export const COMMAND_NAMES = ['navigate', 'observe', 'screenshot', 'click', 'hover', 'drag', 'fill', 'select', 'press', 'scroll', 'tab', 'close'] as const;
export type CommandName = (typeof COMMAND_NAMES)[number];

export interface Command {
  id: string;
  name: CommandName;
  session: string;
  args: Record<string, unknown>;
}

export interface CommandResult {
  observation?: Observation | null;
  screenshot?: string | null;
}

/** Refused before anything was dispatched: the model may observe and reconsider. */
export class PreconditionError extends Error {}

/** Thrown out of an executor that noticed the command was cancelled. */
export class CancelledError extends Error {}

/**
 * One command's stop switch, handed to the executor.
 *
 * The owner's Stop cancels it. The executor checks before every step, and
 * says whether it had already dispatched one, because that is the difference
 * between "nothing happened" and "something may have" — the run controller
 * classifies every failure by it.
 */
export class Cancellation {
  #cancelled = false;
  #dispatched = false;
  cancel(): void { this.#cancelled = true; }
  /** Called immediately before a step that changes the browser. */
  dispatch(): void { this.#dispatched = true; }
  get cancelled(): boolean { return this.#cancelled; }
  get dispatched(): boolean { return this.#dispatched; }
  check(): void { if (this.#cancelled) throw new CancelledError('cancelled'); }
}

/** The model and the owner read this, so it has to read like a sentence and never like a stack. */
export function sentence(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const trimmed = text.replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!trimmed) return 'The browser extension could not run that command.';
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}
