/*
 * What the loop's parts (approvals, media, skill notes, Learn) get from the
 * loop: the conversation's state and the few things they may do with it.
 */

import type { AIToolCall } from '@amenophis1er/byok/types';
import type { Persisted } from './state.js';
import type { TraceInput } from './trace.js';

export interface LoopHost {
  /** The conversation's state, as it is now (replaced on a new conversation: read it each time). */
  state(): Persisted;
  /** A line for the owner in the transcript. */
  note(text: string): void;
  /** Persist and show. */
  save(): Promise<void>;
  /** Containment and the halo follow the run's state. */
  contain(): Promise<void>;
  /** A tool call's one result, into the history. */
  answer(call: AIToolCall, result: unknown, isError: boolean): void;
  now(): number;
  /** An event for the run trace (trace.ts). */
  trace(event: TraceInput): void;
}
