/*
 * The run trace: what happened, in order, for diagnosing a run that went
 * wrong.
 *
 * The transcript shows the owner what the agent did; the trace shows why —
 * every model turn (what was sent, what came back), every tool call with its
 * arguments and the controller's result, every card and its answer, every
 * change of the run's state, with times. It stays in the browser
 * (chrome.storage.session, beside the conversation, gone with it) and leaves
 * only when the owner saves it from the panel.
 *
 * It holds what the model saw and what the agent typed on pages, so the
 * export says so. Page text is as the model received it: frames from sites
 * outside the run are already withheld. Long strings are cut, and the oldest
 * events go first when the trace outgrows its budget.
 */

import type { AIToolCall } from '@amenophis1er/byok/types';

export type TraceEvent = { at: number } & (
  | { kind: 'run'; goal: string; where: string; mode: string; learn: boolean; model: string }
  | { kind: 'phase'; from: string; to: string }
  | { kind: 'model-request'; turn: number; messages: number; chars: number }
  | { kind: 'model-response'; turn: number; ms: number; ok: boolean; stopReason?: string; text?: string; calls?: Array<{ id: string; name: string; args: unknown }>; error?: string; retryable?: boolean }
  | { kind: 'retry'; turn: number; delayMs: number; error?: string }
  | { kind: 'call'; turn: number; id: string; name: string; args: unknown; ms: number; outcome: string; result: unknown }
  | { kind: 'card'; card: 'site' | 'form'; origin: string; reason: string }
  | { kind: 'answer'; card: string; decision: string }
  | { kind: 'step-wait'; text: string }
  | { kind: 'note'; text: string }
);

/** Distributive over the union, so each event's own fields are required. */
type Without<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type TraceInput = Without<TraceEvent, 'at'>;

/** The most events kept, and the most characters they may take in storage. */
export const MAX_EVENTS = 600;
export const MAX_TRACE_CHARS = 1_500_000;
/** The most characters of any one string in an event. */
const MAX_STRING = 4_000;

export const TRACE_VERSION = 1;

/** Long strings cut (with how much was cut), so one large page cannot crowd out the rest. */
export function clip(value: unknown, max = MAX_STRING): unknown {
  if (typeof value === 'string') return value.length > max ? `${value.slice(0, max)}… [${value.length - max} more characters]` : value;
  if (Array.isArray(value)) return value.map((item) => clip(item, max));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clip(item, max)]));
  return value;
}

export interface TraceStore {
  get(): Promise<unknown>;
  set(events: TraceEvent[]): Promise<void>;
  remove(): Promise<void>;
}

export class Trace {
  #events: TraceEvent[] = [];
  readonly #now: () => number;
  readonly #store?: TraceStore;
  /** Writes one after another, so a slow one cannot land after a newer one. */
  #writing: Promise<void> = Promise.resolve();

  constructor(now: () => number, store?: TraceStore) {
    this.#now = now;
    this.#store = store;
  }

  record(event: TraceInput): void {
    this.#events.push(clip({ at: this.#now(), ...event }) as TraceEvent);
    this.#trim();
  }

  get events(): readonly TraceEvent[] {
    return this.#events;
  }

  /** The model's tool calls, as the trace keeps them. */
  static calls(calls: AIToolCall[] | undefined): Array<{ id: string; name: string; args: unknown }> | undefined {
    return calls?.map((call) => ({ id: call.id, name: call.name, args: call.argsError ? { invalidJson: call.argsError.raw } : call.args }));
  }

  /** Persist (best effort: a trace is never worth failing a run over). */
  persist(): void {
    if (!this.#store) return;
    const events = this.#events;
    this.#writing = this.#writing.then(() => this.#store!.set(events)).catch(() => undefined);
  }

  async restore(): Promise<void> {
    const stored = await this.#store?.get().catch(() => undefined);
    this.#events = Array.isArray(stored) ? (stored as TraceEvent[]) : [];
  }

  async clear(): Promise<void> {
    this.#events = [];
    await this.#writing;
    await this.#store?.remove().catch(() => undefined);
  }

  /** The oldest events go first, past the count or the size budget. */
  #trim(): void {
    if (this.#events.length > MAX_EVENTS) this.#events.splice(0, this.#events.length - MAX_EVENTS);
    let size = JSON.stringify(this.#events).length;
    while (size > MAX_TRACE_CHARS && this.#events.length > 1) {
      size -= JSON.stringify(this.#events.shift()).length + 1;
    }
  }
}
