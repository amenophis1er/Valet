/*
 * The executor: one command in, one browser action out.
 *
 * A session (one conversation) works in the tab the owner handed it — the
 * page they had open when they asked — and in the tabs it opens itself,
 * which open in the background right beside the tab the conversation is on,
 * with the halo and the agent's cursor showing which they are. `close` takes
 * them away again; a crashed worker does not, because by then those tabs are
 * the owner's.
 *
 * This file owns the sessions, the tabs, observation, screenshots and the
 * debugger. How each input is made — a click, a key, a drag — is in input/*,
 * one file per action, reached through the narrow Driver interface
 * (driver.ts). Code that runs inside pages is in page.ts and overlay.ts.
 *
 * Input goes through the debugger rather than through synthetic DOM events:
 * `Input.dispatchMouseEvent` reaches a background tab and produces trusted
 * events. Where the debugger cannot reach — a frame from another site, or a
 * tab another extension's frame keeps it out of — the page side acts on the
 * element directly.
 */

import type { TabInfo, WorkerChrome } from './chrome.js';
import { Cancellation, PreconditionError, type Command, type CommandResult, type Observation, type ObservedTarget } from './protocol.js';
import type { SubmitFingerprint } from './content.js';
import { DEBUGGER_KEPT_OUT, DebuggerKeptOut, type Driver, type OpenDialog, type Pace, type Ref } from './driver.js';
import { INPUT, type InputName } from './input/index.js';
import { paintOverlay } from './overlay.js';
import { cut } from './tree.js';
import { frameOffsetRef, listFrames, locateRef, pointAtRef, readObservation, readOrigin, readPageText, readReadyState, readViewport, submitFactsRef, tokenRef, type FrameObservation } from './page.js';

export type { Pace } from './driver.js';

interface Session {
  id: string;
  tabs: Map<string, number>;
  active: string | null;
  /** Tab keys the owner handed over: never closed. */
  handed: Set<string>;
  /** The group the conversation's tabs are in, once it opened one: the owner's tab and the agent's together. */
  groupId: number;
  /** The owner's tab this session put in that group (not one already in a group of theirs): ungrouped when the agent's tabs close. */
  groupedOwnerTab?: number;
  /** Bumped by every observation, so a ref from an older one is recognisable. */
  generation: number;
  /** The tab and page the last observation described: its main frame's URL, and its document when Chrome named it. */
  observed?: { generation: number; tabKey: string; url: string; documentId?: string };
}

/** One frame of an observation, for the run controller (redaction, scope). Never shown to the model. */
export interface FrameInfo { index: number; frameId: number; documentId?: string; origin: string; url: string }

/** What the executor returns from `observe`: the model's observation plus the frame metadata. */
export interface ExecutorObservation extends Observation { frames: FrameInfo[] }

/** The group a conversation's tabs make with the owner's tab. */
const GROUP_TITLE = 'valet';
/** Chrome's words when a frame of another extension is in the tab: its debugger stays out of the whole tab while that frame is there. */
const OTHER_EXTENSION = /chrome-extension:\/\/ URL of different extension/i;
/** Chrome's words when the frame appears mid-action (at the first keystroke, as a password manager's menu does): the attachment is taken away under the command. */
const DETACHED_UNDER_COMMAND = /Detached while handling command|Debugger is not attached/i;

/** The page under a ref is not the page the ref was read from. */
const MOVED = 'This page has changed since that observation. Observe again.';
const STALE = 'Stale page observation. Observe again and use a fresh ref.';
/** The owner's Chrome withholds site access from the extension (Details → Site access). */
const NO_ACCESS = 'The extension is not allowed to read this site. Ask the owner to set Valet\'s site access to "On all sites" (chrome://extensions → Details), then observe again.';


/** The executor reads the main frame plus ten, and caps the whole tree at 32k. */
const MAX_FRAMES = 11;
const MAX_TREE = 32_000;
const MAX_TARGETS = 240;
const LOAD_TIMEOUT = 30_000;
/** How long a click or a key gets to turn into a navigation before we stop watching. */
const SETTLE_MS = 600;
const SETTLE_STEP_MS = 50;
/** The waits before each retry when the page gave no observation: a heavy page, or a tab the content script missed. */
const OBSERVE_RETRY_MS = [500, 1_000, 2_000];
/** How long the agent's cursor takes to glide to a target before it acts. */
const CURSOR_MS = 350;

/** How long Page.enable gets to come back before the renderer is taken to be held by a dialog. */
const ENABLE_TIMEOUT_MS = 2_000;
/** How long an input command gets before the page is taken to be held by a dialog nobody heard open. */
const INPUT_TIMEOUT_MS = 10_000;
const UNANSWERED = Symbol('unanswered');
/** The words for a dialog that opened while nothing was attached: its real text was never heard. */
const UNSEEN_DIALOG = 'A dialog opened while the agent was not watching, so its text is not known';

/** A dialog, as the model is told of it: what kind, its words (the page's), and a prompt's default. */
function describeDialog(open: OpenDialog): string {
  const quoted = JSON.stringify(open.message.slice(0, 500));
  const suffix = open.type === 'prompt' && open.defaultValue ? ` (default answer ${JSON.stringify(open.defaultValue.slice(0, 200))})` : '';
  return `The page has a ${open.type} dialog open and waits for it: ${quoted}${suffix}.`;
}

/**
 * How the agent's input moves: `fast` does each action at once; `natural`
 * types letter by letter, moves the mouse along a curve, scrolls in steps and
 * pauses between actions, so the owner can follow along. Real input either
 * way (the debugger); only the rhythm changes. Never a disguise: no fake
 * mistakes, no wandering.
 */

/** What the agent is about to do, shown in a bubble at its cursor (Learning). */
export interface Note { text: string; why?: string; waiting: boolean }


function str(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' ? value : undefined;
}

/** Only http(s). A chrome:// or file:// tab is not somewhere an agent gets to go. */
function checkUrl(url: string): string {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new PreconditionError(`${url} is not an address this browser can open.`); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new PreconditionError('Only http and https addresses can be opened in your browser.');
  return parsed.toString();
}

/** A URL as the "same page" check compares it: through one parser, without the fragment, which a page changes without leaving its document (maps, hash routers). */
/** How much of a page's text one `read` returns: a few thousand words. */
export const READ_PART_CHARS = 12_000;

/**
 * A page's text in parts of about `size` characters, cut between paragraphs
 * (a paragraph longer than a part is cut where it must).
 */
export function textParts(text: string, size = READ_PART_CHARS): string[] {
  const parts: string[] = [];
  let current = '';
  for (const paragraph of text.split(/\n{2,}/)) {
    let rest = paragraph;
    while (rest.length > size) {
      if (current) { parts.push(current); current = ''; }
      const cut = Math.max(rest.lastIndexOf(' ', size), size / 2);
      parts.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (current && current.length + rest.length + 2 > size) { parts.push(current); current = ''; }
    current = current ? `${current}\n\n${rest}` : rest;
  }
  if (current.trim()) parts.push(current);
  return parts.length > 0 ? parts : [''];
}

/** scheme://host:port of a URL, or the URL itself when it does not parse. */
function originOf(url: string): string {
  try { return new URL(url).origin; } catch { return url; }
}

function normalize(url: string): string {
  try { const parsed = new URL(url); parsed.hash = ''; return parsed.toString(); } catch { return url; }
}

/** A script target: the exact document when Chrome gave us its id, else the frame. */
function frameTarget(ref: Ref): { tabId: number; frameIds?: number[]; documentIds?: string[] } {
  return ref.documentId ? { tabId: ref.tabId, documentIds: [ref.documentId] } : { tabId: ref.tabId, frameIds: [ref.frameId] };
}

/** A session's tabs as they are kept across worker restarts. */
interface Snapshot {
  sessions: Array<[string, { tabs: Array<[string, number]>; active: string | null; handed: string[]; groupId?: number; groupedOwnerTab?: number }]>;
}

export interface Executor { run(command: Command, cancel?: Cancellation): Promise<CommandResult> }

export class BrowserCommands implements Executor {
  #chrome: WorkerChrome;
  #sessions = new Map<string, Session>();
  /** Refs are handed out per observation; the next command resolves them here. */
  #refs = new Map<string, Map<string, Ref>>();
  /** The frames of each session's latest observation, to place a point's ref in its frame. */
  #frameInfos = new Map<string, FrameInfo[]>();
  #uuid: () => string;
  #contentFile: string;
  #wait: (ms: number) => Promise<void>;
  /** Called with a tab id before it navigates anywhere, so containment rules cover it first. */
  #beforeNavigate: (tabId: number) => Promise<void>;
  /** Sessions whose tabs show the halo and the agent's cursor (while a run is active). */
  #highlighted = new Set<string>();
  /** How many commands hold the debugger on each tab. Reference-counted, not serialized. */
  #attached = new Map<number, number>();
  /** An attach under way per tab: a second claim waits for it rather than attaching twice. */
  #attaching = new Map<number, Promise<void>>();
  #imaging: Imaging;
  #pace: Pace = 'fast';
  #pacePick: Pace = 'fast';
  #learning = false;
  #store?: { get(): Promise<unknown>; set(value: unknown): Promise<void> };
  /** Writes of the tab snapshot, one after another. */
  #persisting: Promise<void> = Promise.resolve();
  #anchorOf: ((session: string) => number | undefined) | undefined;
  #random: () => number;
  /** Where the real mouse last was in each tab, so a natural move starts from there. */
  #mouse = new Map<number, { x: number; y: number }>();
  /**
   * The alert, confirm or prompt each tab has open, from the Page events of the
   * attached debugger. While one is open the page takes no input and runs no
   * script: an observation says only that, and other actions on the tab are
   * refused until the dialog action answers it.
   */
  #dialogs = new Map<number, OpenDialog>();
  /** Who is waiting to hear that a dialog opened on a tab: a debugger command in flight there, which the dialog would otherwise hold up. */
  #dialogWaiters = new Map<number, Set<() => void>>();
  /** Tabs whose open dialog holds the debugger attached (one count of #attached), so the dialog outlives the action that opened it and its closing is heard. */
  #dialogHolds = new Set<number>();

  constructor(chrome: WorkerChrome, options: { uuid?: () => string; contentFile?: string; wait?: (ms: number) => Promise<void>; beforeNavigate?: (tabId: number) => Promise<void>; imaging?: Imaging; random?: () => number;
    /** The tab a session's conversation belongs to: its new tabs open beside it when no tab was handed over. */
    anchor?: (session: string) => number | undefined;
    /** Where the sessions' tabs are kept, so a restarted worker still knows them (chrome.storage.session). */
    store?: { get(): Promise<unknown>; set(value: unknown): Promise<void> } } = {}) {
    this.#chrome = chrome;
    this.#imaging = options.imaging ?? canvasImaging;
    this.#random = options.random ?? Math.random;
    this.#store = options.store;
    this.#anchorOf = options.anchor;
    this.#beforeNavigate = options.beforeNavigate ?? (async () => undefined);
    this.#wait = options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    // Chrome took the debugger back: the tab closed, the owner dismissed the
    // yellow bar, or another client attached. The next command attaches again.
    chrome.debugger.onDetach.addListener((source) => {
      if (source.tabId !== undefined) this.#attached.delete(source.tabId);
    });
    // A dialog opening or closing on a tab, while the debugger is attached there with Page enabled.
    chrome.debugger.onEvent.addListener((source, method, params) => {
      const tabId = source.tabId;
      if (tabId === undefined) return;
      if (method === 'Page.javascriptDialogOpening') {
        const opening = (params ?? {}) as { type?: string; message?: string; defaultPrompt?: string };
        const type = (['alert', 'confirm', 'prompt', 'beforeunload'] as const).find((known) => known === opening.type) ?? 'alert';
        // Chrome sends an empty defaultPrompt for every kind; only a prompt's own default is worth telling.
        this.#dialogs.set(tabId, { type, message: String(opening.message ?? ''), ...(type === 'prompt' && opening.defaultPrompt ? { defaultValue: String(opening.defaultPrompt) } : {}) });
        // The dialog holds the attachment: detaching with it up would let Chrome close it unanswered, and its closing would go unheard.
        if ((this.#attached.get(tabId) ?? 0) > 0 && !this.#dialogHolds.has(tabId)) {
          this.#dialogHolds.add(tabId);
          this.#attached.set(tabId, (this.#attached.get(tabId) ?? 0) + 1);
        }
        for (const wake of this.#dialogWaiters.get(tabId) ?? []) wake();
      } else if (method === 'Page.javascriptDialogClosed') {
        this.#dialogs.delete(tabId);
        void this.#releaseDialogHold(tabId);
      }
    });
    this.#uuid = options.uuid ?? (() => crypto.randomUUID());
    this.#contentFile = options.contentFile ?? 'content.js';
  }

  /**
   * Chrome stops an idle worker after about 30 seconds. What a session knows
   * about its tabs — which ones, which was handed over, which is active —
   * is kept, so a follow-up continues in the same tabs.
   * Observations are not: after a restart the agent reads the page again.
   */
  async restore(): Promise<void> {
    const saved = await this.#store?.get().catch(() => undefined) as Snapshot | undefined;
    if (!saved || !Array.isArray(saved.sessions)) return;
    for (const [id, session] of saved.sessions) {
      this.#sessions.set(id, { id, tabs: new Map(session.tabs), active: session.active, handed: new Set(session.handed), generation: 0,
        groupId: session.groupId ?? -1, ...(session.groupedOwnerTab !== undefined ? { groupedOwnerTab: session.groupedOwnerTab } : {}) });
    }
  }

  #persist(): void {
    if (!this.#store) return;
    const snapshot: Snapshot = {
      sessions: [...this.#sessions].map(([id, session]) => [id, { tabs: [...session.tabs], active: session.active, handed: [...session.handed], groupId: session.groupId,
        ...(session.groupedOwnerTab !== undefined ? { groupedOwnerTab: session.groupedOwnerTab } : {}) }]),
    };
    const store = this.#store;
    this.#persisting = this.#persisting.then(() => store.set(snapshot)).catch(() => undefined);
  }

  /** The owner's Settings choice; takes effect from the next action. */
  setPace(pace: Pace): void {
    this.#pacePick = pace === 'natural' ? 'natural' : 'fast';
    this.#pace = this.#learning ? 'natural' : this.#pacePick;
  }

  /** Learning: the owner watches each step, so the agent moves at the natural pace while it is on. */
  setLearning(on: boolean): void {
    this.#learning = on;
    this.#pace = on ? 'natural' : this.#pacePick;
  }

  get pace(): Pace { return this.#pace; }

  /** A random wait between `min` and `max` ms that a Stop cuts short. */
  async #pause(min: number, max: number, cancel: Cancellation): Promise<void> {
    await this.#wait(Math.round(min + (max - min) * this.#random()));
    cancel.check();
  }

  async run(command: Command, cancel: Cancellation = new Cancellation()): Promise<CommandResult> {
    try {
      return await this.#dispatch(command, cancel);
    } finally {
      // Commands open, switch, forget and close tabs: keep what the session knows.
      this.#persist();
    }
  }

  async #dispatch(command: Command, cancel: Cancellation): Promise<CommandResult> {
    cancel.check();
    // An input action (input/*): natural pace takes a beat first, as a person would, before anything is dispatched.
    // A page with a dialog open takes no input and runs no script until it is answered: nothing but the answer goes to it.
    if (command.name !== 'dialog' && (command.name in INPUT || command.name === 'screenshot')) {
      const open = this.#openDialog(command.session);
      if (open) throw new PreconditionError(`${describeDialog(open)} Answer it with the dialog action first.`);
    }
    if (command.name in INPUT) {
      if (this.#pace === 'natural') await this.#pause(500, 1500, cancel);
      // A pointer action aims at a point of the viewport, and the first attach in a tab shows Chrome's debugging bar,
      // which moves the page down after the point was read: the first click on a fresh page missed its button.
      // So the debugger is attached, and the viewport given time to settle, before the action measures anything.
      // (Reference-counted: the action's own attach then changes nothing.) Kept out, the action finds that out itself.
      const pointer = command.name === 'click' || command.name === 'hover' || command.name === 'drag';
      const session = pointer ? this.#sessions.get(command.session) : undefined;
      const tabId = session?.active ? session.tabs.get(session.active) : undefined;
      let held = false;
      if (tabId !== undefined) {
        try {
          await this.#claimDebugger(tabId);
          held = true;
          await this.#settledViewport(tabId);
        } catch { /* refused or kept out: the action reports it in its own words */ }
      }
      try {
        return await INPUT[command.name as InputName](this.#driver, command, cancel);
      } finally {
        if (held) await this.#releaseDebugger(tabId!);
      }
    }
    // The rest manage tabs and read the page: the executor's own work.
    switch (command.name) {
      case 'navigate': return this.#navigate(command, cancel);
      case 'observe': return { observation: await this.observe(command.session, cancel) };
      case 'tab': return this.#tab(command);
      case 'screenshot': return { screenshot: (await this.capture(command.session, cancel, () => true)).data };
      case 'close': return this.#close(command, cancel);
      default: throw new PreconditionError(`This browser cannot run ${String(command.name)}.`);
    }
  }

  /**
   * What the input actions get: the checks every one of them shares and the
   * means to act, and nothing else of the executor (driver.ts).
   */
  #driver: Driver = this.#makeDriver();

  /** The dialog open on the session's current tab, if the executor saw one open there. */
  #openDialog(sessionId: string): OpenDialog | undefined {
    const session = this.#sessions.get(sessionId);
    const tabId = session?.active ? session.tabs.get(session.active) : undefined;
    return tabId === undefined ? undefined : this.#dialogs.get(tabId);
  }

  #makeDriver(): Driver {
    // The getter reads the executor's pace at the moment of each step.
    const executor = this;
    return {
    get pace() { return executor.#pace; },
    wait: (ms) => this.#wait(ms),
    random: () => this.#random(),
    mouse: this.#mouse,
    aim: (command, cancel) => this.#aim(command, cancel),
    refFor: async (sessionId, target) => this.#ref(sessionId, await this.#session(sessionId), target),
    locate: (ref, options) => this.#locate(ref, options),
    viewportPoint: (ref, local) => this.#viewportPoint(ref, local),
    pointAt: (sessionId, tabId, point) => this.#pointAt(sessionId, tabId, point),
    script: (ref, func, args) => this.#script(ref, func, args),
    withDebugger: (tabId, body) => this.#withDebugger(tabId, body),
    driven: (viaDebugger, viaPage, repeatable) => this.#driven(viaDebugger, viaPage, repeatable),
    settle: (tabId, before) => this.#settle(tabId, before),
    observedTab: (sessionId) => this.#observedTab(sessionId),
    ready: async (tabId) => { await this.#inject(tabId); },
    inTab: async (tabId, func, args) => { await this.#chrome.scripting.executeScript({ target: { tabId }, func, args }); },
    dialog: (tabId) => this.#dialogs.get(tabId),
    answerDialog: (tabId, accept, text) => this.#answerDialog(tabId, accept, text),
    };
  }

  /**
   * Answer the tab's dialog through the debugger. One the executor never saw
   * open (it opened while nothing was attached) is answered just the same;
   * Chrome says when there is none, and that is a plain refusal.
   */
  async #answerDialog(tabId: number, accept: boolean, text: string | undefined): Promise<void> {
    const before = await this.#chrome.tabs.get(tabId).catch(() => undefined);
    try {
      await this.#withDebugger(tabId, (send) => send('Page.handleJavaScriptDialog', { accept, ...(accept && text !== undefined ? { promptText: text } : {}) }));
    } catch (error) {
      const said = error instanceof Error ? error.message : String(error);
      if (/no dialog/i.test(said)) {
        this.#dialogs.delete(tabId);
        await this.#releaseDialogHold(tabId);
        throw new PreconditionError('No dialog is open on this page.');
      }
      throw error;
    }
    this.#dialogs.delete(tabId);
    await this.#releaseDialogHold(tabId);
    // Accepting a confirm, or a beforeunload, may let a navigation go: wait for it as after a click.
    if (before) await this.#settle(tabId, before);
  }

  /** The dialog no longer holds the attachment (answered, or closed some other way): let go of its count. */
  async #releaseDialogHold(tabId: number): Promise<void> {
    if (!this.#dialogHolds.delete(tabId)) return;
    await this.#releaseDebugger(tabId);
  }

  /** The tab of the session's latest observation, still on the page that was read (scroll aims at no element). */
  async #observedTab(sessionId: string): Promise<number> {
    const session = await this.#session(sessionId);
    const observed = session.observed;
    if (!observed || observed.generation !== session.generation) throw new PreconditionError('Stale page observation. Observe again before scrolling.');
    const tab = await this.#ownTab(session, observed.tabKey);
    await this.#onObservedPage(tab, observed.url, observed.documentId);
    return tab.id!;
  }


  /** The tab the session works in now, as the owner would recognize it. */
  async workspace(sessionId: string): Promise<{ title: string; url: string } | null> {
    const session = this.#sessions.get(sessionId);
    const tabId = session?.active ? session.tabs.get(session.active) : undefined;
    if (tabId === undefined) return null;
    const tab = await this.#chrome.tabs.get(tabId).catch(() => undefined);
    return tab ? { title: tab.title ?? '', url: tab.url ?? '' } : null;
  }

  /** Chrome tab ids of this session's tabs (handed and agent-opened), for the containment rules. */
  tabIds(sessionId: string): number[] {
    return [...(this.#sessions.get(sessionId)?.tabs.values() ?? [])];
  }

  /** Whether this session has a tab to observe: a navigate opened one and it has not been forgotten. */
  hasTab(sessionId: string): boolean {
    return (this.#sessions.get(sessionId)?.active ?? null) !== null;
  }

  /** Forget every session and ref. The tabs themselves stay open: they are the owner's now. */
  reset(): void {
    this.#sessions.clear();
    this.#refs.clear();
  }

  /** Forget one session: its conversation is over. Its tabs stay open as the owner's. */
  drop(sessionId: string): void {
    const session = this.#sessions.get(sessionId);
    if (session) void this.#releaseGroup(session);
    this.#sessions.delete(sessionId);
    this.#refs.delete(sessionId);
    this.#persist();
  }

  /** The owner's tab leaves the conversation's group, if this session put it there and it is still there. */
  async #releaseGroup(session: Session, alsoOut: number[] = []): Promise<void> {
    const groupId = session.groupId;
    const ownerTab = session.groupedOwnerTab;
    session.groupedOwnerTab = undefined;
    session.groupId = -1;
    if (groupId < 0) return;
    // Only out of the conversation's own group: a tab the owner has since moved into a group of theirs stays there.
    const out: number[] = [];
    for (const tabId of [...(ownerTab === undefined ? [] : [ownerTab]), ...alsoOut]) {
      const tab = await this.#chrome.tabs.get(tabId).catch(() => undefined);
      if (tab && tab.groupId === groupId) out.push(tabId);
    }
    if (out.length > 0) await this.#chrome.tabs.ungroup(out).catch(() => undefined);
  }

  /* ---- sessions and tabs ---- */

  async #session(session: string): Promise<Session> {
    const existing = this.#sessions.get(session);
    if (existing) return existing;
    const created: Session = { id: session, tabs: new Map(), active: null, handed: new Set(), generation: 0, groupId: -1 };
    this.#sessions.set(session, created);
    return created;
  }

  #forget(session: Session, key: string): void {
    session.tabs.delete(key);
    session.handed.delete(key);
    if (session.active === key) session.active = null;
    if (session.observed?.tabKey === key) session.observed = undefined;
    this.#persist();
  }

  /** This session's tab, if it is still open; a tab the owner closed is forgotten here. */
  async #ownTab(session: Session, key: string): Promise<TabInfo> {
    const tabId = session.tabs.get(key);
    if (tabId === undefined) throw new PreconditionError('This conversation has no browser tab yet. Navigate to open one.');
    const tab = await this.#chrome.tabs.get(tabId).catch(() => undefined);
    if (!tab) { this.#forget(session, key); throw new PreconditionError('That tab is gone. Observe again to continue in a new one.'); }
    return tab;
  }

  /**
   * Hand the owner's tab to this session: the page they had open when
   * they asked. It becomes the active tab and stays where the owner put it.
   * Evidence about any other tab is dropped.
   */
  async adopt(sessionId: string, tabId: number): Promise<string> {
    const session = await this.#session(sessionId);
    const tab = await this.#chrome.tabs.get(tabId).catch(() => undefined);
    if (!tab || tab.id === undefined) throw new PreconditionError('That tab is gone.');
    this.#liveUrl(tab);
    const existing = [...session.tabs].find(([, id]) => id === tabId)?.[0];
    const key = existing ?? `tab-${this.#uuid().slice(0, 12)}`;
    session.tabs.set(key, tabId);
    session.handed.add(key);
    session.active = key;
    session.observed = undefined;
    this.#refs.delete(sessionId);
    this.#persist();
    return key;
  }

  /**
   * Whether acting on `target` would submit a form, and the fingerprint of what
   * it would send. A locate-only pass: nothing is
   * focused, cleared or dispatched. A stale target is refused like any other.
   */
  async submitFacts(sessionId: string, target: unknown, via: 'click' | 'enter' | 'space'): Promise<{ submits: boolean; fingerprint?: SubmitFingerprint & { documentId?: string } }> {
    const session = await this.#session(sessionId);
    const ref = this.#ref(sessionId, session, target);
    const result = await this.#script<[string, 'click' | 'enter' | 'space'], { ok: boolean; reason?: string; submits?: boolean; fingerprint?: SubmitFingerprint }>(
      ref, submitFactsRef, [ref.local, via]);
    if (!result?.ok) throw new PreconditionError(result?.reason ?? 'The referenced element changed or disappeared.');
    if (!result.submits || !result.fingerprint) return { submits: false };
    return { submits: true, fingerprint: { ...result.fingerprint, ...(ref.documentId ? { documentId: ref.documentId } : {}) } };
  }

  /**
   * The element under a point of the active tab's viewport, given a ref in the
   * latest observation, so the click that follows is checked like any other.
   */
  async refAt(sessionId: string, point: { x: number; y: number }): Promise<{ ref: string; role: string; name: string; href?: string }> {
    const session = await this.#session(sessionId);
    const key = this.#activeKey(session);
    const tab = await this.#ownTab(session, key);
    const observed = session.observed;
    if (!observed || observed.generation !== session.generation || observed.tabKey !== key) throw new PreconditionError(STALE);
    await this.#onObservedPage(tab, observed.url, observed.documentId);
    const [answer] = await this.#chrome.scripting.executeScript<[number, number], ReturnType<typeof pointAtRef>>({ target: { tabId: tab.id!, frameIds: [0] }, func: pointAtRef, args: [point.x, point.y] }).catch(() => []);
    const result = answer?.result;
    if (!result?.ok || !result.ref) throw new PreconditionError(result?.reason ?? 'The page was reloaded. Observe again.');
    // A point that landed in a frame of the same site: the ref is that document's, found by the token it answered.
    let frameId = 0;
    let documentId: string | undefined;
    if (result.token) {
      const answers = await this.#chrome.scripting.executeScript<[], string | null>({ target: await this.#frames(tab.id!), func: tokenRef }).catch(() => []);
      const home = answers.find((frame) => frame.result === result.token);
      if (!home) throw new PreconditionError('The frame under that point could not be found. Observe again.');
      frameId = home.frameId;
      documentId = home.documentId;
    }
    const index = (this.#frameInfos.get(sessionId) ?? []).find((info) => info.frameId === frameId)?.index ?? 0;
    const table = this.#refs.get(sessionId) ?? new Map<string, Ref>();
    this.#refs.set(sessionId, table);
    table.set(result.ref, { tabKey: key, tabId: tab.id!, frameId, local: result.ref, frame: index, role: result.role ?? '', name: result.name ?? '', docUrl: observed.url, generation: session.generation,
      ...(documentId ? { documentId } : frameId === 0 && observed.documentId ? { documentId: observed.documentId } : {}) });
    return { ref: result.ref, role: result.role ?? '', name: result.name ?? '', ...(result.href ? { href: result.href } : {}) };
  }

  /**
   * One part of the active tab's text (`read`): the page's main content as
   * light Markdown (page.ts), split into parts. Only a page on an origin the
   * run allows is read, as for a screenshot. Nothing is dispatched, and the
   * latest observation stays valid.
   */
  async readText(sessionId: string, part: number, cancel: Cancellation = new Cancellation(), allowOrigin: (origin: string) => boolean = () => true): Promise<{ url: string; title: string; part: number; parts: number; text: string }> {
    const session = await this.#session(sessionId);
    const tab = await this.#ownTab(session, this.#activeKey(session));
    const top = originOf(this.#liveUrl(tab));
    if (!allowOrigin(top)) throw new PreconditionError(`The tab is on ${top}, which is not allowed for this run, so it was not read.`);
    cancel.check();
    const [answer] = await this.#chrome.scripting.executeScript<[], ReturnType<typeof readPageText>>({ target: { tabId: tab.id!, frameIds: [0] }, func: readPageText })
      .catch((error: unknown) => { throw new PreconditionError(`The page could not be read (${error instanceof Error ? error.message : String(error)}).`); });
    cancel.check();
    const page = answer?.result;
    if (!page) throw new PreconditionError('The page did not answer. Wait a moment and read again.');
    const parts = textParts(page.text);
    if (part > parts.length) throw new PreconditionError(`This page's text has ${parts.length} part${parts.length === 1 ? '' : 's'}; there is no part ${part}.`);
    return { url: page.url, title: page.title, part, parts: parts.length, text: parts[part - 1]! };
  }

  /** Step the active tab back one page (after a blocked navigation left it on Chrome's error page). */
  async back(sessionId: string): Promise<void> {
    const session = await this.#session(sessionId);
    const key = session.active;
    const tabId = key ? session.tabs.get(key) : undefined;
    if (tabId !== undefined) await this.#chrome.tabs.goBack(tabId).catch(() => undefined);
  }

  /** Give every handed tab back to the owner, untouched: the session only forgets it. */
  release(sessionId: string): void {
    const session = this.#sessions.get(sessionId);
    if (!session) return;
    for (const key of [...session.handed]) this.#forget(session, key);
    this.#persist();
  }

  /**
   * A new tab joins the conversation's group: the group the owner's tab is
   * already in, else a new one made of the owner's tab and this one, titled
   * for the conversation. The owner's tab is put back out when the agent's
   * tabs close. A tab that cannot be grouped (pinned) leaves the new tab beside it, ungrouped.
   */
  async #group(session: Session, anchor: TabInfo | undefined, tabId: number): Promise<void> {
    // Chrome refuses to edit the tab strip while it animates (a tab was just inserted) or the owner drags a tab: try again shortly.
    const group = async (options: { tabIds: number[]; groupId?: number }): Promise<number> => {
      for (let attempt = 0; ; attempt += 1) {
        try { return await this.#chrome.tabs.group(options); }
        catch (error) {
          if (attempt >= 10 || !/cannot be edited|dragging/i.test(error instanceof Error ? error.message : String(error))) throw error;
          await this.#wait(100);
        }
      }
    };
    try {
      if (session.groupId >= 0) {
        await group({ tabIds: [tabId], groupId: session.groupId });
        return;
      }
      if (anchor?.id === undefined) return;
      if (anchor.groupId !== undefined && anchor.groupId >= 0) {
        session.groupId = await group({ tabIds: [tabId], groupId: anchor.groupId });
        return;
      }
      if (anchor.pinned) return;
      session.groupId = await group({ tabIds: [anchor.id, tabId] });
      session.groupedOwnerTab = anchor.id;
      await this.#chrome.tabGroups.update(session.groupId, { title: GROUP_TITLE, color: 'cyan', collapsed: false }).catch(() => undefined);
    } catch (error) {
      // Chrome would not group it (another window, a pinned tab): the tab stays beside the owner's, ungrouped.
      console.warn('Valet: the new tab could not join the group:', error instanceof Error ? error.message : String(error));
      session.groupId = -1;
    }
  }

  #activeKey(session: Session): string {
    if (!session.active) throw new PreconditionError('This conversation has no browser tab yet. Navigate to open one.');
    return session.active;
  }

  /** Is the owner looking at this tab right now: active in the focused window? */
  async #watched(tab: TabInfo): Promise<boolean> {
    if (tab.active !== true || tab.windowId === undefined) return false;
    const window = await this.#chrome.windows.get(tab.windowId).catch(() => undefined);
    return window?.focused === true;
  }


  /** Where the tab actually is now, which a redirect may have changed; its fragment does not count. */
  #liveUrl(tab: TabInfo): string {
    return normalize(checkUrl(tab.url ?? ''));
  }

  /**
   * The tab still shows the page that was observed, or a MOVED refusal.
   *
   * "The same page" is the same document, not the same URL: a single-page app
   * rewrites its own URL as it goes (Google Maps puts the map's position and
   * the selected place in the path, every few seconds), and that is no reason
   * to distrust an observation of a document that is still there — the
   * page side refuses a ref whose element is gone. A new document, though, is
   * a moved page whatever its URL. A URL the page itself rewrote stays on its
   * origin (history.pushState cannot leave it); the origin is checked anyway.
   * Without Chrome's document ids (tests), the URL decides, fragment aside.
   */
  async #onObservedPage(tab: TabInfo, observedUrl: string, documentId: string | undefined): Promise<void> {
    const getFrame = this.#chrome.webNavigation?.getFrame;
    const live = documentId && getFrame ? await getFrame.call(this.#chrome.webNavigation, { tabId: tab.id!, frameId: 0 }).catch(() => null) : null;
    if (live?.documentId) {
      if (live.documentId !== documentId || originOf(this.#liveUrl(tab)) !== originOf(observedUrl)) throw new PreconditionError(MOVED);
      return;
    }
    if (this.#liveUrl(tab) !== observedUrl) throw new PreconditionError(MOVED);
  }

  /**
   * A tab a page opened by itself — a link with target=_blank, window.open —
   * from one of this session's tabs while its run was going. It becomes the
   * session's: in the observation's tab list, in the group, under containment
   * from its next navigation (its first request had left before the worker
   * heard of the tab), and the one the agent works in next, since the click
   * meant to go there. False when no session has the opener.
   */
  async claimOpened(tabId: number, openerTabId: number): Promise<boolean> {
    const session = [...this.#sessions.values()].find((candidate) => [...candidate.tabs.values()].includes(openerTabId));
    if (!session || [...session.tabs.values()].includes(tabId)) return false;
    const tab = await this.#chrome.tabs.get(tabId).catch(() => undefined);
    if (!tab) return false;
    const key = `tab-${this.#uuid().slice(0, 12)}`;
    session.tabs.set(key, tabId);
    session.active = key;
    session.observed = undefined;
    this.#refs.delete(session.id);
    await this.#beforeNavigate(tabId);
    await this.#group(session, await this.#anchor(session), tabId);
    this.#persist();
    return true;
  }

  /**
   * The tab a new tab of this session opens beside: the one the owner handed
   * over, else the one the conversation belongs to (the worker says which).
   */
  async #anchor(session: Session): Promise<TabInfo | undefined> {
    const handedKey = [...session.handed][0];
    const tabId = handedKey !== undefined ? session.tabs.get(handedKey) : this.#anchorOf?.(session.id);
    return tabId === undefined ? undefined : this.#chrome.tabs.get(tabId).catch(() => undefined);
  }

  /** Show or hide the halo around the page the agent works in (and its cursor). */
  async highlight(sessionId: string, on: boolean): Promise<void> {
    if (on) this.#highlighted.add(sessionId); else this.#highlighted.delete(sessionId);
    const session = this.#sessions.get(sessionId);
    for (const tabId of session?.tabs.values() ?? []) await this.#paint(tabId, { halo: on }).catch(() => undefined);
  }

  /** The bubble each tab shows at the cursor, while there is one. */
  #notes = new Map<number, Note>();
  /** Where the agent's cursor was last painted, per tab. */
  #cursorAt = new Map<number, { x: number; y: number }>();

  /** Paint the overlay in a tab's main frame. Never throws into a command: it is cosmetic. */
  async #paint(tabId: number, state: { halo: boolean; cursor?: { x: number; y: number } }): Promise<void> {
    const note = state.halo ? this.#notes.get(tabId) ?? null : null;
    if (!state.halo) { this.#notes.delete(tabId); this.#cursorAt.delete(tabId); }
    await this.#chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, func: paintOverlay, args: [{ ...state, note }] }).catch(() => undefined);
  }

  /** Move the agent's cursor to where it is about to act, and let the owner see it get there. */
  async #pointAt(sessionId: string, tabId: number, point: { x: number; y: number } | undefined): Promise<void> {
    if (!point || !this.#highlighted.has(sessionId)) return;
    this.#cursorAt.set(tabId, point);
    await this.#paint(tabId, { halo: true, cursor: point });
    await this.#wait(CURSOR_MS);
  }

  /** Say in the tab what the agent is about to do (Learning), or take the bubble away. */
  async note(sessionId: string, note: Note | null): Promise<void> {
    const session = this.#sessions.get(sessionId);
    const key = session?.active;
    const tabId = key ? session?.tabs.get(key) : undefined;
    if (tabId === undefined || !this.#highlighted.has(sessionId)) return;
    if (note) this.#notes.set(tabId, note); else this.#notes.delete(tabId);
    const cursor = this.#cursorAt.get(tabId);
    await this.#paint(tabId, { halo: true, ...(cursor ? { cursor } : {}) });
  }

  /** Learning: put the cursor where the next action would go, dispatching nothing. Best effort. */
  async preview(sessionId: string, aim: { target?: unknown; point?: { x: number; y: number } }): Promise<void> {
    const session = await this.#session(sessionId);
    const tab = await this.#ownTab(session, this.#activeKey(session));
    let point = aim.point;
    if (!point && aim.target) {
      const ref = this.#ref(sessionId, session, aim.target);
      point = await this.#viewportPoint(ref, (await this.#locate(ref, {})).point);
    }
    if (point) await this.#pointAt(sessionId, tab.id!, point);
  }

  /**
   * A new background tab, right after the tab the conversation is on and its
   * earlier tabs, in its group (see #group), opened at about:blank and
   * navigated only once the containment rules cover it — so its first request
   * cannot escape them. (Not an extension page: a tab leaving one can take the
   * extension's process, and this worker, down with it.)
   */
  async #openTab(session: Session, url: string, cancel: Cancellation): Promise<number> {
    const anchor = await this.#anchor(session);
    cancel.dispatch();
    const own = [...session.tabs.keys()].filter((key) => !session.handed.has(key)).length;
    const beside = anchor?.id !== undefined && anchor.index !== undefined
      ? { index: anchor.index + 1 + own, openerTabId: anchor.id, ...(anchor.windowId !== undefined ? { windowId: anchor.windowId } : {}) } : {};
    const tab = await this.#chrome.tabs.create({ url: 'about:blank', active: false, ...beside });
    if (tab.id === undefined) throw new Error('Chrome opened a tab without an id.');
    await this.#group(session, anchor, tab.id);
    const key = `tab-${this.#uuid().slice(0, 12)}`;
    session.tabs.set(key, tab.id);
    session.active = key;
    await this.#beforeNavigate(tab.id);
    await this.#navigateFresh(tab.id, url);
    return tab.id;
  }

  /**
   * Navigate a tab that was just created at about:blank. Chrome can drop a
   * navigation sent before the new tab has settled, leaving it "unloaded" at
   * about:blank for good (seen in e2e, about one run in three), so wait for it
   * to settle first; then re-issue until the tab has a pending URL, is
   * loading, or shows the target.
   */
  async #navigateFresh(tabId: number, url: string): Promise<void> {
    const settled = Date.now() + 2_000;
    while (Date.now() < settled) {
      const tab = await this.#chrome.tabs.get(tabId).catch(() => undefined);
      if (!tab || tab.status === 'complete') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await this.#chrome.tabs.update(tabId, { url });
      const deadline = Date.now() + 1_000;
      while (Date.now() < deadline) {
        const tab = await this.#chrome.tabs.get(tabId).catch(() => undefined);
        if (!tab) return;
        if (tab.pendingUrl || tab.status === 'loading' || (tab.url && tab.url !== 'about:blank')) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }

  /** Navigate this session's current tab, opening one when there is none to reuse. */
  async #reuseOrOpen(session: Session, url: string, cancel: Cancellation): Promise<void> {
    const key = session.active;
    if (key) {
      // The tab it works in, handed or its own, goes there; one the owner closed meanwhile is forgotten, and a new one opens.
      const tab = await this.#ownTab(session, key).catch(() => undefined);
      if (tab && tab.id !== undefined) {
        cancel.check();
        await this.#beforeNavigate(tab.id);
        cancel.dispatch();
        await this.#chrome.tabs.update(tab.id, { url });
        await this.#waitForLoad(tab.id);
        return;
      }
    }
    const opened = await this.#openTab(session, url, cancel);
    await this.#waitForLoad(opened);
  }

  /**
   * Wait for what the input may have started, not for what was already there.
   *
   * After a click or an Enter that submits, the tab's `status` is still
   * `complete` for the page the event was dispatched on, so waiting for
   * `complete` returns immediately and the next observation describes the page
   * the agent has just left. So watch briefly for the tab to leave `complete`
   * or change its URL, and only then wait for the load. Polling rather than
   * `tabs.onUpdated`, because the worker can be evicted between registering a
   * listener and the event, and a missed event would hang.
   */
  async #settle(tabId: number, before: TabInfo): Promise<void> {
    const deadline = Date.now() + SETTLE_MS;
    for (;;) {
      const tab = await this.#chrome.tabs.get(tabId).catch(() => undefined);
      if (!tab) return; // Closed under us; the next command is the one that says so.
      if (tab.status !== 'complete' || tab.url !== before.url) return this.#waitForLoad(tabId);
      if (Date.now() >= deadline) return;
      await new Promise((resolve) => setTimeout(resolve, SETTLE_STEP_MS));
    }
  }

  async #waitForLoad(tabId: number): Promise<void> {
    const deadline = Date.now() + LOAD_TIMEOUT;
    for (;;) {
      const tab = await this.#chrome.tabs.get(tabId).catch(() => undefined);
      if (!tab) throw new Error('The tab closed while it was loading.');
      if (tab.status === 'complete') return;
      if (Date.now() > deadline) return; // A page that never finishes is still observable.
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  async #navigate(command: Command, cancel: Cancellation): Promise<CommandResult> {
    const url = checkUrl(str(command.args, 'url') ?? '');
    const session = await this.#session(command.session);
    // Evidence from the old page cannot describe the new one.
    session.observed = undefined;
    this.#refs.delete(command.session);
    cancel.check();
    // newTab: a tab of its own beside the current one, which stays as it is; the new one is where it works now.
    if (command.args['newTab'] === true) await this.#waitForLoad(await this.#openTab(session, url, cancel));
    else await this.#reuseOrOpen(session, url, cancel);
    return {};
  }

  async #tab(command: Command): Promise<CommandResult> {
    const session = await this.#session(command.session);
    const wanted = str(command.args, 'tabId') ?? '';
    if (!session.tabs.has(wanted)) throw new PreconditionError('No such tab in this conversation.');
    await this.#ownTab(session, wanted).catch((error: unknown) => {
      throw error instanceof PreconditionError ? error : new PreconditionError('No such tab in this conversation.');
    });
    session.active = wanted;
    return {};
  }

  /**
   * Closes this session's own tabs. A tab the owner is looking at is left open
   * instead: closing it would take the page out from under them. A handed tab
   * is the owner's page: it is released, never closed.
   */
  async #close(command: Command, cancel: Cancellation): Promise<CommandResult> {
    const session = this.#sessions.get(command.session);
    if (!session) return {};
    const ids: number[] = [];
    const kept: number[] = [];
    for (const [key, tabId] of [...session.tabs]) {
      if (session.handed.has(key)) continue;
      const tab = await this.#chrome.tabs.get(tabId).catch(() => undefined);
      if (!tab) continue;
      if (await this.#watched(tab)) kept.push(tabId); else ids.push(tabId);
    }
    if (ids.length > 0) {
      cancel.check();
      cancel.dispatch();
      await this.#chrome.tabs.remove(ids).catch(() => undefined);
    }
    // The owner's tab, and a kept tab (theirs now), leave the conversation's group.
    await this.#releaseGroup(session, kept);
    this.#sessions.delete(command.session);
    this.#refs.delete(command.session);
    return {};
  }

  /** The owner may have closed an agent tab; a session forgets those before it reports. */
  async #liveTabs(session: Session): Promise<Array<{ id: string; tab: TabInfo }>> {
    const live: Array<{ id: string; tab: TabInfo }> = [];
    for (const [key, tabId] of [...session.tabs]) {
      const tab = await this.#chrome.tabs.get(tabId).catch(() => undefined);
      if (!tab) { this.#forget(session, key); continue; }
      live.push({ id: key, tab });
    }
    if (!session.active && live[0]) session.active = live[0].id;
    return live;
  }

  /* ---- observing ---- */

  /**
   * Where a script may run in a tab: the page's own frames, by id. Not
   * `allFrames`: a password manager or another extension can plant a frame
   * of its own in the page (next to a form field, the moment it is focused),
   * and Chrome then refuses the whole injection ("Cannot access a
   * chrome-extension:// URL of different extension"), so every observation
   * after that would fail. Without webNavigation (tests), every frame.
   */
  async #frames(tabId: number): Promise<{ tabId: number; allFrames?: true; frameIds?: number[] }> {
    const all = await this.#chrome.webNavigation?.getAllFrames({ tabId }).catch(() => null);
    if (!all) return { tabId, allFrames: true };
    const own = all.filter((frame) => !/^(chrome|chrome-extension|chrome-untrusted|devtools|moz-extension):/.test(frame.url)).map((frame) => frame.frameId);
    return { tabId, frameIds: own.length > 0 ? own : [0] };
  }

  /** Injected per command rather than declared for every page the owner visits. */
  /** Returns Chrome's error when injection failed (e.g. site access withheld), so a refusal can say why. */
  async #inject(tabId: number): Promise<string | undefined> {
    return this.#chrome.scripting.executeScript({ target: await this.#frames(tabId), files: [this.#contentFile] })
      .then(() => undefined, (error: unknown) => (error instanceof Error ? error.message : String(error)));
  }

  /*
   * Frame 0 is the main frame by frame id, not by arrival order: Chrome
   * returns the frames in whatever order they answered, and reading a subframe
   * as the page would put the model on the wrong document.
   *
   * A main frame with no answer is usually a page that is not ready yet: the
   * content script did not land in a tab a navigation opened, or a heavy page
   * kept its main thread busy. So inject again and read again, a few times
   * with growing waits, before telling the model the page is not answering.
   */
  async #readFrames(tabId: number, cancel: Cancellation): Promise<{
    frames: Array<{ frameId: number; documentId?: string; result: FrameObservation | null }>;
    top: { frameId: number; documentId?: string; result: FrameObservation };
  }> {
    let chromeError: string | undefined;
    for (let attempt = 0; ; attempt += 1) {
      chromeError = await this.#inject(tabId) ?? chromeError;
      const frames = await this.#chrome.scripting.executeScript<[], FrameObservation | null>({
        target: await this.#frames(tabId), func: readObservation,
      }).catch((error: unknown) => {
        chromeError = error instanceof Error ? error.message : String(error);
        return [] as Array<{ frameId: number; documentId?: string; result: FrameObservation | null }>;
      });
      const top = frames.find((frame) => frame.frameId === 0);
      if (top?.result) return { frames, top: { frameId: top.frameId, documentId: top.documentId, result: top.result } };
      const wait = OBSERVE_RETRY_MS[attempt];
      if (wait === undefined) break;
      await this.#wait(wait);
      cancel.check();
    }
    const ready = await this.#chrome.scripting.executeScript<[], string>({
      target: { tabId, frameIds: [0] }, func: readReadyState,
    }).then((results) => results[0]?.result, () => undefined);
    // Chrome refusing to run scripts on a web page is not a slow page: say so, with its words.
    // (On about:blank or another non-web page the same error only means there is nothing to read.)
    const onWeb = /^https?:/.test((await this.#chrome.tabs.get(tabId).catch(() => undefined))?.url ?? '');
    if (chromeError && onWeb && /cannot access|permission|not allowed|host/i.test(chromeError)) throw new PreconditionError(`${NO_ACCESS} (Chrome: ${chromeError})`);
    const state = typeof ready === 'string' && ready !== 'complete' ? ` The page is still ${ready}.` : '';
    const said = chromeError ? ` (Chrome: ${chromeError})` : '';
    throw new PreconditionError(`The page has not answered after three tries.${state}${said} Wait a few seconds and observe again.`);
  }

  /**
   * Read the active tab. `allowFrame` decides, per subframe origin, whether its
   * content may reach the model; a frame it rejects (or an opaque one) is
   * replaced before the tree is assembled and truncated.
   */
  async observe(sessionId: string, cancel: Cancellation = new Cancellation(), allowFrame?: (origin: string) => boolean): Promise<ExecutorObservation> {
    const session = await this.#session(sessionId);
    const live = await this.#liveTabs(session);
    const key = this.#activeKey(session);
    const tab = await this.#ownTab(session, key);
    const tabId = tab.id!;
    cancel.check();
    // A dialog holds the page: no script runs in it, so there is no tree to read, and the observation says what there is to do.
    const dialog = this.#dialogs.get(tabId);
    if (dialog) {
      const generation = session.generation + 1;
      session.generation = generation;
      this.#refs.set(sessionId, new Map());
      this.#frameInfos.set(sessionId, []);
      session.observed = { generation, tabKey: key, url: normalize(tab.url ?? '') };
      const tree = `${describeDialog(dialog)} The page takes no other input until it is answered: use the dialog action with response "accept" or "dismiss"${dialog.type === 'prompt' ? ', and value for the text to answer with' : ''}.`;
      return {
        id: this.#uuid(), url: tab.url ?? '', title: tab.title ?? '', tree, targets: [], capturedAt: new Date().toISOString(),
        tabs: live.map(({ id, tab: info }) => ({ id, url: info.url ?? '', title: info.title ?? '' })),
        frames: [], dialog: { type: dialog.type, message: dialog.message, ...(dialog.defaultValue !== undefined ? { defaultValue: dialog.defaultValue } : {}) },
      };
    }
    const { frames, top } = await this.#readFrames(tabId, cancel);
    // A navigation wiped the overlay: paint it again while the run is on.
    if (this.#highlighted.has(sessionId)) await this.#paint(tabId, { halo: true });
    const ordered = [top, ...frames.filter((frame) => frame.frameId !== 0)];

    const generation = session.generation + 1;
    session.generation = generation;
    const refs = new Map<string, Ref>();
    const targets: ObservedTarget[] = [];
    const parts: string[] = [];
    const infos: FrameInfo[] = [];
    let main: FrameObservation | undefined;
    for (const [index, frame] of ordered.slice(0, MAX_FRAMES).entries()) {
      const result = frame.result;
      infos.push({ index, frameId: frame.frameId, ...(frame.documentId ? { documentId: frame.documentId } : {}),
        origin: result?.origin ?? 'null', url: result?.url ?? '' });
      if (!result) { parts.push(`Frame ${index} ([frame not readable]):\n`); continue; }
      if (index > 0 && allowFrame && (!result.origin || result.origin === 'null' || !allowFrame(result.origin))) {
        parts.push(`Frame ${index} (origin not approved) — hidden`);
        continue;
      }
      if (index === 0) main = result;
      for (const element of result.elements) {
        // Past the cap there is no ref to hand out, so the local id goes too:
        // a `[ref=l7]` left in the tree is a ref the model cannot use.
        if (targets.length >= MAX_TARGETS) { result.tree = result.tree.split(` [ref=${element.id}]`).join('').split(`[ref=${element.id}]`).join(''); continue; }
        const ref = `e${targets.length + 1}`;
        refs.set(ref, { tabKey: key, tabId, frameId: frame.frameId, local: element.id, frame: index,
          role: element.role, name: element.name, docUrl: normalize(result.url), generation,
          ...(frame.documentId ? { documentId: frame.documentId } : {}) });
        targets.push({ ref, frame: index, role: element.role, name: element.name,
          ...(element.href ? { href: element.href } : {}), ...(element.bounds ? { bounds: element.bounds } : {}) });
        result.tree = result.tree.split(`[ref=${element.id}]`).join(`[ref=${ref}]`);
      }
      parts.push(`Frame ${index} (${result.url}):\n${index === 0 ? result.tree : cut(result.tree, 3_000)}`);
    }
    this.#refs.set(sessionId, refs);
    this.#frameInfos.set(sessionId, infos);
    session.observed = { generation, tabKey: key, url: normalize(main?.url ?? tab.url ?? ''), ...(top.documentId ? { documentId: top.documentId } : {}) };
    const scroll = main?.scroll ?? { x: 0, y: 0 };
    // The main frame is already cut to fit (tree.ts), saying so; this cap is for many frames together.
    const tree = cut(`${parts.join('\n\n')}\n\nScroll: ${scroll.x}, ${scroll.y}`, MAX_TREE);
    return {
      id: this.#uuid(), url: main?.url ?? tab.url ?? '', title: main?.title ?? tab.title ?? '',
      tree, targets, capturedAt: new Date().toISOString(),
      tabs: live.map(({ id, tab: info }) => ({ id, url: info.url ?? '', title: info.title ?? '' })),
      frames: infos,
    };
  }

  /* ---- acting ---- */

  /*
   * A ref, or the semantic target the tool description promises.
   *
   * The model may write `by:"role", role:"link", name:"Sign in"`. Chrome has
   * no `getByRole`, but the last observation already listed every target with
   * its role and its accessible name, so the match happens against that list:
   * exact role, name compared without case or surrounding space. An ambiguous
   * label is where a model quietly clicks the wrong "Edit", so two matches is a
   * refusal that hands back the refs to choose between.
   */
  #ref(sessionId: string, session: Session, target: unknown): Ref {
    const record = (target && typeof target === 'object' ? target : {}) as Record<string, unknown>;
    if (record['x'] !== undefined || record['y'] !== undefined) throw new PreconditionError('Coordinate targets are not supported. Use a ref from the latest observation.targets.');
    const table = this.#refs.get(sessionId);
    const ref = record['ref'];
    if (typeof ref === 'string' && ref) {
      const found = table?.get(ref);
      if (!found || found.generation !== session.generation) throw new PreconditionError(STALE);
      return found;
    }
    const name = typeof record['name'] === 'string' ? record['name'] : '';
    if (!name) throw new PreconditionError('Use a ref from the latest observation.targets, or an exact name.');
    if (!table || table.size === 0) throw new PreconditionError(STALE);
    const by = typeof record['by'] === 'string' ? record['by'] : 'role';
    // `by:"link"` is the compatibility shorthand the command schema already
    // rewrites to role:"link"; accept it here too rather than depend on that.
    const role = by === 'link' ? 'link' : typeof record['role'] === 'string' ? record['role'] : undefined;
    const frame = typeof record['frame'] === 'number' ? record['frame'] : 0;
    const wanted = name.trim().toLowerCase();
    const matches = [...table].filter(([, candidate]) => candidate.frame === frame
      && candidate.name.trim().toLowerCase() === wanted
      // `label`, `placeholder` and `text` all end up in the accessible name the
      // tree builder computed, so only `role` narrows further.
      && (by !== 'role' || !role || candidate.role === role));
    const described = role ?? 'element';
    if (matches.length === 0) throw new PreconditionError(`No ${described} named ${name} in the last observation. Observe again and use a ref from observation.targets.`);
    if (matches.length > 1) throw new PreconditionError(`More than one ${described} named ${name} in the last observation (${matches.map(([key]) => key).join(', ')}). Use one of those refs.`);
    return matches[0]![1];
  }

  /**
   * Everything an acting command has to be sure of before it dispatches: the
   * ref is from the latest observation, the tab is still this session's, it is
   * still on the page that was observed, and the owner is not looking at it.
   */
  async #aim(command: Command, cancel: Cancellation): Promise<{ ref: Ref; tab: TabInfo }> {
    const session = await this.#session(command.session);
    const ref = this.#ref(command.session, session, command.args['target']);
    const tab = await this.#ownTab(session, ref.tabKey);
    // The main frame is checked here: a new document since the observation (a
    // navigation, a redirect, a reload) is a moved page. A subframe's ref
    // carries its document id, and a script aimed at a document that is gone
    // fails (see #script).
    if (ref.frameId === 0) await this.#onObservedPage(tab, ref.docUrl, ref.documentId);
    cancel.check();
    return { ref, tab };
  }

  /** Run a page-side function in the ref's own document; a document that is gone is a stale ref. */
  async #script<Args extends unknown[], Result>(ref: Ref, func: (...args: Args) => Result, args: Args): Promise<Result | undefined> {
    const [frame] = await this.#chrome.scripting.executeScript<Args, Result>({ target: frameTarget(ref), func, args })
      .catch((error: unknown) => {
        if (ref.documentId) throw new PreconditionError(STALE);
        throw error;
      });
    return frame?.result;
  }

  async #locate(ref: Ref, options: { focus?: boolean; clear?: boolean; mark?: boolean; still?: boolean } = {}): Promise<{ point?: { x: number; y: number }; setByValue?: boolean; keyByKey?: boolean; multiline?: boolean; password?: boolean }> {
    const result = await this.#script<[string, { focus?: boolean; clear?: boolean; mark?: boolean; still?: boolean }], { ok: boolean; reason?: string; point?: { x: number; y: number }; setByValue?: boolean; keyByKey?: boolean; multiline?: boolean; password?: boolean }>(
      ref, locateRef, [ref.local, options]);
    if (!result?.ok) throw new PreconditionError(result?.reason ?? 'The referenced element changed or disappeared.');
    return { point: result.point, setByValue: result.setByValue === true, keyByKey: result.keyByKey === true, multiline: result.multiline === true, password: result.password === true };
  }

  /**
   * Claim the debugger on a tab, attaching it if nobody holds it yet.
   *
   * An attach that fails is a precondition failure: the usual reason is that
   * the owner has DevTools open on that tab. Whether anything was dispatched
   * before it is the Cancellation's to say, not this error's.
   */
  async #claimDebugger(tabId: number): Promise<void> {
    const pending = this.#attaching.get(tabId);
    if (pending) await pending.catch(() => undefined);
    if ((this.#attached.get(tabId) ?? 0) === 0) {
      const attach = this.#chrome.debugger.attach({ tabId }, '1.3');
      this.#attaching.set(tabId, attach);
      try { await attach; }
      catch (error) {
        const said = error instanceof Error ? error.message : String(error);
        if (OTHER_EXTENSION.test(said)) throw new DebuggerKeptOut(DEBUGGER_KEPT_OUT, 0);
        throw new PreconditionError(`Chrome would not let the agent drive that tab (${said}). Close DevTools on it and observe again.`);
      } finally {
        this.#attaching.delete(tabId);
      }
      // Page events, for a dialog opening while the agent acts: without them a click that opens one looks like a click that did nothing.
      // The renderer answers this too, and a renderer held by a dialog never does: with one known open it is skipped, and one
      // that opened unseen (from a timer, while nothing was attached) shows up as the enable not coming back.
      if (!this.#dialogs.has(tabId)) {
        const enabled = this.#chrome.debugger.sendCommand({ tabId }, 'Page.enable').then(() => true, () => true);
        const held = new Promise<false>((resolve) => setTimeout(() => resolve(false), ENABLE_TIMEOUT_MS));
        if (!(await Promise.race([enabled, held])) && !this.#dialogs.has(tabId)) this.#dialogs.set(tabId, { type: 'alert', message: UNSEEN_DIALOG });
      }
    }
    this.#attached.set(tabId, (this.#attached.get(tabId) ?? 0) + 1);
  }

  /**
   * A debugger command, unless a dialog opens on the tab meanwhile: the page
   * stops handling input the moment it does, and the command that caused it
   * would never answer. The dialog is the answer then.
   */
  async #untilDialog<T>(tabId: number, command: Promise<T>): Promise<T | undefined> {
    let wake: () => void = () => undefined;
    const opened = new Promise<undefined>((resolve) => { wake = () => resolve(undefined); });
    const waiters = this.#dialogWaiters.get(tabId) ?? new Set<() => void>();
    waiters.add(wake);
    this.#dialogWaiters.set(tabId, waiters);
    // Once the race is over, a late failure of the command is nobody's news.
    void command.catch(() => undefined);
    try {
      // Opened before the wait began (input on a tab with a dialog is refused earlier, so this one is the command's own doing).
      if (this.#dialogs.has(tabId)) return undefined;
      // Input a page never answers is input a dialog is holding, heard of or not: say so rather than wait forever.
      const held = new Promise<typeof UNANSWERED>((resolve) => setTimeout(() => resolve(UNANSWERED), INPUT_TIMEOUT_MS));
      const outcome = await Promise.race([command, opened, held]);
      if (outcome !== UNANSWERED) return outcome;
      if (!this.#dialogs.has(tabId)) this.#dialogs.set(tabId, { type: 'alert', message: UNSEEN_DIALOG });
      return undefined;
    } finally {
      waiters.delete(wake);
      if (waiters.size === 0) this.#dialogWaiters.delete(tabId);
    }
  }

  /** Let go, and detach once nothing else is holding it, so the yellow bar never outlives the work. */
  async #releaseDebugger(tabId: number): Promise<void> {
    const held = this.#attached.get(tabId) ?? 0;
    if (held <= 1) {
      this.#attached.delete(tabId);
      await this.#chrome.debugger.detach({ tabId }).catch(() => undefined);
      return;
    }
    this.#attached.set(tabId, held - 1);
  }

  /** The debugger for exactly one command, released even when the command is cancelled. */
  async #withDebugger<T>(tabId: number, body: (send: (method: string, params?: unknown) => Promise<unknown>) => Promise<T>): Promise<T> {
    await this.#claimDebugger(tabId);
    let sent = 0;
    try {
      return await body(async (method, params) => {
        try {
          const command = this.#chrome.debugger.sendCommand({ tabId }, method, params);
          // Input is what opens dialogs, and what a dialog then holds up; a capture or a key-up on an open dialog is refused before it gets here.
          const answer = method.startsWith('Input.') ? await this.#untilDialog(tabId, command) : await command;
          sent += 1;
          return answer;
        } catch (error) {
          // The frame can appear partway (a password manager reacts to the first key): the caller decides whether it may go on another way.
          if (error instanceof Error && (OTHER_EXTENSION.test(error.message) || DETACHED_UNDER_COMMAND.test(error.message))) throw new DebuggerKeptOut(DEBUGGER_KEPT_OUT, sent);
          throw error;
        }
      });
    } finally {
      await this.#releaseDebugger(tabId);
    }
  }

  /**
   * Real input through the debugger, or — when another extension's frame keeps
   * Chrome's debugger out of the tab — the page's own events, which most
   * pages take just the same. When part of the action had already gone
   * through, only an action that is safe to do again (typing sets the whole
   * value) takes the other way; a key press or a click would be a second one.
   */
  async #driven<T>(viaDebugger: () => Promise<T>, viaPage: () => Promise<T>, repeatable = false): Promise<T> {
    try {
      return await viaDebugger();
    } catch (error) {
      if (!(error instanceof DebuggerKeptOut)) throw error;
      if (error.sent === 0 || repeatable) return viaPage();
      throw new Error(`${DEBUGGER_KEPT_OUT} It appeared partway through this action.`);
    }
  }


  /** An element's place in the tab's viewport: its point in its own document, moved by its frames' boxes; undefined past a frame from another site. */
  async #viewportPoint(ref: Ref, local: { x: number; y: number } | undefined): Promise<{ x: number; y: number } | undefined> {
    if (!local) return undefined;
    if (ref.frameId === 0) return local;
    const offset = await this.#script(ref, frameOffsetRef, []);
    return offset ? { x: local.x + offset.x, y: local.y + offset.y } : undefined;
  }










  /**
   * A screenshot of the session's active tab, as the owner would see it.
   * The halo and cursor are lifted for the capture.
   * Pixels are not redacted the way text is, so every frame whose content may
   * come from a site outside the run is painted over; the frames are listed
   * before and after the capture, and if anything moved, nothing is kept.
   */
  async capture(sessionId: string, cancel: Cancellation = new Cancellation(), allowOrigin: (origin: string) => boolean = () => false): Promise<Capture> {
    const session = await this.#session(sessionId);
    const tab = await this.#ownTab(session, this.#activeKey(session));
    const top = new URL(this.#liveUrl(tab)).origin;
    if (!allowOrigin(top)) throw new PreconditionError(`The tab is on ${top}, which is not allowed for this run, so no screenshot was taken.`);
    const tabId = tab.id!;
    cancel.check();
    const highlighted = this.#highlighted.has(sessionId);
    if (highlighted) await this.#paint(tabId, { halo: false });
    try {
      return await this.#captureWith(tabId, cancel, allowOrigin);
    } catch (error) {
      if (error instanceof DebuggerKeptOut) throw new PreconditionError(`${DEBUGGER_KEPT_OUT} No screenshot can be taken of this page; observe instead.`);
      throw error;
    } finally {
      if (highlighted) await this.#paint(tabId, { halo: true });
    }
  }

  async #captureWith(tabId: number, cancel: Cancellation, allowOrigin: (origin: string) => boolean): Promise<Capture> {
    // Every document and every frame element, read before and after the
    // capture: a navigation of the page or of any frame in between changes
    // a document id or an origin, and then nothing is kept.
    // The debugger is attached before the first reading: attaching shows Chrome's
    // "debugging this browser" bar, which shrinks the page, and a reading taken
    // before it would never match the one after.
    const { before, png, after } = await this.#withDebugger(tabId, async (send) => {
      await this.#settledViewport(tabId);
      const first = await this.#pageState(tabId);
      const shot = await Promise.race([
        send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }) as Promise<{ data?: string } | undefined>,
        this.#wait(CAPTURE_MS).then(() => undefined),
      ]);
      return { before: first, png: shot?.data, after: shot?.data ? await this.#pageState(tabId) : null };
    });
    if (!png) throw new PreconditionError('Chrome could not capture this tab (a tab in the background sometimes cannot be captured). Nothing was kept.');
    if (!before || !after || JSON.stringify(before) !== JSON.stringify(after)) {
      throw new PreconditionError('The page was changing while the screenshot was taken, so it was not kept. Try again in a moment.');
    }
    const { documents, list } = after;
    const shown = documents.find((document) => document.frameId === 0)?.origin;
    if (!shown || !allowOrigin(shown)) throw new PreconditionError(`The tab is on ${shown ?? 'a page that could not be read'}, which is not allowed for this run, so no screenshot was kept.`);
    // More documents than frame elements found: some frame is hidden from the listing. Fail closed.
    if (documents.length - 1 > list.frames.length) throw new PreconditionError('This page has frames the agent cannot locate, so no screenshot was kept.');
    const inScope = (origin: string | null) => !!origin && origin !== 'null' && allowOrigin(origin);
    // Whether any frame's real origin is outside the run: then no frame's src attribute is trusted.
    const allFramesInScope = documents.every((document) => inScope(document.origin));
    const byId = new Map(list.frames.map((frame) => [frame.id, frame]));
    const masked = new Set<number>();
    for (const frame of list.frames) {
      if (frame.readable || (allFramesInScope && inScope(frame.origin))) continue;
      // A frame inside a same-origin frame: its box there is not reliable, so the whole outer frame goes.
      masked.add(frame.within ?? frame.id);
    }
    const masks = [...masked].map((id) => { const { x, y, w, h } = byId.get(id)!; return { x, y, w, h }; });
    cancel.check();
    const image = await this.#imaging(png, list.viewport, masks);
    return { ...image, mediaType: 'image/jpeg', masked: masks.length, viewport: list.viewport, masks };
  }

  /**
   * A screenshot of any of the owner's tabs, for the owner to attach to a
   * message. Nothing is masked: the owner picked the tab and sees the image
   * before sending it. The window's active tab is captured without the
   * debugger; a background tab needs it (and shows its bar for a moment).
   */
  async captureTab(tabId: number): Promise<{ data: string; width: number; height: number; title: string }> {
    const tab = await this.#chrome.tabs.get(tabId).catch(() => undefined);
    if (!tab) throw new PreconditionError('That tab is gone.');
    checkUrl(tab.url ?? '');
    let png: string | undefined;
    if (tab.active && tab.windowId !== undefined && this.#chrome.tabs.captureVisibleTab) {
      const url = await this.#chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }).catch(() => undefined);
      png = url?.replace(/^data:image\/png;base64,/, '');
    }
    png ??= await this.#withDebugger(tabId, async (send) => {
      const shot = await Promise.race([
        send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }) as Promise<{ data?: string } | undefined>,
        this.#wait(CAPTURE_MS).then(() => undefined),
      ]);
      return shot?.data;
    });
    if (!png) throw new PreconditionError('Chrome could not capture that tab.');
    const image = await this.#imaging(png, { width: 1, height: 1 }, []);
    return { ...image, title: tab.title ?? '' };
  }

  /** Wait (briefly) until the page's viewport stops changing size, as it does when Chrome's debugger bar appears. */
  async #settledViewport(tabId: number): Promise<void> {
    let last = '';
    for (let i = 0; i < 6; i += 1) {
      const [answer] = await this.#chrome.scripting.executeScript<[], string>({ target: { tabId, frameIds: [0] }, func: readViewport }).catch(() => []);
      const size = answer?.result ?? '';
      if (size && size === last) return;
      last = size;
      await this.#wait(120);
    }
  }

  /** Every document's id and real origin, and every frame element's box. */
  async #pageState(tabId: number): Promise<{ documents: Array<{ frameId: number; documentId?: string; origin: string }>; list: FrameList } | null> {
    const probed = await this.#chrome.scripting.executeScript<[], string>({ target: await this.#frames(tabId), func: readOrigin }).catch(() => null);
    const list = await this.#listFrames(tabId);
    if (!probed || !list) return null;
    const documents = probed.map((frame) => ({ frameId: frame.frameId, ...(frame.documentId ? { documentId: frame.documentId } : {}), origin: frame.result }))
      .sort((a, b) => a.frameId - b.frameId);
    return { documents, list };
  }

  async #listFrames(tabId: number): Promise<FrameList | null> {
    const [answer] = await this.#chrome.scripting.executeScript<[], FrameList>({ target: { tabId, frameIds: [0] }, func: listFrames }).catch(() => []);
    return answer?.result ?? null;
  }
}

/** The longest a capture may take before it counts as failed. */
const CAPTURE_MS = 10_000;
/** Screenshots are scaled down to at most this width before they are kept or sent. */
const MAX_SCREENSHOT_WIDTH = 1280;

export interface Capture {
  data: string; mediaType: 'image/jpeg'; width: number; height: number; masked: number;
  /** The viewport the image shows, in CSS pixels, and the rectangles painted over in it: a point maps back through these. */
  viewport: { width: number; height: number }; masks: Rect[];
}
export interface Rect { x: number; y: number; w: number; h: number }
export interface FrameList { viewport: { width: number; height: number }; frames: Array<Rect & { id: number; readable: boolean; origin: string | null; within?: number }> }
/** PNG in, JPEG out: scaled, with the masked rectangles (in CSS pixels of the viewport) painted over. */
export type Imaging = (png: string, viewport: { width: number; height: number }, masks: Rect[]) => Promise<{ data: string; width: number; height: number }>;

/** The worker's imaging: OffscreenCanvas, which service workers have. */
const canvasImaging: Imaging = async (png, viewport, masks) => {
  const bytes = Uint8Array.from(atob(png), (char) => char.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  const scale = Math.min(1, MAX_SCREENSHOT_WIDTH / bitmap.width);
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d')!;
  context.drawImage(bitmap, 0, 0, width, height);
  const k = width / Math.max(1, viewport.width);
  context.fillStyle = '#8a8f98';
  for (const mask of masks) context.fillRect(mask.x * k, mask.y * k, mask.w * k, mask.h * k);
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
  const buffer = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < buffer.length; i += 0x8000) binary += String.fromCharCode(...buffer.subarray(i, i + 0x8000));
  return { data: btoa(binary), width, height };
};
