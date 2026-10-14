/*
 * The conversation's state, as it is persisted: the data every part of the
 * loop reads and writes. Shapes only — no behaviour lives here, so the loop's
 * parts can share it without depending on the loop itself.
 */

import type { AIContentPart, AIMessage } from '@amenophis1er/byok/types';
import { newScope, type Scope } from '../scope/scope.js';
import type { Approval, Question, RunStatus, TranscriptEntry } from './protocol.js';

export interface Connection { id: string; revision: number; label: string; model: string }

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
  /** A question from the agent the owner has not answered yet. */
  question?: Question;
  /** The last run stopped at its limit of actions or time (Continue in the panel). */
  atLimit?: boolean;
  /** Messages the owner sent mid-run, not yet given to the model: a restart must not lose them. */
  amendments?: Array<string | AIContentPart[]>;
}

/** A conversation with nothing in it yet. */
export function empty(): Persisted {
  return { history: [], transcript: [], status: 'idle', actions: 0, startedAt: 0, connection: null, handedTab: null, scope: newScope() };
}
