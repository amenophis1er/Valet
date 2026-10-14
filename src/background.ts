/*
 * The background worker: provider connections (byok), the
 * executor, and one conversation per tab the panel is opened on — each with
 * its run controller and agent loop — wired to the real `chrome.*`. The side
 * panel is registered per tab, so a conversation shows only on its own tab
 * (and on the tabs its agent opens). A panel talks to its conversation over
 * one port (loop/protocol.ts); settings go through byok's
 * message handlers.
 */

import { chat, createAiMessageHandler } from '@amenophis1er/byok/background';
import type { AIConfigView } from '@amenophis1er/byok/types';
import { RunController, type ScopeGate } from './controller/controller.js';
import { devReload } from './dev.js';
import type { WorkerChrome } from './executor/chrome.js';
import { BrowserCommands, type Pace } from './executor/commands.js';
import { AgentLoop, type Persisted } from './loop/agent.js';
import { AI_PREFIX, LEARNING_KEY, LIMIT_KEY, MAIN_CONVERSATION, MEDIA_PREFIX, MODE_KEY, PACE_KEY, runLimit, conversationForTab, conversationOfPort, panelPath, tabOfConversation, type PanelIntent, type WorkerMessage } from './loop/protocol.js';
import { agentPanelPaths, panelAssignments } from './panels.js';
import { printToPdf, type PdfChrome } from './pdf.js';
import { installProviderRules } from './scope/provider-rules.js';
import { Containment, type DnrLike } from './scope/containment.js';
import { originOf } from './scope/scope.js';
import { loadSkills } from './skills/skills.js';
import { KeepAlive } from './keepalive.js';

interface Port {
  name: string;
  postMessage(message: unknown): void;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
}

declare const chrome: WorkerChrome & {
  sidePanel: {
    setPanelBehavior(options: { openPanelOnActionClick: boolean }): Promise<void>;
    /** Without a tabId: the default for every tab; with one: that tab's own panel. */
    setOptions(options: { tabId?: number; path?: string; enabled?: boolean }): Promise<void>;
    getOptions(options: { tabId?: number }): Promise<{ tabId?: number; path?: string; enabled?: boolean }>;
  };
  /** Only for printing a PDF in a window of its own (pdf.ts). */
  windows: PdfChrome['windows'];
  tabs: {
    onCreated: { addListener(listener: (tab: { id?: number; openerTabId?: number }) => void): void };
    onRemoved: { addListener(listener: (tabId: number) => void): void };
  };
  runtime: {
    id: string;
    getURL(path: string): string;
    onInstalled: { addListener(listener: (details: { reason: string }) => void): void };
    onMessage: { addListener(listener: (message: { type?: string }, sender: { id?: string; tab?: { id?: number } }, respond: (response: unknown) => void) => boolean | undefined): void };
    onConnect: { addListener(listener: (port: Port) => void): void };
    /** Any extension API call resets Chrome's idle timer for the worker (keepalive.ts). */
    getPlatformInfo(): Promise<unknown>;
  };
  storage: {
    session: { get(key: string): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void>; remove(keys: string[]): Promise<void> };
    local: { get(key: string): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void>; remove(keys: string[]): Promise<void> };
    sync: { get(keys: null): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void>; remove(keys: string[]): Promise<void> };
    onChanged: { addListener(listener: (changes: Record<string, { newValue?: unknown }>, area: string) => void): void };
  };
  declarativeNetRequest: DnrLike;
  webNavigation: { onErrorOccurred: { addListener(listener: (details: { tabId: number; frameId: number; url: string; error: string }) => void): void } };
};

void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
// The first time only: a page that says what Valet is and gets a model connected.
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') void chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') }).catch(() => undefined);
});
// npm run dev: reload the extension when worker code changed (no-op in normal builds).
devReload('worker', () => (chrome.runtime as unknown as { reload(): void }).reload());

/* ---- the side panel, per tab ---- */

/**
 * The panel is not one panel for the window but one per tab: the toolbar
 * button opens the panel of the tab it is clicked on, which Chrome shows on
 * that tab only. Each tab's panel page names its tab, and so its conversation.
 * The tabs an agent opens get their conversation's panel too.
 */
const panelPaths = new Map<number, string>();
async function registerPanel(tabId: number, path: string): Promise<void> {
  if (panelPaths.get(tabId) === path) return;
  panelPaths.set(tabId, path);
  // Already so (the worker restarted): setting it again would reload an open panel.
  const current = await chrome.sidePanel.getOptions({ tabId }).catch(() => undefined);
  if (current?.tabId === tabId && current.enabled !== false && current.path === path) return;
  await chrome.sidePanel.setOptions({ tabId, path, enabled: true }).catch(() => undefined);
}
// No panel by default: only tabs registered below have one. Set once per browser session, not on every
// worker start: Chrome keeps the options, and setting them again while a panel is open closes it.
void chrome.sidePanel.getOptions({}).then(async (options) => {
  if (options.enabled !== false || options.tabId !== undefined) await chrome.sidePanel.setOptions({ enabled: false });
}).catch(() => undefined);
// Every open tab is registered once the executor's tabs are restored (in `ready` below): an agent's tab keeps its conversation's panel.
chrome.tabs.onCreated.addListener((tab) => {
  if (tab.id === undefined) return;
  void registerPanel(tab.id, panelPath(tab.id));
  // Opened by a page from one of the agent's tabs during a run: it is the agent's (the owner's own new tabs, while nothing runs, are not).
  if (tab.openerTabId !== undefined) void ready.then(() => claimOpened(tab.id!, tab.openerTabId!));
});

async function claimOpened(tabId: number, openerTabId: number): Promise<void> {
  const owner = ownerOf(openerTabId);
  if (owner?.loop.state.status !== 'running') return;
  await executor.claimOpened(tabId, openerTabId).catch(() => false);
}

/** The agent's own tabs show their conversation's panel; read from the executor's snapshot as it is saved. */
function registerAgentPanels(snapshot: unknown): void {
  for (const [tabId, path] of agentPanelPaths(snapshot)) void registerPanel(tabId, path);
}

/* ---- the executor and what every conversation shares ---- */

const handleAi = createAiMessageHandler({ prefix: AI_PREFIX, settingsHint: 'Open Settings in the side panel.' });
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  // Next, from the bubble in the page: only this extension's own scripts can send it, and it goes to the conversation working in that tab.
  if (message?.type === 'agent:step') {
    // Once the conversations are restored: a click that wakes the worker must not land on an empty map.
    if (sender.id === chrome.runtime.id) {
      void ready.then(() => {
        const owner = sender.tab?.id !== undefined ? ownerOf(sender.tab.id) : undefined;
        for (const conversation of owner ? [owner] : conversations.values()) conversation.loop.step();
      });
    }
    respond(undefined);
    return;
  }
  // Stop, from the same bubble: as the panel's Stop, for the conversation working in that tab.
  if (message?.type === 'agent:stop') {
    if (sender.id === chrome.runtime.id) {
      void ready.then(() => {
        const owner = sender.tab?.id !== undefined ? ownerOf(sender.tab.id) : undefined;
        if (owner) void owner.loop.stop();
      });
    }
    respond(undefined);
    return;
  }
  return handleAi(message, respond);
});

/** The worker cannot message itself, so it calls the settings handler directly. */
function aiView(): Promise<AIConfigView> {
  return new Promise((resolve) => handleAi({ type: `${AI_PREFIX}:ai-get` }, (view) => resolve(view as AIConfigView)));
}

// Approvals no longer outlive a conversation: forget the lists earlier versions saved.
void chrome.storage.local.remove(['agent:alwaysOrigins', 'agent:alwaysSubmissions']).catch(() => undefined);
const containment = new Containment(chrome.declarativeNetRequest);
// Subscription sign-ins (Claude, ChatGPT) need their request headers adjusted, for this extension's own requests only.
void installProviderRules(chrome.declarativeNetRequest, chrome.runtime.id).catch((error) => console.warn('Provider rules not installed:', error));

const TABS_KEY = 'agent:tabs';
const executor = new BrowserCommands(chrome, {
  // A conversation's new tabs open beside the tab it belongs to.
  anchor: (session) => tabOfConversation(session),
  // The executor asks the tab's conversation before any tab navigates, so the rules cover it first.
  beforeNavigate: async (tabId) => {
    const owner = ownerOf(tabId);
    if (owner) await owner.loop.beforeNavigate();
    else await Promise.all([...conversations.values()].map((conversation) => conversation.loop.beforeNavigate()));
  },
  // What the agent knows about its tabs survives the worker being stopped between messages.
  store: {
    get: async () => (await chrome.storage.session.get(TABS_KEY))[TABS_KEY],
    set: async (value) => { await chrome.storage.session.set({ [TABS_KEY]: value }); registerAgentPanels(value); },
  },
});

// The owner's pace (Settings) and Learning (the composer), applied from the next action.
let learning = false;
const setLearning = (value: unknown) => { learning = value === true; executor.setLearning(learning); };
void chrome.storage.local.get(PACE_KEY).then((stored) => executor.setPace(stored[PACE_KEY] as Pace));
void chrome.storage.local.get(LEARNING_KEY).then((stored) => setLearning(stored[LEARNING_KEY]));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[PACE_KEY]) executor.setPace(changes[PACE_KEY].newValue as Pace);
  if (area === 'local' && changes[LEARNING_KEY]) setLearning(changes[LEARNING_KEY].newValue);
});

// Navigations containment blocked, reported by webNavigation, go to the conversation whose tab it was.
chrome.webNavigation.onErrorOccurred.addListener((details) => {
  if (details.frameId !== 0 || !/ERR_BLOCKED_BY_CLIENT/.test(details.error)) return;
  const owner = ownerOf(details.tabId);
  if (!owner) return;
  const origin = originOf(details.url);
  if (origin && owner.loop.verdict(origin) !== 'allowed') owner.blocked.push(origin);
});

/* ---- conversations: one per tab the panel was opened on ---- */

interface Conversation { id: string; loop: AgentLoop; controller: RunController; ports: Set<Port>; blocked: string[] }

const conversations = new Map<string, Conversation>();
const opening = new Map<string, Promise<Conversation>>();
/** Pings while any conversation runs, so the worker outlives a closed panel (keepalive.ts). */
const keepAlive = new KeepAlive(() => { void chrome.runtime.getPlatformInfo().catch(() => undefined); });
/** The conversations that exist, so a restarted worker restores each (chrome.storage.session). */
const INDEX_KEY = 'agent:conversations';
const stateKey = (id: string) => `agent:conversation:${id}`;
/** The conversation's run trace (loop/trace.ts), apart from its state so it never crowds it. */
const traceKey = (id: string) => `agent:trace:${id}`;

async function readIndex(): Promise<string[]> {
  const stored = (await chrome.storage.session.get(INDEX_KEY))[INDEX_KEY];
  return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : [];
}

/** Changes to the index, one after another: two at once would each write over the other's. */
let indexWrites: Promise<void> = Promise.resolve();
function updateIndex(change: (ids: string[]) => string[]): Promise<void> {
  const run = indexWrites.then(async () => { await chrome.storage.session.set({ [INDEX_KEY]: change(await readIndex()) }); });
  indexWrites = run.catch(() => undefined);
  return run;
}

/** The conversation working in a tab: the one that was handed it, or opened it. */
function ownerOf(tabId: number): Conversation | undefined {
  return [...conversations.values()].find((conversation) => executor.tabIds(conversation.id).includes(tabId));
}

function make(id: string): Conversation {
  const conversation = { id, ports: new Set<Port>(), blocked: [] as string[] } as Conversation;
  const gate: ScopeGate = {
    verdict: (origin) => conversation.loop.verdict(origin),
    ask: (origin, reason) => conversation.loop.ask(origin, reason),
    takeBlocked: () => { const taken = conversation.blocked; conversation.blocked = []; return [...new Set(taken)]; },
    submitVerdict: (target) => conversation.loop.submitVerdict(target),
    askSubmit: (fingerprint) => conversation.loop.askSubmit(fingerprint),
  };
  conversation.controller = new RunController(executor, { session: id, gate });
  conversation.loop = new AgentLoop({
    chat,
    controller: conversation.controller,
    adopt: async (tabId) => { await executor.adopt(id, tabId); },
    release: () => executor.release(id),
    closeTabs: async () => { await executor.run({ id: 'close', name: 'close', session: id, args: {} }); },
    highlight: (on) => executor.highlight(id, on),
    tabInfo: async (tabId) => {
      const tab = await chrome.tabs.get(tabId).catch(() => undefined);
      return tab ? { title: tab.title ?? '', url: tab.url ?? '' } : null;
    },
    workspace: () => executor.workspace(id),
    activeConnection: async () => {
      const view = await aiView();
      const active = view.connections.find((connection) => connection.id === view.activeId);
      return active?.model ? { id: active.id, revision: active.revision, label: active.label, model: active.model } : null;
    },
    storage: {
      get: async () => (await chrome.storage.session.get(stateKey(id)))[stateKey(id)] as Persisted | undefined,
      set: async (value) => { await chrome.storage.session.set({ [stateKey(id)]: value }); },
      remove: async () => { await chrome.storage.session.remove([stateKey(id)]); },
    },
    trace: {
      get: async () => (await chrome.storage.session.get(traceKey(id)))[traceKey(id)],
      set: async (events) => { await chrome.storage.session.set({ [traceKey(id)]: events }); },
      remove: async () => { await chrome.storage.session.remove([traceKey(id)]); },
    },
    limit: { get: async () => runLimit((await chrome.storage.local.get(LIMIT_KEY))[LIMIT_KEY]) },
    mode: {
      get: async () => ((await chrome.storage.local.get(MODE_KEY))[MODE_KEY] === 'auto' ? 'auto' : 'ask'),
      set: async (mode) => { await chrome.storage.local.set({ [MODE_KEY]: mode }); },
    },
    containment: {
      apply: (origins) => containment.apply(id, executor.tabIds(id), origins),
      clear: () => containment.clear(id),
    },
    media: {
      set: async (mediaId, value) => { await chrome.storage.session.set({ [`${MEDIA_PREFIX}${mediaId}`]: value }); },
      remove: async (ids) => { if (ids.length > 0) await chrome.storage.session.remove(ids.map((mediaId) => `${MEDIA_PREFIX}${mediaId}`)); },
    },
    skills: { get: () => loadSkills(chrome.storage.sync) },
    // A .pdf: document.html lays the stored Markdown out, and Chrome prints it in a background tab.
    pdf: { render: (mediaId) => printToPdf(chrome, chrome.runtime.getURL(`document.html?id=${encodeURIComponent(mediaId)}`)) },
    learning: { get: () => learning, set: async (on) => { setLearning(on); await chrome.storage.local.set({ [LEARNING_KEY]: on }); } },
    preview: (args) => conversation.controller.preview(args),
    note: (note) => executor.note(id, note),
    emit: (state) => {
      keepAlive.want(id, state.status === 'running');
      const message: WorkerMessage = { type: 'state', state };
      for (const port of conversation.ports) port.postMessage(message);
    },
  });
  return conversation;
}

/** The conversation by id: restored from storage on first use, remembered for the next worker start. */
function open(id: string): Promise<Conversation> {
  const existing = conversations.get(id);
  if (existing) return Promise.resolve(existing);
  let pending = opening.get(id);
  if (!pending) {
    pending = (async () => {
      const conversation = make(id);
      await conversation.loop.restore();
      conversations.set(id, conversation);
      opening.delete(id);
      await updateIndex((ids) => (ids.includes(id) ? ids : [...ids, id]));
      return conversation;
    })();
    opening.set(id, pending);
  }
  return pending;
}

/** The tab a conversation was opened on closed: its run stops and nothing of it is kept. Its agent's tabs stay open, as tabs of their own. */
async function close(id: string): Promise<void> {
  const conversation = conversations.get(id) ?? await opening.get(id);
  if (!conversation) return;
  const origin = tabOfConversation(id);
  for (const tabId of executor.tabIds(id)) if (tabId !== origin) void registerPanel(tabId, panelPath(tabId));
  await conversation.loop.discard().catch(() => undefined);
  executor.release(id);
  executor.drop(id);
  await containment.clear(id).catch(() => undefined);
  conversations.delete(id);
  keepAlive.want(id, false);
  await chrome.storage.session.remove([`agent:draft:${id}`]).catch(() => undefined);
  await updateIndex((ids) => ids.filter((other) => other !== id)).catch(() => undefined);
}

const ready = executor.restore().then(async () => {
  // Every open tab's panel, the agent's tabs first from the restored snapshot, so none of them is handed its own empty conversation.
  const snapshot = (await chrome.storage.session.get(TABS_KEY).catch(() => ({} as Record<string, unknown>)))[TABS_KEY];
  const tabs = await chrome.tabs.query({}).catch(() => []);
  for (const [tabId, path] of panelAssignments(tabs.flatMap((tab) => (tab.id === undefined ? [] : [tab.id])), snapshot)) void registerPanel(tabId, path);
  // The one conversation of earlier versions.
  await chrome.storage.session.remove(['agent:conversation']).catch(() => undefined);
  for (const id of await readIndex()) {
    const tabId = tabOfConversation(id);
    const gone = tabId !== undefined && !(await chrome.tabs.get(tabId).then(() => true, () => false));
    if (gone) await updateIndex((ids) => ids.filter((other) => other !== id)).catch(() => undefined);
    else await open(id);
  }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  panelPaths.delete(tabId);
  void ready.then(() => close(conversationForTab(tabId)));
});

chrome.runtime.onConnect.addListener((port) => {
  const id = conversationOfPort(port.name);
  if (!id) return;
  const conversation = ready.then(() => open(id));
  void conversation.then((found) => {
    found.ports.add(port);
    port.postMessage({ type: 'state', state: found.loop.state } satisfies WorkerMessage);
  });
  // Listeners go on now: a message sent before they are there would be lost.
  port.onDisconnect.addListener(() => { void conversation.then((found) => found.ports.delete(port)); });
  port.onMessage.addListener((raw) => { void conversation.then((found) => handle(found, port, raw as PanelIntent)); });
});

async function handle(conversation: Conversation, port: Port, intent: PanelIntent): Promise<void> {
  const { loop } = conversation;
  switch (intent.type) {
    case 'run': void loop.run(intent.goal, intent.tabId, intent.useNewTab === true, intent.attachments ?? [], intent.skillIds ?? []); return;
    case 'draft-skill': {
      const drafted = await loop.draftSkill({ ...(intent.focus ? { focus: intent.focus } : {}), ...(intent.previous ? { previous: intent.previous } : {}) }).catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));
      try { port.postMessage({ type: 'skill-draft', requestId: intent.requestId, ...('error' in drafted ? { error: drafted.error } : { draft: drafted }) } satisfies WorkerMessage); }
      catch { /* the panel went away meanwhile */ }
      return;
    }
    case 'stop': void loop.stop(); return;
    case 'resume': void loop.resume(); return;
    case 'new-conversation': void loop.newConversation(); return;
    case 'get': port.postMessage({ type: 'state', state: loop.state } satisfies WorkerMessage); return;
    case 'decide': void loop.decide(intent.id, intent.decision); return;
    case 'set-mode': void loop.setMode(intent.mode); return;
    case 'step': loop.step(); return;
    case 'answer':
      if (intent.text !== undefined) loop.answerText(intent.id, intent.text); else loop.answer(intent.id, intent.skip ? null : intent.picked ?? []);
      return;
    case 'continue': void loop.continueRun(); return;
    case 'set-learning': void loop.setLearning(intent.on); return;
    case 'export-trace': port.postMessage({ type: 'trace', requestId: intent.requestId, json: loop.exportTrace() } satisfies WorkerMessage); return;
    case 'capture-tab': {
      const reply = (message: Omit<Extract<WorkerMessage, { type: 'captured' }>, 'type' | 'requestId'>) =>
        port.postMessage({ type: 'captured', requestId: intent.requestId, ...message } satisfies WorkerMessage);
      try { reply({ image: await executor.captureTab(intent.tabId) }); }
      catch (error) { reply({ error: error instanceof Error ? error.message : String(error) }); }
      return;
    }
    case 'heartbeat': return; // the message itself keeps the worker alive
    default: return;
  }
}

// Access from the worker's own console, for development and the e2e suite. Pages, content scripts and
// other extensions cannot reach the worker's global (no externally_connectable), so it ships as is.
const consoleControllers = new Map<string, RunController>();
function consoleController(session: string): RunController {
  const own = conversations.get(session)?.controller;
  if (own) return own;
  let found = consoleControllers.get(session);
  if (!found) { found = new RunController(executor, { session }); consoleControllers.set(session, found); }
  return found;
}
(globalThis as unknown as Record<string, unknown>)['__valet'] = {
  run: (session: string, input: unknown) => consoleController(session).run(input),
  adopt: (session: string, tabId: number) => executor.adopt(session, tabId),
  facts: (session: string, target: unknown, via: 'click' | 'enter' | 'space') => executor.submitFacts(session, target, via),
  executor,
  loop: (id: string = MAIN_CONVERSATION) => conversations.get(id)?.loop,
  conversations,
};
