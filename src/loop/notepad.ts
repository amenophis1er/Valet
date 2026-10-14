/*
 * The `notepad` tool: the agent's own notes for one conversation.
 *
 * Only the newest pages stay in full in what the model reads (prompt.ts), so
 * a task that gathers from many pages loses what it saw unless it writes it
 * down. The notepad is where: the model appends a line or rewrites the whole
 * note, and the current note is shown to it once, at the end of what it reads
 * each turn, so it always works from the latest version and the history
 * before it stays the same from turn to turn.
 *
 * It is part of the conversation's state (chrome.storage.session): it goes
 * with the conversation, and the owner can read it in the panel. It is the
 * model's words, often taken from pages: text to show, never instructions to
 * the extension.
 */

import type { AIMessage } from '@amenophis1er/byok/types';
import { z } from 'zod';

/** Room for what a task gathers from a few dozen pages, not a copy of them. */
export const MAX_NOTEPAD_CHARS = 8_000;
/** How much of a note a step row in the panel shows. */
const STEP_CHARS = 90;

export const NOTEPAD_TOOL = {
  name: 'notepad',
  description: [
    'Your notes for this conversation. Only your newest pages stay in full: older ones are cut to their address, and what you saw on them is gone unless you wrote it down here.',
    'When a page shows something the task needs (a price, a name, a date, a count), append it with the page it came from before you move on. Work from your notes instead of opening a page again.',
    'Use append for a new line; use replace to rewrite the whole note, to tidy it or drop what is no longer needed.',
    `The note holds ${MAX_NOTEPAD_CHARS} characters. Its current text is shown to you at the end of each turn. The owner can read it.`,
  ].join(' '),
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      append: { type: 'string', minLength: 1, maxLength: MAX_NOTEPAD_CHARS, description: 'Text to add as a new line at the end.' },
      replace: { type: 'string', maxLength: MAX_NOTEPAD_CHARS, description: 'The whole new note; an empty string clears it.' },
    },
  },
} as const;

const input = z.union([
  z.object({ append: z.string().trim().min(1) }).strict(),
  z.object({ replace: z.string() }).strict(),
]);

/** A note written, or why not: the new text, what the model reads back, and the step the owner sees. */
export type Written = { notepad: string; result: Record<string, unknown>; step: string } | { error: string };

/** Apply one notepad call to the current note. */
export function writeNote(current: string, args: unknown): Written {
  const parsed = input.safeParse(args);
  if (!parsed.success) return { error: 'Invalid notepad call: send {"append":"…"} to add a line, or {"replace":"…"} to rewrite the whole note.' };
  const call = parsed.data;
  const next = 'append' in call ? (current ? `${current}\n${call.append}` : call.append) : call.replace.trim();
  if (next.length > MAX_NOTEPAD_CHARS) {
    return { error: `The notepad holds ${MAX_NOTEPAD_CHARS} characters and this would make ${next.length}. Rewrite it shorter with replace: keep what the task still needs.` };
  }
  const written = 'append' in call ? call.append : next;
  const step = 'replace' in call && !next ? 'Cleared its notes' : `Noted: ${oneLine(written)}`;
  return { notepad: next, result: { saved: true, chars: next.length, of: MAX_NOTEPAD_CHARS }, step };
}

function oneLine(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > STEP_CHARS ? `${line.slice(0, STEP_CHARS - 1)}…` : line;
}

/**
 * The messages with the current note shown at the end of the newest one: a
 * tool result gets it as a field, an owner's message as a closing paragraph.
 * Only the last message changes, so everything before it reads the same as
 * the turn before.
 */
export function withNotepad(messages: AIMessage[], notepad: string | undefined): AIMessage[] {
  const last = messages.at(-1);
  if (!notepad || !last) return messages;
  const shown = `Your notepad (${notepad.length} of ${MAX_NOTEPAD_CHARS} characters):\n${notepad}`;
  let changed: AIMessage | undefined;
  if (last.role === 'tool' && typeof last.content === 'string') {
    try {
      const result = JSON.parse(last.content) as Record<string, unknown>;
      changed = { ...last, content: JSON.stringify({ ...result, notepad: shown }) };
    } catch {
      changed = { ...last, content: `${last.content}\n\n${shown}` };
    }
  } else if (last.role === 'tool' && Array.isArray(last.content)) {
    changed = { ...last, content: [...last.content, { type: 'text', text: shown }] };
  } else if (last.role === 'user') {
    changed = typeof last.content === 'string'
      ? { ...last, content: `${last.content}\n\n${shown}` }
      : { ...last, content: [...last.content, { type: 'text', text: shown }] };
  }
  return changed ? [...messages.slice(0, -1), changed] : messages;
}
