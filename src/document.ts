/*
 * document.html: a Markdown file from the conversation, laid out as a page.
 * The worker opens it to print a PDF (pdf.ts); it reads the file from session
 * storage by id, renders it with the panel's own Markdown renderer (no
 * innerHTML, ever: the text is model output) and then marks the page ready,
 * or gone when nothing is stored under that id.
 */

import { MEDIA_PREFIX, type Media } from './loop/protocol.js';
import { renderMarkdown } from './markdown.js';
import { STATE_ATTRIBUTE } from './pdf.js';

declare const chrome: { storage: { session: { get(key: string): Promise<Record<string, unknown>> } } };

const id = new URLSearchParams(location.search).get('id') ?? '';
const stored = (await chrome.storage.session.get(`${MEDIA_PREFIX}${id}`))[`${MEDIA_PREFIX}${id}`] as Media | undefined;
if (stored?.kind !== 'file') {
  document.getElementById('gone')!.hidden = false;
  document.documentElement.setAttribute(STATE_ATTRIBUTE, 'gone');
} else {
  document.title = stored.name.replace(/\.[^.]+$/, '') || 'Document';
  document.getElementById('document')!.replaceChildren(renderMarkdown(document, stored.content, { headings: ['h1', 'h2', 'h3'] }));
  await document.fonts.ready;
  document.documentElement.setAttribute(STATE_ATTRIBUTE, 'ready');
}
