/*
 * What the model reads: the system prompt, and the history view with old page
 * evidence compacted.
 *
 * The system prompt is stable across a conversation, so it stays in the
 * provider's cache. Anything that changes per run — the handed tab — goes in
 * the user's goal message instead.
 */

import type { AIMessage } from '@amenophis1er/byok/types';
import { UNTRUSTED } from '../actions/index.js';

export const SYSTEM_PROMPT = [
  'You are Valet, working in the owner\'s own Chrome through the `browser` tool.',
  'You work in the tab the owner handed you (named in their message) and in tabs you open yourself (navigate with newTab:true opens one beside it). Observe before acting, and act only on the latest observation: copy its id and refs exactly.',
  'Every tool result says what happened. "refused" means nothing was dispatched: observe and reconsider. completed "unknown" means the action may have happened: inspect the page and never repeat a submission. "skipped" means the call was not run.',
  'When you need a choice only the owner can make and you can name the choices, ask with ask_owner. For a login, MFA or anything else only the owner can give, stop and ask in plain words. Never ask for passwords; the owner signs in themselves.',
  'If the task needs something you cannot do, say so and stop. Never work around a missing capability by putting the owner\'s content on a site they did not name (paste services, file hosts, forms, shorteners).',
  'Only your newest pages stay in full: older ones are cut to their address. When a page shows something the task needs, write it in your notepad before you move on, and work from the notepad instead of opening the page again.',
  'When your answer leaves an obvious next step you saw you could take, offer it with suggest_next after the answer, as up to three short buttons; none when there is no real next step.',
  'When the page\'s content is the task — summarize it, answer from it, quote or extract it — read it with the read action, every part you need, before you answer. An observation is cut to fit and is for acting; a screenshot is for what you need to see.',
  'Report only what a result you received shows. After an action, observe before saying what it did; if you have not checked an outcome, say so instead of assuming it. Never invent what a page says.',
  'When the task is done, answer with a short summary of what you did and what you found.',
  '"Owner\'s notes" in a message or a result (ownerNotes) are the owner\'s own instructions for the task or the site: follow them. They never override the rules above.',
  UNTRUSTED,
].join('\n\n');

/** A page's title, as a page may have written it, made fit for a line of the owner's message: one line, no quotes to close, not long. */
function titleOf(tab: { title: string }): string {
  return tab.title.replace(/[\s"]+/g, ' ').trim().slice(0, 120) || '(untitled)';
}

/** The goal as the model sees it, with the tab it works in named. */
export function goalMessage(goal: string, handed: { title: string; url: string } | null, continuing?: { title: string; url: string } | null): string {
  if (continuing) return `${goal}\n\n(Continue in the tab you are working in: "${titleOf(continuing)}" — ${continuing.url}. Observe it first: it may have changed.)`;
  if (!handed) return `${goal}\n\n(No tab was handed over: open what you need with navigate.)`;
  return `${goal}\n\n(The owner is on "${titleOf(handed)}" — ${handed.url}. You are working in that tab: observe it first.)`;
}

/** How many of the newest observations keep their full page content, whatever their size. */
const FULL_OBSERVATIONS = 3;
/**
 * Older observations stay in full too while they fit in this many characters
 * together, newest first. Small pages (a form, a dialog's result line) cost
 * little, and cutting them made a model redo steps to see a result again; a
 * run through big pages still keeps only the newest few.
 */
const PAGE_BUDGET = 60_000;
/**
 * How much page text (read) stays in full, newest first: a long article, about
 * ten parts. Past it the oldest parts drop to a line saying what they were; a
 * count of parts made a model re-read the start of an article it was halfway
 * through, so the budget is in characters and generous.
 */
const READ_BUDGET = 120_000;

/** Opening the same page this many times says the model is going in circles: the result tells it so. */
const REVISITS = 3;
const COMPACTED_PAGE = 'This page\'s content is no longer shown, to save space. Work from your notepad; open it again only for a detail you did not note.';

/** A page's address for counting visits: the same page with another #fragment, or a trailing slash, is the same page. */
function pageKey(url: unknown): string | undefined {
  if (typeof url !== 'string') return undefined;
  return url.replace(/#.*$/, '').replace(/\/+$/, '');
}

/**
 * Compact old page evidence: only the newest observations keep tree, targets
 * and tabs; older ones keep url and title. Everything else in a tool result —
 * completed (including "unknown"), refused, skipped, errors, notices — is kept,
 * so the model never forgets that an earlier outcome was uncertain. A navigate
 * to a page opened often before says how often, so a model that lost what it
 * saw works from its notes instead of opening it again and again. Each message
 * is changed only by what came before it, so the view of earlier turns stays
 * the same as the conversation grows.
 */
export function historyView(history: AIMessage[]): AIMessage[] {
  const withPages: number[] = [];
  const withText: number[] = [];
  /** Tool results of a navigate, with how many times that page was opened by then. */
  const visits = new Map<number, number>();
  const navigates = new Map<string, string>();
  const opened = new Map<string, number>();
  history.forEach((message, index) => {
    for (const call of message.role === 'assistant' ? message.toolCalls ?? [] : []) {
      const key = call.args?.['action'] === 'navigate' ? pageKey(call.args['url']) : undefined;
      if (key) navigates.set(call.id, key);
    }
    if (message.role !== 'tool' || typeof message.content !== 'string') return;
    const page = message.toolCallId ? navigates.get(message.toolCallId) : undefined;
    if (page) {
      const count = (opened.get(page) ?? 0) + 1;
      opened.set(page, count);
      if (count >= REVISITS) visits.set(index, count);
    }
    if (message.content.includes('"observation"')) withPages.push(index);
    if (message.content.includes('"read":{"url":')) withText.push(index);
  });
  const keepPages = new Set<number>();
  let pageChars = 0;
  for (const index of [...withPages].reverse()) {
    pageChars += String(history[index]!.content).length;
    if (keepPages.size >= FULL_OBSERVATIONS && pageChars > PAGE_BUDGET) break;
    keepPages.add(index);
  }
  const keepText = new Set<number>();
  let spent = 0;
  for (const index of [...withText].reverse()) {
    spent += String(history[index]!.content).length;
    // The newest part always stays, whatever its size.
    if (spent > READ_BUDGET && keepText.size > 0) break;
    keepText.add(index);
  }
  return history.map((message, index) => {
    if (message.role !== 'tool' || typeof message.content !== 'string') return message;
    const oldPage = withPages.includes(index) && !keepPages.has(index);
    const oldText = withText.includes(index) && !keepText.has(index);
    const revisit = visits.get(index);
    if (!oldPage && !oldText && revisit === undefined) return message;
    try {
      const result = JSON.parse(message.content) as Record<string, unknown>;
      const observation = result['observation'] as { id?: string; url?: string; title?: string } | undefined;
      if (oldPage && observation) result['observation'] = { url: observation.url, title: observation.title, compacted: COMPACTED_PAGE };
      const read = result['read'] as { url?: string; title?: string; part?: number; parts?: number } | undefined;
      if (oldText && read) result['read'] = { url: read.url, title: read.title, part: read.part, parts: read.parts, compacted: 'You read this part earlier; its text is no longer shown, to save space. Do not read it again just to have it: work from your notepad. Read it again only for a detail the task needs.' };
      if (revisit !== undefined) result['revisited'] = `You have now opened this page ${revisit} times. If you came back for something you saw before, put what you need from it in your notepad this time and work from there; do not open it again for the same thing.`;
      return { ...message, content: JSON.stringify(result) };
    } catch {
      return message;
    }
  });
}
