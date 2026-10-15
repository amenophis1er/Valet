/*
 * What an input action gets from the executor: a narrow, explicit interface.
 *
 * The executor (commands.ts) owns the sessions, the tabs, the debugger and the
 * observation; the input actions (input/*) own how a click, a key or a drag is
 * made. Between them is this interface, so an input action cannot reach past
 * the checks every one of them shares — aiming at a ref that is still current,
 * in a tab that is still the conversation's, on the page it was read from.
 */

import type { TabInfo } from './chrome.js';
import type { Cancellation, Command } from './protocol.js';

/** What a ref points at, and what it looked like, so a semantic target can find it again. */
export interface Ref {
  tabKey: string; tabId: number; frameId: number; local: string; frame: number; role: string; name: string;
  /** The document the ref was read from, and the observation it belongs to. */
  docUrl: string; generation: number;
  /** Chrome's id for that document; a script aimed at it fails once the frame navigates. */
  documentId?: string;
}

export interface Point { x: number; y: number }
/** One Chrome DevTools Protocol command on the attached tab. */
export type Send = (method: string, params?: unknown) => Promise<unknown>;
export type Pace = 'fast' | 'natural';

/** What the page side says about an element it was asked to act on. */
export interface Located { point?: Point; setByValue?: boolean; keyByKey?: boolean; multiline?: boolean; password?: boolean }

/** An alert, confirm or prompt a page has open: its words are the page's. */
export interface OpenDialog { type: 'alert' | 'confirm' | 'prompt' | 'beforeunload'; message: string; defaultValue?: string }

/** The debugger was refused on this tab because of another extension's frame; `sent` says how much of the action had gone through it before. */
export class DebuggerKeptOut extends Error {
  constructor(message: string, readonly sent: number) { super(message); }
}
/** Why a password field is never filled. The page side says the same if the field changed under the check (content.ts). */
export const PASSWORD = 'Passwords are entered by the owner, never by the agent. Ask the owner to sign in in this tab.';
export const DEBUGGER_KEPT_OUT = 'Another extension has a frame of its own in this page (a password manager\'s menu, for instance), and Chrome keeps the agent\'s debugger out while it is there.';

export interface Driver {
  /** The owner's pace, for this action: natural moves and types like a person. */
  readonly pace: Pace;
  wait(ms: number): Promise<void>;
  random(): number;
  /** Where the mouse was last left in each tab, so the next move starts there. */
  readonly mouse: Map<number, Point>;

  /** The element a command targets, checked: a ref of the latest observation, in a tab of the conversation, on the page that was read. */
  aim(command: Command, cancel: Cancellation): Promise<{ ref: Ref; tab: TabInfo }>;
  /** Another element of the same observation (a drag's end). */
  refFor(sessionId: string, target: unknown): Promise<Ref>;
  /** Ask the page side about the element, and prepare it as asked (scroll it into view, focus it, clear it). */
  locate(ref: Ref, options?: { focus?: boolean; clear?: boolean; mark?: boolean; still?: boolean }): Promise<Located>;
  /** The element's point in the tab's viewport; undefined past a frame from another site. */
  viewportPoint(ref: Ref, local: Point | undefined): Promise<Point | undefined>;
  /** Show the agent's cursor at a point, and let the owner see it get there. */
  pointAt(sessionId: string, tabId: number, point: Point | undefined): Promise<void>;
  /** Run a page-side function (page.ts) in the ref's own document. */
  script<Args extends unknown[], Result>(ref: Ref, func: (...args: Args) => Result, args: Args): Promise<Result | undefined>;
  /** The debugger, for this action only. */
  withDebugger<T>(tabId: number, body: (send: Send) => Promise<T>): Promise<T>;
  /** Through the debugger, or — when another extension's frame keeps it out — the page's own events. */
  driven<T>(viaDebugger: () => Promise<T>, viaPage: () => Promise<T>, repeatable?: boolean): Promise<T>;
  /** Wait for what the action set off (a navigation, a re-render) to calm down. */
  settle(tabId: number, before: TabInfo): Promise<void>;

  /** For scroll, which names no element: the tab of the latest observation, checked to still show that page. */
  observedTab(sessionId: string): Promise<number>;
  /** The dialog a tab has open, if the executor saw it open. */
  dialog(tabId: number): OpenDialog | undefined;
  /** Answer the tab's open dialog: OK (with the prompt's text) or Cancel; a precondition failure when none is open. */
  answerDialog(tabId: number, accept: boolean, text: string | undefined): Promise<void>;
  /** Make sure the content script is in the tab. */
  ready(tabId: number): Promise<void>;
  /** Run a page-side function in a whole tab. */
  inTab<Args extends unknown[]>(tabId: number, func: (...args: Args) => unknown, args: Args): Promise<void>;
}

/** One input action: a command in, the page acted on. */
export type InputAction = (driver: Driver, command: Command, cancel: Cancellation) => Promise<Record<string, never>>;

export function arg(command: Command, key: string): string | undefined {
  const value = command.args[key];
  return typeof value === 'string' ? value : undefined;
}
