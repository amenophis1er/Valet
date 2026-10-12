/*
 * The side panel ↔ worker protocol, over one `runtime.connect` port named
 * "panel". The panel is a view: it sends intents and
 * renders the state the worker pushes; it never runs loop logic.
 */

export const PANEL_PORT = 'panel';
/**
 * Conversations are per tab: the panel opened on a tab talks to that tab's
 * conversation, over a port named for it. A panel opened without a tab (its
 * page visited directly) gets the one conversation named `main`.
 */
export const MAIN_CONVERSATION = 'main';
export function conversationForTab(tabId: number): string { return `tab:${tabId}`; }
/** The tab a conversation was opened on, or undefined for one without a tab. */
export function tabOfConversation(conversation: string): number | undefined {
  const match = /^tab:(\d+)$/.exec(conversation);
  return match ? Number(match[1]) : undefined;
}
export function panelPortName(conversation: string): string { return conversation === MAIN_CONVERSATION ? PANEL_PORT : `${PANEL_PORT}:${conversation}`; }
/** The conversation a panel port is for, or null when the port is not a panel's. */
export function conversationOfPort(name: string): string | null {
  if (name === PANEL_PORT) return MAIN_CONVERSATION;
  return name.startsWith(`${PANEL_PORT}:`) ? name.slice(PANEL_PORT.length + 1) : null;
}
/** The panel page for a tab's conversation: what the side panel on that tab shows. */
export function panelPath(tabId: number): string { return `panel.html?tab=${tabId}`; }
/** Message prefix for byok's handlers in this extension. */
export const AI_PREFIX = 'agent';
export const HEARTBEAT_MS = 20_000;
/** Screenshots and files live apart from the transcript, in chrome.storage.session, under this prefix and their id. */
export const MEDIA_PREFIX = 'agent:media:';
/** The owner's pace setting in chrome.storage.local: 'fast' (default) or 'natural'. */
export const PACE_KEY = 'agent:pace';
/** Learning, in chrome.storage.local: true while the agent explains and waits before each step. */
export const LEARNING_KEY = 'agent:learning';
/** The last approval mode, in chrome.storage.local: the next conversation starts in it. */
export const MODE_KEY = 'agent:mode';

/** What is stored under a media key. */
export type Media =
  | { kind: 'image'; mediaType: 'image/jpeg' | 'image/png'; data: string }
  | { kind: 'file'; name: string; mimeType: string; content: string }
  /** A PDF Chrome printed from the agent's Markdown, as base64. */
  | { kind: 'pdf'; name: string; data: string };

import type { Attachment } from './attachments.js';
export type { Attachment } from './attachments.js';

export type PanelIntent =
  | { type: 'run'; goal: string; tabId?: number; useNewTab?: boolean; attachments?: Attachment[]; /** Skills the owner named with the message. */ skillIds?: string[] }
  /** "Save as skill": the worker answers with `skill-draft`. `focus` is what the owner wants the note to be about; with `previous`, a rewrite of that draft. */
  | { type: 'draft-skill'; requestId: string; focus?: string; previous?: string }
  /** A screenshot of one of the owner's tabs, to attach: the worker answers with `captured`. */
  | { type: 'capture-tab'; tabId: number; requestId: string }
  | { type: 'stop' }
  | { type: 'resume' }
  | { type: 'new-conversation' }
  | { type: 'heartbeat' }
  | { type: 'get' }
  /** The owner's answer to an approval card. */
  | { type: 'decide'; id: string; decision: 'once' | 'chat' | 'auto' | 'deny' }
  /** Turn Auto on or off for this conversation (and the next one's start). */
  | { type: 'set-mode'; mode: 'ask' | 'auto' }
  /** The owner's answer to a question from the agent: the options picked, or `skip`. A typed answer comes as a `run`. */
  | { type: 'answer'; id: string; picked?: string[]; skip?: boolean }
  /** Learning: let the step the agent is waiting with go ahead. */
  | { type: 'step' }
  /** Learning on or off, from the composer; kept for the next conversation too. */
  | { type: 'set-learning'; on: boolean }
  /** The run trace as a file, for diagnosing a run: the worker answers with `trace`. */
  | { type: 'export-trace'; requestId: string };

export type RunStatus = 'idle' | 'running' | 'paused';

/** One line of the conversation as the owner sees it. */
export type TranscriptEntry =
  | { kind: 'owner'; text: string; attachments?: OwnerAttachment[] }
  | { kind: 'agent'; text: string }
  /** `pending`: the step has started and its result is not back yet; the row is updated in place when it is. */
  | { kind: 'action'; text: string; outcome: 'pending' | 'ok' | 'refused' | 'unknown' | 'error' | 'skipped'; detail?: string;
      /** A screenshot the action took; `expired` once only the newest ones are kept. */
      image?: { id: string; width: number; height: number; bytes?: number; expired?: boolean } }
  /** A file the agent made for the owner to download. */
  | { kind: 'file'; id: string; name: string; mimeType: string; bytes: number; expired?: boolean }
  | { kind: 'notice'; text: string };

export interface PanelState {
  status: RunStatus;
  pauseReason?: string;
  transcript: TranscriptEntry[];
  handedTab: { title: string; url: string } | null;
  connection: { label: string; model: string } | null;
  actions: number;
  /** A card waiting for the owner. */
  approval?: Approval;
  /** Ask before each new site, or Auto: sites approved without a card, searches and filters too (a form that sends data still asks). */
  mode: 'ask' | 'auto';
  /** The tab the conversation works in now; a follow-up continues there unless the owner picks another. */
  workspace: { title: string; url: string } | null;
  /** Learning: the step the agent is waiting to take, until the owner says Next. */
  stepWait?: { text: string; why?: string };
  /** Learning is on: each step is explained and waits for Next. */
  learning: boolean;
  /** A question from the agent, waiting for the owner's pick (ask.ts). */
  question?: Question;
}

/** A question the agent asked with `ask_owner`. Its words are the model's, and may come from a page: never an approval. */
export interface Question {
  id: string;
  question: string;
  /** The first is the one the agent recommends. */
  options: Array<{ label: string; hint?: string }>;
  multi: boolean;
}

export interface Approval {
  id: string;
  kind: 'origin' | 'submit';
  origin: string;
  /** navigate: the agent wants to open it; link: a link it wants to click; blocked: a page tried to send it there; landed: the tab ended up there; submit: a form submission. */
  reason: 'navigate' | 'link' | 'blocked' | 'landed' | 'submit';
  /** For a submission: where it goes and what the agent filled in. */
  submit?: { action: string; method: string; submitter: string; fields: Array<{ name: string; value: string }> };
}

/** An attachment as the transcript shows it: images by their stored thumbnail, other files by name. */
export interface OwnerAttachment { kind: Attachment['kind']; name: string; bytes: number; id?: string; width?: number; height?: number }

export type WorkerMessage =
  | { type: 'state'; state: PanelState }
  | { type: 'captured'; requestId: string; image?: { data: string; width: number; height: number; title: string }; error?: string }
  | { type: 'skill-draft'; requestId: string; draft?: { name: string; sites: string[]; text: string }; error?: string }
  | { type: 'trace'; requestId: string; json: string };
