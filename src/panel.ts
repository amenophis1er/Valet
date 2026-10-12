/*
 * The side panel: a view over the worker's state.
 * It sends intents over the "panel" port and renders what comes back; it
 * never runs loop logic. Settings go through byok's client.
 */

import { createAiClient } from '@amenophis1er/byok/client';
import { devReload } from './dev.js';
import { renderMarkdown } from './markdown.js';
import { setupConnections } from './connections-ui.js';
import { iconButton, TRASH } from './ui.js';
import { readAttachment, thumbnailOf } from './composer.js';
import { grabFrame } from './share.js';
import { dictation as attachDictation, onDeviceModel, type ModelState } from './dictation/index.js';
import { MAX_ATTACHMENTS, checkAttachments, type Attachment } from './loop/attachments.js';
import { AI_PREFIX, HEARTBEAT_MS, LIMIT_KEY, MEDIA_PREFIX, PACE_KEY, PANEL_PORT, RUN_LIMITS, conversationForTab, runLimit, panelPortName, type Media, type PanelIntent, type PanelState, type WorkerMessage } from './loop/protocol.js';
import { conversationHtml, conversationMarkdown } from './export.js';
import { MAX_SKILL_CHARS, exportSkills, importSkills, loadSkills, newSkillId, parseSites, removeSkill, saveSkill, validateSkill, type Skill } from './skills/skills.js';

interface TabInfo { id?: number; url?: string; title?: string; windowId?: number }
interface Port { postMessage(message: unknown): void; onMessage: { addListener(listener: (message: unknown) => void): void }; onDisconnect: { addListener(listener: () => void): void } }
declare const chrome: {
  runtime: { connect(info: { name: string }): Port; getURL(path: string): string };
  windows: { create(options: { url: string; type: 'popup'; width: number; height: number; left?: number; top?: number; focused?: boolean }): Promise<unknown> };
  storage: {
    session: { get(key: string): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void> };
    local: { get(key: string): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void> };
    sync: { get(keys: null): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void>; remove(keys: string[]): Promise<void> };
  };
  tabs: {
    query(query: { active?: boolean; currentWindow?: boolean }): Promise<TabInfo[]>;
    get(tabId: number): Promise<TabInfo>;
    create(properties: { url: string }): Promise<TabInfo>;
    onActivated: { addListener(listener: () => void): void };
    onUpdated: { addListener(listener: (tabId: number, change: { title?: string; url?: string; status?: string }) => void): void };
  };
};

declare const __BUILD__: string;
const ai = createAiClient({ prefix: AI_PREFIX });
/** The AI models sheet in Settings: the same form the welcome page shows. */
const connections = setupConnections({ ai, onChange: () => { void renderActiveConnection(); } });
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let port: Port;
let state: PanelState | undefined;
let currentTab: TabInfo | undefined;
let heartbeat: ReturnType<typeof setInterval> | undefined;

/**
 * The tab this panel belongs to (the worker opens each tab's panel with its
 * id): its conversation is that tab's. Opened without one — the page visited
 * directly — the panel follows the active tab and has the main conversation.
 */
const ownTab = Number(new URLSearchParams(location.search).get('tab'));
const ownTabId: number | undefined = Number.isInteger(ownTab) && ownTab > 0 ? ownTab : undefined;

function connect(): void {
  try {
    port = chrome.runtime.connect({ name: ownTabId === undefined ? PANEL_PORT : panelPortName(conversationForTab(ownTabId)) });
  } catch {
    // The extension was reloaded or removed under this page: there is nothing to connect to any more.
    showError('Valet was reloaded. Close this panel and open it again.');
    return;
  }
  port.onMessage.addListener((raw) => {
    const message = raw as WorkerMessage;
    if (message.type === 'state') { state = message.state; render(); renderMode(); renderLearn(); }
    if (message.type === 'captured') void captured(message);
    if (message.type === 'skill-draft') void drafted(message);
    if (message.type === 'trace') savedTrace(message);
  });
  // The worker restarted: reconnecting starts it again and it resumes from storage. Whatever it was
  // asked for over this port will not come: those requests end here, so nothing waits for them.
  port.onDisconnect.addListener(() => {
    dropRequests();
    setTimeout(connect, 300);
  });
}

/** Requests the worker was handling over the port that just closed: a draft or screenshots. */
function dropRequests(): void {
  let dropped = false;
  if (drafting) {
    drafting = undefined;
    dropped = true;
    $('skill-rewrite-go').textContent = 'Rewrite';
    ($('skill-rewrite-go') as HTMLButtonElement).disabled = false;
    if ($('settings-view').hidden) showError('The skill could not be written: the connection to the worker was lost. Try again.');
    else $('skills-status').textContent = 'The draft could not be written: the connection to the worker was lost. Try again.';
  }
  if (capturing.size > 0) {
    capturing.clear();
    dropped = true;
    showError('The screenshot did not arrive: the connection to the worker was lost. Try again.');
  }
  if (dropped) { render(); renderPending(); }
}

function send(intent: PanelIntent): void {
  port.postMessage(intent);
}

/* ---- the current tab: the one a run will be handed ---- */

const usable = (url?: string) => !!url && /^https?:\/\//.test(url);

async function refreshTab(): Promise<void> {
  if (ownTabId !== undefined) currentTab = await chrome.tabs.get(ownTabId).catch(() => undefined);
  else [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  renderTab();
}

/** Where the next run works: the tab the owner was on, or a tab of its own. */
/**
 * Where the next request works. A conversation keeps its workspace: once the
 * agent has a tab, follow-ups continue there. The owner can hand over the tab
 * they are on instead, or send the agent to a tab of its own.
 */
type Where = 'continue' | 'this' | 'new';
/** The owner's pick for the next request; null means the default. */
let wherePick: Where | null = null;

function started(): boolean {
  return !!state?.workspace && (state.transcript ?? []).some((entry) => entry.kind === 'owner');
}

function whereNow(): Where {
  const pick = wherePick ?? (started() ? 'continue' : 'this');
  if (pick === 'continue' && !started()) return 'this';
  if (pick === 'this' && !usable(currentTab?.url)) return started() ? 'continue' : 'new';
  return pick;
}

function renderTab(): void {
  const title = $('tab-title');
  const where = $<HTMLButtonElement>('where');
  const running = state?.status === 'running' || state?.status === 'paused';
  const workspace = state?.workspace;
  const name = (tab?: { title?: string; url?: string } | null) => tab?.title || tab?.url || '';
  const choice = whereNow();
  // The chip shows the tab's name; the sentence around it is the label on hover.
  let tip: string;
  if (running) {
    title.textContent = workspace ? name(workspace) : 'Its own tab';
    tip = workspace ? `Working in: ${name(workspace)}` : 'Working in its own tab';
  } else if (choice === 'continue') {
    title.textContent = name(workspace);
    tip = `Will continue in: ${name(workspace)}. Click to change.`;
  } else if (choice === 'this') {
    title.textContent = name(currentTab);
    tip = `Will work in this tab: ${name(currentTab)}. Click to change.`;
  } else if (usable(currentTab?.url) || started()) {
    title.textContent = 'A new tab';
    tip = 'Will work in a new tab, leaving your page alone. Click to change.';
  } else {
    title.textContent = 'Its own tab';
    tip = 'This page cannot be used; the agent will open its own tab.';
  }
  // The sentence is the label on hover and the button's name, so a screen reader hears where the agent will work.
  $('where-label').textContent = running ? 'Working in:' : choice === 'continue' ? 'Will continue in:' : 'Will work in:';
  where.dataset['tip'] = tip;
  where.setAttribute('aria-label', tip);
  where.classList.toggle('hand', !running && choice === 'this');
  // A choice exists when there is more than one place to go.
  const choosable = !running && (usable(currentTab?.url) || started());
  where.disabled = !choosable;
  if (!choosable) closeWhere();
  $('where-continue').hidden = !started();
  $('where-continue-title').textContent = name(workspace);
  $('where-here').hidden = !usable(currentTab?.url);
  $('where-here-title').textContent = name(currentTab);
  for (const [id, value] of [['where-continue', 'continue'], ['where-here', 'this'], ['where-new', 'new']] as const) {
    $(id).setAttribute('aria-checked', String(choice === value));
  }
}

function closeWhere(): void {
  $('where-menu').hidden = true;
  $('where').setAttribute('aria-expanded', 'false');
}

function toggleWhere(): void {
  const menu = $('where-menu');
  if (!menu.hidden) { closeWhere(); return; }
  $('tab-menu').hidden = true;
  closeAddMenu();
  menu.hidden = false;
  $('where').setAttribute('aria-expanded', 'true');
  ($({ continue: 'where-continue', this: 'where-here', new: 'where-new' }[whereNow()]) as HTMLElement).focus();
}

function chooseWhere(pick: Where): void {
  wherePick = pick;
  closeWhere();
  renderTab();
  $('goal').focus();
}

/* ---- screenshots and files, read from storage by id ---- */

/** Object URLs of media already loaded, so a re-render does not flicker. */
const media = new Map<string, { url: string; name: string }>();
const loading = new Map<string, Promise<{ url: string; name: string } | null>>();

function loadMedia(id: string): Promise<{ url: string; name: string } | null> {
  const cached = media.get(id);
  if (cached) return Promise.resolve(cached);
  let pending = loading.get(id);
  if (!pending) {
    pending = readMedia(id).finally(() => loading.delete(id));
    loading.set(id, pending);
  }
  return pending;
}

/** Let go of media the worker no longer keeps (pruned, or a new conversation). */
function forgetMedia(live: Set<string>): void {
  for (const [id, loaded] of media) {
    if (live.has(id)) continue;
    URL.revokeObjectURL(loaded.url);
    media.delete(id);
  }
}

async function readMedia(id: string): Promise<{ url: string; name: string } | null> {
  const stored = (await chrome.storage.session.get(`${MEDIA_PREFIX}${id}`))[`${MEDIA_PREFIX}${id}`] as Media | undefined;
  if (!stored) return null;
  const bytes = (data: string) => Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
  const blob = stored.kind === 'image' ? new Blob([bytes(stored.data)], { type: stored.mediaType })
    : stored.kind === 'pdf' ? new Blob([bytes(stored.data)], { type: 'application/pdf' })
      : new Blob([stored.content], { type: `${stored.mimeType};charset=utf-8` });
  const name = stored.kind === 'image' ? `screenshot-${id.split('-')[1] ?? id}.${stored.mediaType === 'image/png' ? 'png' : 'jpg'}` : stored.name;
  const loaded = { url: URL.createObjectURL(blob), name };
  media.set(id, loaded);
  return loaded;
}

/** The owner's click is the download: nothing is saved before it. */
function download(url: string, name: string): void {
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
}

function thumbnail(id: string, width: number, height: number, expired?: boolean): HTMLElement {
  if (expired) {
    const gone = document.createElement('div');
    gone.className = 'shot-gone';
    gone.textContent = 'Older screenshot (no longer kept)';
    return gone;
  }
  const button = document.createElement('button');
  button.className = 'shot';
  button.title = 'Open the screenshot';
  button.setAttribute('aria-label', 'Open the screenshot');
  const image = document.createElement('img');
  image.alt = 'Screenshot of the page';
  image.style.aspectRatio = `${width} / ${height}`;
  button.append(image);
  const cached = media.get(id);
  if (cached) image.src = cached.url;
  else void loadMedia(id).then((loaded) => { if (loaded) image.src = loaded.url; });
  button.onclick = () => { void openLightbox(id, { width, height }); };
  return button;
}

/**
 * An image large, in a window of its own beside the browser — the side panel
 * is too narrow for it. Sized to the image, within the screen. If the window
 * cannot open, the panel's own viewer shows it.
 */
async function openViewer(id: string, name: string, size?: { width?: number; height?: number }, temporary = false): Promise<boolean> {
  const width = Math.round(Math.min(screen.availWidth * 0.85, Math.max(480, (size?.width ?? 1280) + 40)));
  const height = Math.round(Math.min(screen.availHeight * 0.9, Math.max(360, (size?.height ?? 800) + 100)));
  const at = screen as Screen & { availLeft?: number; availTop?: number };
  const query = new URLSearchParams({ id, name, ...(temporary ? { temporary: '1' } : {}) });
  try {
    await chrome.windows.create({ url: chrome.runtime.getURL(`viewer.html?${query}`), type: 'popup', width, height,
      left: Math.round((at.availLeft ?? 0) + (screen.availWidth - width) / 2), top: Math.round((at.availTop ?? 0) + (screen.availHeight - height) / 2), focused: true });
    return true;
  } catch {
    return false;
  }
}

async function openLightbox(id: string, size?: { width?: number; height?: number }): Promise<void> {
  const loaded = await loadMedia(id);
  if (!loaded) return;
  if (!(await openViewer(id, loaded.name, size))) showLightbox(loaded.url, loaded.name);
}

/** A picture not sent yet: stored just for its window, which removes it again when it closes. */
async function viewPending(attachment: Attachment, fallbackUrl: string): Promise<void> {
  const id = `view-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  await chrome.storage.session.set({ [`${MEDIA_PREFIX}${id}`]: { kind: 'image', mediaType: 'image/jpeg', data: attachment.data ?? '' } satisfies Media });
  if (!(await openViewer(id, attachment.name, { width: attachment.width, height: attachment.height }, true))) showLightbox(fallbackUrl, attachment.name);
}

function showLightbox(url: string, name: string): void {
  $<HTMLImageElement>('lightbox-image').src = url;
  $('lightbox-download').onclick = () => download(url, name);
  $<HTMLDialogElement>('lightbox').showModal();
}

function fileChip(entry: { id: string; name: string; bytes: number; expired?: boolean }): HTMLElement {
  const chip = document.createElement('div');
  chip.className = 'file';
  const icon = document.createElement('span');
  icon.className = 'file-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = (entry.name.split('.').pop() ?? 'txt').slice(0, 4).toUpperCase();
  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = entry.name;
  const size = document.createElement('small');
  size.textContent = entry.bytes < 1024 ? `${entry.bytes} B` : `${(entry.bytes / 1024).toFixed(1)} KB`;
  name.append(size);
  const save = document.createElement('button');
  save.className = 'primary';
  save.textContent = 'Download';
  save.disabled = !!entry.expired;
  save.onclick = async () => {
    const loaded = await loadMedia(entry.id);
    if (loaded) download(loaded.url, loaded.name);
  };
  chip.append(icon, name, save);
  return chip;
}

/* ---- the conversation ---- */

function render(): void {
  if (!state) return;
  forgetMedia(new Set(state.transcript.flatMap((entry) =>
    entry.kind === 'file' && !entry.expired ? [entry.id]
      : entry.kind === 'action' && entry.image && !entry.image.expired ? [entry.image.id]
        : entry.kind === 'owner' ? (entry.attachments ?? []).flatMap((attachment) => (attachment.id ? [attachment.id] : [])) : [])));
  const list = $('transcript');
  // The steer card is rebuilt with the list: the owner typing in it must not notice.
  const steerFocused = document.activeElement?.id === 'skill-focus';
  list.textContent = '';
  const entries = state.transcript;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const item = document.createElement('li');
    // Approval notes just before a step belong to it.
    let first = index;
    while (first < entries.length && foldable(entries[first]!)) first += 1;
    if (first > index && first < entries.length && entries[first]!.kind === 'action') {
      let end = first;
      while (end + 1 < entries.length && (entries[end + 1]!.kind === 'action' || foldable(entries[end + 1]!))) end += 1;
      while (entries[end]!.kind !== 'action') end -= 1;
      const live = state.status === 'running' && end === entries.length - 1;
      list.append(...activity(entries.slice(index, end + 1), index, live));
      index = end;
      continue;
    }
    if (entry.kind === 'action') {
      // The steps between two things said, as one foldable line.
      let end = index;
      while (end + 1 < entries.length && (entries[end + 1]!.kind === 'action' || foldable(entries[end + 1]!))) end += 1;
      while (entries[end]!.kind !== 'action') end -= 1;
      const live = state.status === 'running' && end === entries.length - 1;
      list.append(...activity(entries.slice(index, end + 1), index, live));
      index = end;
      continue;
    } else if (entry.kind === 'file') {
      item.className = 'file-row';
      item.append(fileChip(entry));
    } else if (entry.kind === 'owner') {
      item.className = 'owner';
      item.textContent = entry.text;
      if (entry.attachments?.length) {
        const box = document.createElement('div');
        box.className = 'owner-attachments';
        for (const attachment of entry.attachments) {
          if (attachment.id) {
            const shot = thumbnail(attachment.id, attachment.width ?? 4, attachment.height ?? 3);
            box.append(shot);
          } else {
            const chip = document.createElement('div');
            chip.className = 'chip-file';
            const ext = document.createElement('span');
            ext.className = 'ext';
            ext.textContent = extension(attachment.name);
            const name = document.createElement('span');
            name.textContent = attachment.name;
            chip.append(ext, name);
            box.append(chip);
          }
        }
        item.append(box);
      }
    } else if (entry.kind === 'agent') {
      item.className = 'agent';
      item.append(renderMarkdown(document, entry.text, { image: imageButton }), copyButton(entry.text));
    } else {
      item.className = entry.kind;
      item.textContent = entry.text;
    }
    list.append(item);
  }
  if (skillable()) list.append(saveSkillRow());
  if (state.atLimit && state.status === 'idle') list.append(continueRow());
  if (steerFocused) document.getElementById('skill-focus')?.focus();
  announce(entries);
  list.scrollTop = list.scrollHeight;
  $('empty').hidden = state.transcript.length > 0;
  list.hidden = state.transcript.length === 0;
  $<HTMLButtonElement>('more').disabled = state.transcript.length === 0;

  const running = state.status === 'running';
  const paused = state.status === 'paused';
  $('stop').hidden = !running && !paused;
  $('resume').hidden = !paused;
  // While it works, Send adds to the task (its accessible name stays "Send").
  $('send').dataset['tip'] = running ? 'Add to the task' : 'Send';
  const wait = state.stepWait;
  $('step').hidden = !wait;
  if (wait) {
    $('step-text').textContent = wait.text;
    $('step-why').textContent = wait.why ?? '';
  }
  const status = $('status');
  // A question says it is waiting by itself.
  status.hidden = (!running && !paused) || !!state.question;
  status.textContent = '';
  status.classList.toggle('working', running && !wait && !state.question);
  if (running && wait) {
    status.textContent = 'Waiting for you: press Next step, here or in the page.';
  } else if (running) {
    const spinner = document.createElement('span');
    spinner.className = 'spinner';
    spinner.setAttribute('aria-hidden', 'true');
    status.append(spinner, `Working… ${state.actions} step${state.actions === 1 ? '' : 's'}`);
  } else if (paused) {
    status.textContent = `Paused: ${state.pauseReason ?? ''}`;
  }
  // During a run, the connection the run pinned; otherwise the one Settings has active.
  if (state.connection && state.status !== 'idle') showConnection(state.connection);
  else void renderActiveConnection();

  renderCard();
  renderQuestion();
  keepAlive(running);
  renderTab();
}

/** Heartbeats keep the worker from being stopped while it works for this panel: during a run, and while it writes a skill draft. */
function keepAlive(busy: boolean): void {
  const needed = busy || !!drafting;
  if (needed && !heartbeat) heartbeat = setInterval(() => send({ type: 'heartbeat' }), HEARTBEAT_MS);
  if (!needed && heartbeat) { clearInterval(heartbeat); heartbeat = undefined; }
}

type Entry = PanelState['transcript'][number];
type StepEntry = Extract<Entry, { kind: 'action' }>;

/** Notes about approvals: history once answered, folded with the steps around them. */
function foldable(entry: Entry): boolean {
  return entry.kind === 'notice' && /^(Asking you|Allowed|Denied|Using skill)/.test(entry.text);
}

/** Folds the owner opened, by the index of their first entry, so a re-render keeps them open. */
const openFolds = new Set<number>();

/** Three dots that pulse while the agent is still at it. */
function dots(): HTMLElement {
  const holder = document.createElement('span');
  holder.className = 'dots';
  holder.setAttribute('aria-hidden', 'true');
  holder.append(...[0, 1, 2].map(() => document.createElement('i')));
  return holder;
}

/** A step as its row says it: done, under way (…), or what went wrong. */
function stepText(entry: StepEntry): string {
  if (entry.outcome === 'ok') return entry.text;
  if (entry.outcome === 'pending') return `${entry.text}…`;
  return `${entry.text} — ${entry.outcome}`;
}

/** One step as a quiet row; its outcome and detail open on click. */
function stepRow(entry: StepEntry, withImage: boolean): HTMLLIElement {
  const item = document.createElement('li');
  item.className = 'step';
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.className = `action ${entry.outcome}`;
  summary.textContent = stepText(entry);
  details.append(summary);
  if (entry.detail) {
    const detail = document.createElement('div');
    detail.className = 'detail';
    detail.textContent = entry.detail;
    details.append(detail);
  }
  item.append(details);
  if (withImage && entry.image) item.append(thumbnail(entry.image.id, entry.image.width, entry.image.height, entry.image.expired));
  return item;
}

/**
 * A stretch of steps. One step shows as its row. More fold into one line —
 * how many, and the latest step that was more than reading the page — with
 * any problem named in it; screenshots stay visible below.
 */
function activity(group: Entry[], key: number, live = false): HTMLLIElement[] {
  const steps = group.filter((entry): entry is StepEntry => entry.kind === 'action');
  const images = steps.filter((step) => step.image).map((step) => {
    const holder = document.createElement('li');
    holder.className = 'step';
    holder.append(thumbnail(step.image!.id, step.image!.width, step.image!.height, step.image!.expired));
    return holder;
  });
  if (group.length === 1 && steps.length === 1) {
    const row = stepRow(steps[0]!, true);
    if (live) row.querySelector('summary')!.append(dots());
    return [row];
  }

  const item = document.createElement('li');
  item.className = 'activity';
  const details = document.createElement('details');
  details.open = openFolds.has(key);
  details.ontoggle = () => { if (details.open) openFolds.add(key); else openFolds.delete(key); };
  const summary = document.createElement('summary');
  const problems = steps.filter((step) => step.outcome !== 'ok' && step.outcome !== 'pending');
  const telling = [...steps].reverse().find((step) => step.text !== 'Read the page') ?? steps.at(-1)!;
  const count = document.createElement('span');
  count.className = 'count-steps';
  count.textContent = `${steps.length} step${steps.length === 1 ? '' : 's'}`;
  const latest = document.createElement('span');
  latest.className = 'latest';
  latest.textContent = stepText(telling);
  summary.append(count, latest);
  if (live) summary.append(dots());
  if (problems.length > 0 && !(problems.length === 1 && problems[0] === telling)) {
    const issue = document.createElement('span');
    issue.className = `issue ${problems.some((step) => step.outcome === 'unknown' || step.outcome === 'error') ? 'error' : 'refused'}`;
    issue.textContent = `${problems.length} not done`;
    summary.append(issue);
  }
  const list = document.createElement('ol');
  list.className = 'activity-steps';
  for (const entry of group) {
    if (entry.kind === 'action') list.append(stepRow(entry, false));
    else { const note = document.createElement('li'); note.className = 'notice'; note.textContent = entry.kind === 'notice' ? entry.text : ''; list.append(note); }
  }
  details.append(summary, list);
  item.append(details);
  return [item, ...images];
}

/** The approval card: the owner's Allow once / Always / Deny. */
/** The approval the card is showing, so focus moves into it once per card, not on every render. */
let cardFor: string | undefined;

function renderCard(): void {
  const card = $('card');
  const approval = state?.approval;
  card.hidden = !approval;
  if (!approval) { cardFor = undefined; return; }
  const text = $('card-text');
  text.textContent = '';
  const decide = (decision: 'once' | 'chat' | 'auto' | 'deny') => () => send({ type: 'decide', id: approval.id, decision });
  $('card-once').onclick = decide('once');
  $('card-chat').onclick = decide('chat');
  $('card-auto').onclick = decide('auto');
  $('card-deny').onclick = decide('deny');
  // A dialog takes the focus when it appears, so a keyboard or screen reader user meets it at once.
  if (cardFor !== approval.id) { cardFor = approval.id; $('card-once').focus(); }
  // Auto is for sites only: a form submission always gets its own answer.
  $('card-auto').hidden = approval.kind === 'submit';
  $('card-once').title = approval.kind === 'submit' ? 'Send this submission only' : 'For this request only';
  if (approval.kind === 'submit' && approval.submit) {
    // Built from nodes only: field values come from a page.
    const where = document.createElement('strong');
    where.textContent = approval.submit.action;
    text.append(`Submit this form${approval.submit.submitter ? ` ("${approval.submit.submitter}")` : ''} to `, where, ` (${approval.submit.method})?`);
    if (approval.submit.fields.length > 0) {
      const list = document.createElement('ul');
      list.className = 'fields';
      for (const field of approval.submit.fields) {
        const item = document.createElement('li');
        const name = document.createElement('span');
        name.className = 'muted';
        name.textContent = `${field.name}: `;
        item.append(name, field.value || '(empty)');
        list.append(item);
      }
      text.append(list);
    } else {
      text.append(document.createElement('br'), 'The agent did not fill any field in this form.');
    }
    return;
  }
  const origin = document.createElement('strong');
  origin.textContent = approval.origin;
  const leads: Record<string, string> = {
    navigate: 'The agent wants to open ',
    link: 'The agent wants to follow a link to ',
    blocked: 'A page tried to send the agent to ',
    landed: 'The tab is now on ',
  };
  const lead = leads[approval.reason] ?? 'The agent wants to use ';
  const tail = approval.reason === 'blocked' ? '. It was blocked; nothing was sent there. Allow the agent to go there?' : '. Allow it?';
  text.append(lead, origin, tail);
}

/** The question the picker is showing, and what the owner has picked in it so far (multi). */
let askFor: string | undefined;
let askPicked = new Set<string>();

/**
 * A question from the agent takes the composer's place: its options, one
 * click for a single choice and Send for several; "Something else…" for an
 * answer of the owner's own; Skip to let the agent decide; and Stop, which
 * the hidden composer would otherwise hold.
 */
function renderQuestion(): void {
  const box = $('ask');
  const question = state?.question;
  box.hidden = !question;
  $('box').hidden = !!question;
  if (!question) { askFor = undefined; askPicked = new Set(); return; }
  const fresh = askFor !== question.id;
  if (fresh) {
    askFor = question.id;
    askPicked = new Set();
    $<HTMLTextAreaElement>('ask-input').value = '';
    showOwnAnswer(false);
  }
  // Built from nodes only: the words are the model's, and may come from a page.
  $('ask-text').textContent = question.question;
  const options = $('ask-options');
  options.textContent = '';
  question.options.forEach((option, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ask-option';
    const label = document.createElement('span');
    label.className = 'label';
    label.append(option.label);
    if (index === 0) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = 'Suggested';
      label.append(tag);
    }
    button.append(label);
    if (option.hint) {
      const hint = document.createElement('span');
      hint.className = 'hint';
      hint.textContent = option.hint;
      button.append(hint);
    }
    if (question.multi) {
      button.setAttribute('aria-pressed', String(askPicked.has(option.label)));
      button.onclick = () => {
        if (askPicked.has(option.label)) askPicked.delete(option.label); else askPicked.add(option.label);
        renderQuestion();
      };
    } else {
      button.onclick = () => send({ type: 'answer', id: question.id, picked: [option.label] });
    }
    options.append(button);
  });
  const sendButton = $<HTMLButtonElement>('ask-send');
  sendButton.hidden = !question.multi;
  sendButton.disabled = askPicked.size === 0;
  sendButton.onclick = () => send({ type: 'answer', id: question.id, picked: [...askPicked] });
  $('ask-skip').onclick = () => send({ type: 'answer', id: question.id, skip: true });
  // Met at once by keyboard and screen reader users, once per question.
  if (fresh) (options.firstElementChild as HTMLElement | null)?.focus();
}

/** "Something else…": a field of its own in the picker, for an answer the options do not have. */
function showOwnAnswer(open: boolean): void {
  $('ask-own').hidden = !open;
  $('ask-other').setAttribute('aria-expanded', String(open));
  if (open) $('ask-input').focus();
}

/** The owner's own answer: while a question is open, the worker takes a message as the answer to it. */
function sendOwnAnswer(): void {
  const input = $<HTMLTextAreaElement>('ask-input');
  const text = input.value.trim();
  if (!text || !state?.question) return;
  send({ type: 'run', goal: text });
  input.value = '';
}

/** The approval mode, as the composer shows it: a word, amber in Auto, a menu to change it. */
function renderMode(): void {
  const mode = state?.mode ?? 'ask';
  const button = $('mode');
  button.firstChild!.textContent = mode === 'auto' ? 'Auto' : 'Ask';
  button.classList.toggle('auto', mode === 'auto');
  button.setAttribute('aria-label', `Approvals: ${mode === 'auto' ? 'Auto' : 'Ask'}`);
  button.dataset['tip'] = mode === 'auto' ? 'Auto: sites, searches and filters go through without asking; a form that sends data still asks. Click to change.' : 'Ask: before each new site and each form. Click to change.';
  $('mode-ask').setAttribute('aria-checked', String(mode === 'ask'));
  $('mode-auto').setAttribute('aria-checked', String(mode === 'auto'));
}

/** Learn, as the composer shows it: lit while on. */
function renderLearn(): void {
  const on = state?.learning === true;
  const button = $('learn');
  button.setAttribute('aria-pressed', String(on));
  button.dataset['tip'] = on ? 'Learn is on: each step is explained and waits for Next. Click to turn it off.' : 'Learn: before each step the agent points at where it will go, says what it will do and why, and waits for you.';
}

function closeModeMenu(): void {
  $('mode-menu').hidden = true;
  $('mode').setAttribute('aria-expanded', 'false');
}

function toggleModeMenu(): void {
  const menu = $('mode-menu');
  if (!menu.hidden) { closeModeMenu(); return; }
  closeWhere();
  closeAddMenu();
  $('tab-menu').hidden = true;
  menu.hidden = false;
  $('mode').setAttribute('aria-expanded', 'true');
  $((state?.mode ?? 'ask') === 'auto' ? 'mode-auto' : 'mode-ask').focus();
}

function chooseMode(mode: 'ask' | 'auto'): void {
  closeModeMenu();
  send({ type: 'set-mode', mode });
  $('goal').focus();
}

async function renderActiveConnection(): Promise<void> {
  const view = await ai.get();
  const active = view.connections.find((connection) => connection.id === view.activeId);
  showConnection(active ? { label: active.label, model: active.model || 'Pick a model' } : null);
}

/** The model chip: the connection muted, the model in bold, a dot that says whether there is one. */
function showConnection(connection: { label: string; model: string } | null): void {
  const chip = $('connection');
  $('model').classList.toggle('none', !connection);
  if (!connection) { chip.textContent = 'No model yet · Add one'; return; }
  const label = document.createElement('span');
  label.className = 'conn';
  label.textContent = `${connection.label} · `;
  const model = document.createElement('b');
  model.textContent = connection.model;
  chip.replaceChildren(label, model);
}

function submit(): void {
  const goal = $<HTMLTextAreaElement>('goal');
  const text = goal.value.trim();
  if (capturing.size > 0 || preparing > 0) { showError('Wait for the attachments to finish loading.'); return; }
  if (!text && pending.length === 0) return;
  // Checked here too, so a refused batch never costs the owner their draft.
  const refused = checkAttachments(pending);
  if (refused) { showError(refused); return; }
  dictation.stop();
  const choice = whereNow();
  send({ type: 'run', goal: text, ...(choice === 'this' && currentTab?.id !== undefined ? { tabId: currentTab.id } : {}), useNewTab: choice === 'new',
    ...(pending.length > 0 ? { attachments: pending } : {}), ...(chosenSkills.length > 0 ? { skillIds: chosenSkills.map((skill) => skill.id) } : {}) });
  goal.value = '';
  clearTimeout(draftTimer);
  void chrome.storage.session.set({ [DRAFT_KEY]: '' });
  chosenSkills = [];
  renderSkillChips();
  // The pick is for this request; the next one goes back to the default (continue, once there is a workspace).
  wherePick = null;
  renderTab();
  pending = [];
  renderPending();
  showError('');
  grow();
}

/* ---- attachments: picked, dropped, pasted, or a screenshot of a tab ---- */

let pending: Attachment[] = [];
/** Files still being read or scaled: Send waits for them. */
let preparing = 0;
/** Screenshots on their way from the worker, by request id, with the tab's title. */
const capturing = new Map<string, string>();

const extension = (name: string) => (name.includes('.') ? name.split('.').pop()!.slice(0, 4).toUpperCase() : 'FILE');

function showError(text: string): void {
  const box = $('composer-error');
  box.textContent = text;
  box.hidden = !text;
}

async function addFiles(files: Iterable<File>): Promise<void> {
  const errors: string[] = [];
  const list = [...files];
  preparing += list.length;
  renderPending();
  try {
    for (const file of list) {
      if (pending.length + capturing.size >= MAX_ATTACHMENTS) errors.push(`Attach at most ${MAX_ATTACHMENTS} files at a time.`);
      else {
        const read = await readAttachment(file);
        if ('error' in read) errors.push(read.error); else pending.push(read);
      }
      preparing -= 1;
      renderPending();
    }
  } finally {
    preparing = Math.max(0, preparing);
  }
  showError([...new Set(errors)].join(' '));
  renderPending();
}

function renderPending(): void {
  const box = $('attachments');
  box.textContent = '';
  pending.forEach((attachment, index) => {
    const chip = document.createElement('div');
    chip.className = `pending ${attachment.kind === 'image' ? 'image' : 'file'}`;
    chip.title = attachment.name;
    if (attachment.kind === 'image') {
      // The whole thumbnail opens the image large; the × on top of it still only removes it.
      const open = document.createElement('button');
      open.className = 'open';
      open.setAttribute('aria-label', `Open ${attachment.name}`);
      open.title = attachment.name;
      const image = document.createElement('img');
      image.alt = attachment.name;
      image.src = `data:image/jpeg;base64,${attachment.data}`;
      open.append(image);
      open.onclick = () => { void viewPending(attachment, image.src); };
      chip.append(open);
    } else {
      const ext = document.createElement('span');
      ext.className = 'ext';
      ext.textContent = extension(attachment.name);
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = attachment.name;
      chip.append(ext, name);
    }
    const remove = document.createElement('button');
    remove.className = 'remove';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `Remove ${attachment.name}`);
    remove.onclick = () => { pending.splice(index, 1); renderPending(); };
    chip.append(remove);
    box.append(chip);
  });
  if (preparing > 0) {
    const chip = document.createElement('div');
    chip.className = 'pending busy';
    chip.textContent = `Loading ${preparing} file${preparing === 1 ? '' : 's'}…`;
    box.append(chip);
  }
  for (const title of capturing.values()) {
    const chip = document.createElement('div');
    chip.className = 'pending busy';
    chip.textContent = `Capturing ${title.slice(0, 24)}…`;
    box.append(chip);
  }
  box.hidden = pending.length === 0 && capturing.size === 0 && preparing === 0;
}

/**
 * The camera: Chrome's own "Choose what to share" dialog — a tab, a window or
 * the screen — and one frame of it becomes an attachment. Where the dialog is
 * not available, the menu of this window's tabs instead.
 */
/** The + menu: files, or a screenshot. */
function closeAddMenu(): void {
  $('add-menu').hidden = true;
  $('add').setAttribute('aria-expanded', 'false');
}

function toggleAddMenu(): void {
  const menu = $('add-menu');
  if (!menu.hidden) { closeAddMenu(); return; }
  closeWhere();
  closeModeMenu();
  $('tab-menu').hidden = true;
  menu.hidden = false;
  $('add').setAttribute('aria-expanded', 'true');
  $('add-files').focus();
}

async function pickToShare(): Promise<void> {
  if (!$('tab-menu').hidden) { $('tab-menu').hidden = true; return; }
  closeWhere();
  if (pending.length + capturing.size >= MAX_ATTACHMENTS) { showError(`Attach at most ${MAX_ATTACHMENTS} files at a time.`); return; }
  const frame = await grabFrame();
  if (frame.status === 'unavailable') { await openTabMenu(); return; }
  if (frame.status === 'cancelled') return;
  if (frame.status === 'failed') { showError(`Could not take the screenshot: ${frame.error}`); return; }
  preparing += 1;
  renderPending();
  const read = await readAttachment(new File([frame.image], frame.name, { type: 'image/png' }));
  preparing -= 1;
  if ('error' in read) showError(read.error); else { pending.push(read); showError(''); }
  renderPending();
}

async function openTabMenu(): Promise<void> {
  const menu = $('tab-menu');
  if (!menu.hidden) { menu.hidden = true; return; }
  closeWhere();
  const tabs = (await chrome.tabs.query({ currentWindow: true })).filter((tab) => usable(tab.url) && tab.id !== undefined);
  menu.textContent = '';
  if (tabs.length === 0) {
    const none = document.createElement('div');
    none.className = 'empty-menu';
    none.textContent = 'No web pages open in this window.';
    menu.append(none);
  }
  for (const tab of tabs) {
    const item = document.createElement('button');
    item.setAttribute('role', 'menuitem');
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = tab.title || tab.url!;
    const host = document.createElement('small');
    host.textContent = new URL(tab.url!).host;
    item.append(title, host);
    item.onclick = () => {
      menu.hidden = true;
      if (pending.length + capturing.size >= MAX_ATTACHMENTS) { showError(`Attach at most ${MAX_ATTACHMENTS} files at a time.`); return; }
      const requestId = `cap-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      capturing.set(requestId, tab.title || 'tab');
      renderPending();
      send({ type: 'capture-tab', tabId: tab.id!, requestId });
    };
    menu.append(item);
  }
  menu.hidden = false;
  (menu.querySelector('button') as HTMLElement | null)?.focus();
}

async function captured(message: Extract<WorkerMessage, { type: 'captured' }>): Promise<void> {
  const title = capturing.get(message.requestId);
  if (title === undefined) return;
  const thumb = message.image ? await thumbnailOf(message.image.data) : undefined;
  capturing.delete(message.requestId);
  if (message.image) {
    const name = `Screenshot of ${(message.image.title || title).replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 60).trim()}.jpg`;
    pending.push({ kind: 'image', name, mimeType: 'image/jpeg', bytes: Math.round(message.image.data.length * 0.75),
      data: message.image.data, width: message.image.width, height: message.image.height, ...(thumb ? { thumb } : {}) });
    showError('');
  } else {
    showError(`Could not take the screenshot: ${message.error ?? 'unknown error'}`);
  }
  renderPending();
}

/* ---- dictation ---- */

// The mic writes into the goal box as the owner speaks, and tidies punctuation once they stop (src/dictation).
const dictation = attachDictation($<HTMLTextAreaElement>('goal'), {
  onInput: () => grow(),
  onListening: (listening) => $('mic').setAttribute('aria-pressed', String(listening)),
  onEnd: (error) => {
    // The side panel cannot show the microphone prompt: the first time, mic.html asks in a tab.
    if (error === 'not-allowed') {
      showError('Allow the microphone in the tab that just opened, then press the mic again.');
      void chrome.tabs.create({ url: chrome.runtime.getURL('mic.html') });
    } else if (error) {
      showError(`Dictation stopped: ${error}.`);
    }
  },
});

function toggleDictation(): void {
  if (dictation.toggle()) { showError(''); $<HTMLTextAreaElement>('goal').focus(); }
}

/* Settings → Dictation: Chrome downloads its built-in model only when asked, so the owner gets a button for it. */

const builtInModel = onDeviceModel(globalThis.navigator?.language || 'en-US');
let modelDownload: AbortController | undefined;

const MODEL_STATES: Record<ModelState['kind'], string> = {
  unsupported: '',
  downloadable: 'Not downloaded. About 2 GB, downloaded once by Chrome and shared with every site and extension that uses it.',
  downloading: 'Chrome is downloading it.',
  ready: 'Ready: dictation gets its punctuation from it.',
};

function showModel(state: ModelState, note = ''): void {
  const downloading = modelDownload !== undefined;
  $('dictation-model-state').textContent = note || (state.kind === 'unsupported' ? state.reason : MODEL_STATES[state.kind]);
  $('dictation-model-download').hidden = downloading || state.kind !== 'downloadable';
  $('dictation-model-cancel').hidden = !downloading;
  $('dictation-model-progress').hidden = !downloading;
}

async function renderModel(): Promise<void> {
  if (modelDownload) return;
  showModel(await builtInModel.state());
}

$('dictation-model-download').onclick = async () => {
  if (modelDownload) return;
  const controller = new AbortController();
  modelDownload = controller;
  const bar = $<HTMLProgressElement>('dictation-model-progress');
  bar.value = 0;
  showModel({ kind: 'downloading' }, 'Starting the download…');
  try {
    const state = await builtInModel.download({
      signal: controller.signal,
      onProgress: (fraction) => {
        bar.value = fraction;
        $('dictation-model-state').textContent = `Downloading… ${Math.round(fraction * 100)}%`;
      },
    });
    modelDownload = undefined;
    showModel(state);
  } catch (error) {
    modelDownload = undefined;
    const state = await builtInModel.state();
    if (error instanceof Error && error.name === 'AbortError') {
      // Chrome may finish a download that was well under way; say which happened.
      showModel(state, state.kind === 'ready' ? MODEL_STATES.ready
        : state.kind === 'downloading' ? 'Cancelled here, but Chrome is finishing the download in the background.' : 'Download cancelled.');
    } else {
      showModel(state, `The download did not finish: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
};
$('dictation-model-cancel').onclick = () => modelDownload?.abort();

/** The composer grows with what is typed, up to its max height. */
function grow(): void {
  const goal = $<HTMLTextAreaElement>('goal');
  goal.style.height = 'auto';
  goal.style.height = `${goal.scrollHeight}px`;
}

const PACE_NOTES: Record<string, string> = {
  fast: 'Each action at once. Fields that suggest as you type still get real key presses. (Learn, in the message box, moves naturally while it is on.)',
  natural: 'Types letter by letter, moves the mouse smoothly and pauses between actions, so you can follow along. Slower.',
};

/** Providers that sign in instead of taking a key, and what their button says. */
async function renderPace(): Promise<void> {
  const pace = (await chrome.storage.local.get(PACE_KEY))[PACE_KEY] === 'natural' ? 'natural' : 'fast';
  $('pace-note').textContent = PACE_NOTES[pace]!;
  for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="pace"]')) {
    radio.checked = radio.value === pace;
    radio.onchange = () => {
      if (!radio.checked) return;
      $('pace-note').textContent = PACE_NOTES[radio.value]!;
      void chrome.storage.local.set({ [PACE_KEY]: radio.value });
    };
  }
}

/** Settings → Check in after: how many actions (and minutes) a run goes before it stops for the owner. */
async function renderLimit(): Promise<void> {
  const chosen = runLimit((await chrome.storage.local.get(LIMIT_KEY))[LIMIT_KEY]);
  const note = (limit: (typeof RUN_LIMITS)[number]) => `A run stops for you after ${limit.actions} browser actions or ${limit.minutes} minutes, whichever comes first; Continue picks it up.${limit.actions > RUN_LIMITS[0].actions ? ' Longer runs use more of your model.' : ''}`;
  const group = $('limits');
  group.textContent = '';
  for (const limit of RUN_LIMITS) {
    const label = document.createElement('label');
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'limit';
    radio.value = String(limit.actions);
    radio.checked = limit.actions === chosen.actions;
    radio.onchange = () => {
      if (!radio.checked) return;
      $('limit-note').textContent = note(limit);
      void chrome.storage.local.set({ [LIMIT_KEY]: limit.actions });
    };
    const text = document.createElement('span');
    text.textContent = `${limit.actions} steps`;
    label.append(radio, text);
    group.append(label);
  }
  $('limit-note').textContent = note(chosen);
}

/** After a run stopped at its limit: Continue, as the owner would say it. */
function continueRow(): HTMLLIElement {
  const item = document.createElement('li');
  item.className = 'continue-row';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'primary';
  button.textContent = 'Continue';
  button.onclick = () => { button.disabled = true; send({ type: 'run', goal: 'Continue' }); };
  item.append(button);
  return item;
}

function showSettings(open: boolean): void {
  $('open-settings').setAttribute('aria-pressed', String(open));
  $('settings-view').hidden = !open;
  $('chat-view').hidden = open;
  if (open) { void connections.render(); void renderPace(); void renderLimit(); void renderSkills(); void renderModel(); }
  else { send({ type: 'get' }); void renderActiveConnection(); }
}

/* ---- taking the conversation away: copy, save ---- */

async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

const COPY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8.5" y="8.5" width="11" height="11" rx="2" /><path d="M15.5 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5" /></svg>';
const CHECK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>';

/** A small copy icon on an answer (no text of its own, so the answer reads the same with it), a check for a moment once copied. */
function copyButton(text: string): HTMLButtonElement {
  const button = iconButton(COPY_ICON, 'Copy this answer', async () => {
    const ok = await copyText(text);
    button.innerHTML = ok ? CHECK_ICON : COPY_ICON;
    button.setAttribute('aria-label', ok ? 'Copied' : 'Could not copy');
    button.classList.toggle('done', ok);
    setTimeout(() => { button.innerHTML = COPY_ICON; button.setAttribute('aria-label', 'Copy this answer'); button.classList.remove('done'); }, 1500);
  }, 'copy');
  button.title = 'Copy this answer as Markdown';
  return button;
}

function conversationTitle(): string {
  const first = state?.transcript.find((entry) => entry.kind === 'owner');
  const goal = first && first.kind === 'owner' ? first.text.trim().replace(/\s+/g, ' ') : '';
  return goal ? goal.slice(0, 60) : 'Valet conversation';
}

async function copyConversation(): Promise<void> {
  if (!state) return;
  const ok = await copyText(conversationMarkdown(state.transcript, conversationTitle()));
  showError(ok ? '' : 'Could not copy to the clipboard.');
}

/** One HTML file with everything the panel shows, the screenshots read from storage. */
/** The run trace, asked of the worker and saved as a file: for diagnosing a run that went wrong. */
let tracing: string | undefined;

function saveTrace(): void {
  tracing = `trace-${Date.now()}`;
  send({ type: 'export-trace', requestId: tracing });
}

function savedTrace(message: Extract<WorkerMessage, { type: 'trace' }>): void {
  if (message.requestId !== tracing) return;
  tracing = undefined;
  const url = URL.createObjectURL(new Blob([message.json], { type: 'application/json' }));
  download(url, `valet-trace-${new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '')}.json`);
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function saveConversation(): Promise<void> {
  if (!state) return;
  const ids = state.transcript.flatMap((entry) =>
    entry.kind === 'file' && !entry.expired ? [entry.id]
      : entry.kind === 'action' && entry.image && !entry.image.expired ? [entry.image.id]
        : entry.kind === 'owner' ? (entry.attachments ?? []).flatMap((attachment) => (attachment.id ? [attachment.id] : [])) : []);
  const stored = new Map<string, Media>();
  for (const id of ids) {
    const value = (await chrome.storage.session.get(`${MEDIA_PREFIX}${id}`))[`${MEDIA_PREFIX}${id}`] as Media | undefined;
    if (value) stored.set(id, value);
  }
  const html = conversationHtml(state.transcript, (id) => stored.get(id), conversationTitle());
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
  download(url, `valet-${new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '')}.html`);
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function closeMore(): void {
  $('more-menu').hidden = true;
  $('more').setAttribute('aria-expanded', 'false');
}

function toggleMore(): void {
  const menu = $('more-menu');
  if (!menu.hidden) { closeMore(); return; }
  menu.hidden = false;
  $('more').setAttribute('aria-expanded', 'true');
  ($('copy-conversation') as HTMLElement).focus();
}

/* ---- skills: the owner's notes ---- */

const skillStore = () => chrome.storage.sync;
/** Skills the owner brought into the next message with @. */
let chosenSkills: Skill[] = [];

function renderSkillChips(): void {
  const box = $('skill-chips');
  box.textContent = '';
  for (const skill of chosenSkills) {
    const chip = document.createElement('span');
    chip.className = 'skill-chip';
    chip.append(`@${skill.name}`);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `Remove skill ${skill.name}`);
    remove.onclick = () => { chosenSkills = chosenSkills.filter((known) => known.id !== skill.id); renderSkillChips(); };
    chip.append(remove);
    box.append(chip);
  }
  box.hidden = chosenSkills.length === 0;
}

/** The @ menu: the enabled skills, one click brings it into the message. */
async function openSkillMenu(): Promise<void> {
  const menu = $('skill-menu');
  closeWhere();
  closeModeMenu();
  $('tab-menu').hidden = true;
  const skills = (await loadSkills(skillStore()).catch(() => [])).filter((skill) => skill.enabled && !chosenSkills.some((chosen) => chosen.id === skill.id));
  menu.textContent = '';
  if (skills.length === 0) {
    const none = document.createElement('div');
    none.className = 'empty-menu';
    none.textContent = chosenSkills.length > 0 ? 'Every skill is already in this message.' : 'No skills yet. Add one in Settings.';
    menu.append(none);
  }
  for (const skill of skills) {
    const item = document.createElement('button');
    item.type = 'button';
    item.setAttribute('role', 'menuitem');
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = skill.name;
    const detail = document.createElement('small');
    detail.textContent = skill.sites.length > 0 ? skill.sites.join(', ') : 'Every task';
    item.append(title, detail);
    item.onclick = () => {
      closeSkillMenu();
      chosenSkills.push(skill);
      renderSkillChips();
      // The @ that opened the menu goes; the chip stands for it.
      const goal = $<HTMLTextAreaElement>('goal');
      if (goal.value.endsWith('@')) goal.value = goal.value.slice(0, -1);
      goal.focus();
    };
    menu.append(item);
  }
  menu.hidden = false;
  (menu.querySelector('button') as HTMLElement | null)?.focus();
}

function closeSkillMenu(): void {
  $('skill-menu').hidden = true;
}

/**
 * An image the model wrote (`![alt](url)`): a button with its description, and
 * the picture only once the owner clicks — a page the agent read could have
 * planted the address, and loading it would be a request the owner never made.
 */
/** What a screen reader hears: the newest answer or notice, once, rather than the whole transcript on every rebuild. */
let announced = '';
function announce(entries: readonly Entry[]): void {
  const newest = [...entries].reverse().find((entry) => entry.kind === 'agent' || entry.kind === 'notice' || (entry.kind === 'action' && entry.outcome !== 'ok' && entry.outcome !== 'pending'));
  const text = !newest ? '' : newest.kind === 'action' ? `${newest.text}: ${newest.outcome}` : newest.kind === 'file' ? '' : newest.text;
  if (text === announced) return;
  announced = text;
  $('announce').textContent = text;
}

/** Images the owner chose to show: they stay shown when the transcript is rebuilt. */
const shownImages = new Set<string>();

function imageButton(doc: Document, alt: string, src: string): Node {
  const picture = () => {
    const image = doc.createElement('img');
    image.alt = alt;
    image.onerror = () => { const gone = doc.createElement('span'); gone.className = 'muted'; gone.textContent = alt ? `${alt} (image could not be loaded)` : 'Image could not be loaded'; image.replaceWith(gone); };
    image.src = src;
    return image;
  };
  if (shownImages.has(src)) return picture();
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = 'md-image';
  button.textContent = alt ? `Show image: ${alt}` : 'Show image';
  button.title = src;
  button.onclick = () => { shownImages.add(src); button.replaceWith(picture()); };
  return button;
}

/**
 * "Save as skill": a quiet offer under the last answer of a run that took
 * steps. It opens a small card for a steer (optional), then the worker asks the
 * model for a draft, which opens in the Settings form for the owner to edit.
 */
let drafting: string | undefined;
/** The card is open: it stays so across renders until written or cancelled, and what was typed in it stays too. */
let steering = false;
let steerText = '';

/** Whether the conversation has something to turn into a skill: a finished run that took at least one step. */
function skillable(): boolean {
  return state?.status === 'idle' && state.transcript.at(-1)?.kind === 'agent' && state.transcript.some((entry) => entry.kind === 'action');
}

function saveSkillRow(): HTMLLIElement {
  const item = document.createElement('li');
  item.className = 'save-skill-row';
  if (drafting) {
    const note = document.createElement('span');
    note.className = 'save-skill';
    note.textContent = 'Writing the skill…';
    item.append(note);
    return item;
  }
  if (!steering) {
    const button = document.createElement('button');
    button.className = 'save-skill';
    button.textContent = 'Save as skill';
    button.title = 'Turn what worked here into a note the agent reads next time. You edit it before it is kept.';
    button.onclick = () => { steering = true; render(); $('skill-focus').focus(); };
    item.append(button);
    return item;
  }
  const card = document.createElement('div');
  card.className = 'save-skill-card';
  const lead = document.createElement('p');
  lead.textContent = 'The agent writes a note from this conversation; you edit it before it is kept.';
  const input = document.createElement('input');
  input.id = 'skill-focus';
  input.placeholder = 'Anything in particular? e.g. only the search steps, skip the sign-in';
  input.setAttribute('aria-label', 'What the note should be about (optional)');
  input.autocomplete = 'off';
  input.value = steerText;
  input.oninput = () => { steerText = input.value; };
  const row = document.createElement('div');
  row.className = 'row';
  const write = document.createElement('button');
  write.className = 'primary';
  write.textContent = 'Write it';
  const cancel = document.createElement('button');
  cancel.className = 'ghost';
  cancel.textContent = 'Cancel';
  const close = () => { steering = false; steerText = ''; render(); };
  const go = () => {
    drafting = `draft-${Date.now()}`;
    const focus = input.value.trim();
    send({ type: 'draft-skill', requestId: drafting, ...(focus ? { focus } : {}) });
    keepAlive(state?.status === 'running' || state?.status === 'paused');
    close();
  };
  write.onclick = go;
  input.onkeydown = (event) => { if (event.key === 'Enter') { event.preventDefault(); go(); } if (event.key === 'Escape') close(); };
  cancel.onclick = close;
  row.append(write, cancel);
  card.append(lead, input, row);
  item.append(card);
  return item;
}

/** From the conversation menu: the same card, brought into view. */
function saveSkillFromMenu(): void {
  if (!skillable()) { showError(state?.status === 'idle' ? 'Nothing to turn into a skill yet: the agent has not taken any steps in this conversation.' : 'Wait for the agent to finish first.'); return; }
  showSettings(false);
  steering = true;
  render();
  $('skill-focus').scrollIntoView({ block: 'nearest' });
  $('skill-focus').focus();
}

/** The draft in the form came from the conversation: Rewrite is offered. */
let fromDraft = false;

async function drafted(message: Extract<WorkerMessage, { type: 'skill-draft' }>): Promise<void> {
  if (message.requestId !== drafting) return;
  drafting = undefined;
  render();
  $('skill-rewrite-go').textContent = 'Rewrite';
  ($('skill-rewrite-go') as HTMLButtonElement).disabled = false;
  keepAlive(state?.status === 'running' || state?.status === 'paused');
  if (!message.draft) {
    const said = message.error ?? 'The skill could not be written.';
    if ($('settings-view').hidden) showError(said); else $('skills-status').textContent = said;
    return;
  }
  showSettings(true);
  await renderSkills();
  fromDraft = true;
  openSkillForm({ id: '', name: message.draft.name, sites: message.draft.sites, text: message.draft.text, enabled: true, updatedAt: 0 });
  $('skill-form').scrollIntoView({ block: 'nearest' });
  $('skills-status').textContent = 'A draft from this conversation: check it, then Save. Or say what to change, and Rewrite.';
}

/** Rewrite: the draft in the form goes back to the model with the owner's change. */
function rewriteDraft(): void {
  const focus = $<HTMLInputElement>('skill-rewrite').value.trim();
  const previous = $<HTMLTextAreaElement>('skill-text').value;
  if (!focus && !previous.trim()) return;
  drafting = `draft-${Date.now()}`;
  keepAlive(state?.status === 'running' || state?.status === 'paused');
  $('skill-rewrite-go').textContent = 'Rewriting…';
  ($('skill-rewrite-go') as HTMLButtonElement).disabled = true;
  $('skills-status').textContent = 'Rewriting the draft…';
  send({ type: 'draft-skill', requestId: drafting, ...(focus ? { focus } : {}), previous });
}

/* Settings: the list, the form, export and import. */

async function renderSkills(): Promise<void> {
  const list = $('skills');
  const skills = await loadSkills(skillStore()).catch(() => []);
  list.textContent = '';
  if (skills.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty-row';
    empty.textContent = 'No skills yet.';
    list.append(empty);
  }
  for (const skill of skills) list.append(skillRow(skill));
  $<HTMLButtonElement>('skills-export').disabled = skills.length === 0;
}

function skillRow(skill: Skill): HTMLLIElement {
  const row = document.createElement('li');
  row.className = skill.enabled ? '' : 'off';
  const toggle = document.createElement('label');
  toggle.className = 'switch';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = skill.enabled;
  input.setAttribute('aria-label', `${skill.name} on`);
  input.onchange = async () => { await saveSkill(skillStore(), { ...skill, enabled: input.checked }); await renderSkills(); };
  const knob = document.createElement('span');
  toggle.append(input, knob);
  const name = document.createElement('div');
  name.className = 'name';
  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = skill.name;
  const sites = document.createElement('small');
  sites.textContent = skill.sites.length > 0 ? skill.sites.join(', ') : 'Every task';
  name.append(title, sites);
  const edit = iconButton(PENCIL, `Edit ${skill.name}`, () => openSkillForm(skill));
  const remove = iconButton(TRASH, `Remove ${skill.name}`, async () => { await removeSkill(skillStore(), skill.id); await renderSkills(); }, 'danger');
  row.append(toggle, name, edit, remove);
  return row;
}

const PENCIL = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.5 4.5l4 4L9 19H5v-4z" /></svg>';

/** The skill being edited in the form, or a new one (empty id). */
let editing: Skill | undefined;

function openSkillForm(skill?: Skill): void {
  if (!skill) fromDraft = false;
  editing = skill ?? { id: '', name: '', sites: [], text: '', enabled: true, updatedAt: 0 };
  $<HTMLInputElement>('skill-name').value = editing.name;
  $<HTMLInputElement>('skill-sites').value = editing.sites.join(', ');
  $<HTMLTextAreaElement>('skill-text').value = editing.text;
  $('skill-error').textContent = '';
  $('skill-form').hidden = false;
  $('skill-add').hidden = true;
  $('skill-add').setAttribute('aria-expanded', 'true');
  $('skill-save').textContent = editing.id ? 'Save changes' : 'Save';
  // Rewrite is for a draft from the conversation only; a skill typed by hand has nothing to go back to.
  $('skill-rewrite-row').hidden = !fromDraft || !!editing.id;
  $<HTMLInputElement>('skill-rewrite').value = '';
  countSkillChars();
  $('skill-name').focus();
}

function closeSkillForm(): void {
  editing = undefined;
  fromDraft = false;
  $('skill-form').hidden = true;
  $('skill-add').hidden = false;
  $('skill-add').setAttribute('aria-expanded', 'false');
}

function countSkillChars(): void {
  const length = $<HTMLTextAreaElement>('skill-text').value.length;
  $('skill-count').textContent = length.toLocaleString('en-US');
  $('skill-count').parentElement!.classList.toggle('error', length > MAX_SKILL_CHARS);
}

async function submitSkill(): Promise<void> {
  if (!editing) return;
  const error = $('skill-error');
  const parsed = parseSites($<HTMLInputElement>('skill-sites').value);
  if ('error' in parsed) { error.textContent = parsed.error; return; }
  const input = { name: $<HTMLInputElement>('skill-name').value.trim(), sites: parsed.sites, text: $<HTMLTextAreaElement>('skill-text').value };
  const skills = await loadSkills(skillStore()).catch(() => []);
  const refused = validateSkill(input, skills.length, editing.id || undefined);
  if (refused) { error.textContent = refused; return; }
  try {
    await saveSkill(skillStore(), { ...editing, ...input, id: editing.id || newSkillId(), updatedAt: Date.now() });
  } catch (caught) {
    error.textContent = `Could not save: ${caught instanceof Error ? caught.message : String(caught)}`;
    return;
  }
  closeSkillForm();
  $('skills-status').textContent = '';
  await renderSkills();
}

async function exportSkillsFile(): Promise<void> {
  const skills = await loadSkills(skillStore()).catch(() => []);
  const blob = new Blob([exportSkills(skills)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  download(url, `valet-skills-${new Date().toISOString().slice(0, 10)}.json`);
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function importSkillsFile(file: File): Promise<void> {
  const status = $('skills-status');
  const existing = await loadSkills(skillStore()).catch(() => []);
  const result = importSkills(await file.text(), existing);
  if ('error' in result) { status.textContent = result.error; return; }
  try {
    for (const skill of result.skills) if (!existing.some((known) => known === skill)) await saveSkill(skillStore(), skill);
  } catch (caught) {
    status.textContent = `Could not save: ${caught instanceof Error ? caught.message : String(caught)}`;
    return;
  }
  status.textContent = `Imported ${result.added} new, ${result.replaced} updated.`;
  await renderSkills();
}

/* ---- wiring ---- */

$('send').onclick = submit;
$('add').onclick = toggleAddMenu;
$('add-files').onclick = () => { closeAddMenu(); $<HTMLInputElement>('file-input').click(); };
$('add-screenshot').onclick = () => { closeAddMenu(); void pickToShare(); };
$<HTMLInputElement>('file-input').onchange = (event) => {
  const input = event.target as HTMLInputElement;
  void addFiles([...(input.files ?? [])]).then(() => { input.value = ''; });
};
$('mic').hidden = !dictation.supported();
$('mic').dataset['tip'] = dictation.describe();
// Whether recognition runs on this device is known only after a moment: say it when the owner points at it.
$('mic').addEventListener('mouseenter', () => { $('mic').dataset['tip'] = dictation.describe(); });
$('mic').onclick = toggleDictation;
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') { $('tab-menu').hidden = true; closeWhere(); closeModeMenu(); closeAddMenu(); closeSkillMenu(); closeMore(); $('goal').focus(); } });
document.addEventListener('click', (event) => {
  const target = event.target as Node;
  if (!$('tab-menu').contains(target) && !$('add-menu').contains(target)) $('tab-menu').hidden = true;
  if (!$('add-menu').contains(target) && !$('add').contains(target)) closeAddMenu();
  if (!$('where-menu').contains(target) && !$('where').contains(target)) closeWhere();
  if (!$('mode-menu').contains(target) && !$('mode').contains(target)) closeModeMenu();
  if (!$('skill-menu').contains(target)) closeSkillMenu();
  if (!$('more-menu').contains(target) && !$('more').contains(target)) closeMore();
});
$('more').onclick = toggleMore;
$('menu-save-skill').onclick = () => { closeMore(); saveSkillFromMenu(); };
$('copy-conversation').onclick = () => { closeMore(); void copyConversation(); };
$('save-conversation').onclick = () => { closeMore(); void saveConversation(); };
$('save-trace').onclick = () => { closeMore(); saveTrace(); };
$('goal').addEventListener('input', (event) => {
  // An @ at the start or after a space brings up the skills.
  const goal = event.target as HTMLTextAreaElement;
  if ((event as InputEvent).data === '@' && /(^|\s)@$/.test(goal.value.slice(0, goal.selectionStart))) void openSkillMenu();
});
$('skill-add').onclick = () => openSkillForm();
$('skill-cancel').onclick = closeSkillForm;
$('skill-rewrite-go').onclick = rewriteDraft;
$('skill-rewrite').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); rewriteDraft(); } });
$<HTMLFormElement>('skill-form').onsubmit = (event) => { event.preventDefault(); void submitSkill(); };
$('skill-text').addEventListener('input', countSkillChars);
$('skills-export').onclick = () => { void exportSkillsFile(); };
$('skills-import').onclick = () => $<HTMLInputElement>('skills-file').click();
$<HTMLInputElement>('skills-file').onchange = (event) => {
  const input = event.target as HTMLInputElement;
  const [file] = input.files ?? [];
  if (file) void importSkillsFile(file).then(() => { input.value = ''; });
};
$('goal').addEventListener('paste', (event) => {
  const files = [...(event.clipboardData?.files ?? [])];
  if (files.length > 0) { event.preventDefault(); void addFiles(files); }
});
const box = $('box');
document.body.addEventListener('dragover', (event) => { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); box.classList.add('dropping'); } });
document.body.addEventListener('dragleave', (event) => { if (event.target === document.body || !event.relatedTarget) box.classList.remove('dropping'); });
document.body.addEventListener('drop', (event) => {
  box.classList.remove('dropping');
  if (!event.dataTransfer?.files.length) return;
  event.preventDefault();
  void addFiles([...event.dataTransfer.files]);
});
$('goal').addEventListener('input', grow);
// What is typed survives the panel closing or reloading: kept with the conversation (session storage) until it is sent.
const DRAFT_KEY = `agent:draft:${ownTabId === undefined ? 'main' : conversationForTab(ownTabId)}`;
let draftTimer: ReturnType<typeof setTimeout> | undefined;
$('goal').addEventListener('input', () => {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => { void chrome.storage.session.set({ [DRAFT_KEY]: $<HTMLTextAreaElement>('goal').value }); }, 150);
});
void chrome.storage.session.get(DRAFT_KEY).then((stored) => {
  const draft = stored[DRAFT_KEY];
  const goal = $<HTMLTextAreaElement>('goal');
  if (typeof draft === 'string' && draft && !goal.value) { goal.value = draft; grow(); }
});
$('goal').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submit(); }
});
$('stop').onclick = () => send({ type: 'stop' });
$('step-next').onclick = () => send({ type: 'step' });
$('learn').onclick = () => send({ type: 'set-learning', on: state?.learning !== true });
$('ask-other').onclick = () => showOwnAnswer(true);
$('ask-stop').onclick = () => send({ type: 'stop' });
$('ask-own').addEventListener('submit', (event) => { event.preventDefault(); sendOwnAnswer(); });
$('ask-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); sendOwnAnswer(); }
  if (event.key === 'Escape') { showOwnAnswer(false); $('ask-other').focus(); }
});
$('resume').onclick = () => send({ type: 'resume' });
// A new conversation: back in the chat, cursor in the message box, ready to type.
$('new-conversation').onclick = () => {
  if (!$('settings-view').hidden) showSettings(false);
  send({ type: 'new-conversation' });
  $('goal').focus();
};
$('lightbox-close').onclick = () => $<HTMLDialogElement>('lightbox').close();
$('lightbox').addEventListener('click', (event) => { if (event.target === event.currentTarget) $<HTMLDialogElement>('lightbox').close(); });
$('where').onclick = toggleWhere;
$('where-continue').onclick = () => chooseWhere('continue');
$('where-here').onclick = () => chooseWhere('this');
$('where-new').onclick = () => chooseWhere('new');
$('open-settings').onclick = () => showSettings(true);
$('model').onclick = () => showSettings(true);
$('close-settings').onclick = () => showSettings(false);
$('mode').onclick = toggleModeMenu;
$('mode-ask').onclick = () => chooseMode('ask');
$('mode-auto').onclick = () => chooseMode('auto');
chrome.tabs.onActivated.addListener(() => { if (ownTabId === undefined) void refreshTab(); });
chrome.tabs.onUpdated.addListener((id, change) => {
  if ((ownTabId === undefined || id === ownTabId) && (change.title || change.url || change.status === 'complete')) void refreshTab();
});

$('build').textContent = `Build ${typeof __BUILD__ === 'string' ? __BUILD__ : 'dev'}`;
// npm run dev: reload the panel when only panel files changed (no-op in normal builds).
devReload('panel', () => location.reload());
connect();
void refreshTab();
