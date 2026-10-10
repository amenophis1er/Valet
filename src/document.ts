/*
 * document.html: a Markdown file from the conversation, laid out as a page.
 * The worker opens it to print a PDF (pdf.ts); it reads the file from session
 * storage by id, lays it out — a title block (from the file's header block,
 * see document-meta.ts), the body through the panel's own Markdown renderer,
 * and its sources — and then marks the page ready, or gone when nothing is
 * stored under that id. No innerHTML, ever: the text is model output.
 */

import { documentParts, paperFor, sourceLink } from './document-meta.js';
import { MEDIA_PREFIX, type Media } from './loop/protocol.js';
import { renderMarkdown } from './markdown.js';
import { STATE_ATTRIBUTE } from './pdf.js';

declare const chrome: { storage: { session: { get(key: string): Promise<Record<string, unknown>> } } };

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function sourcesSection(sources: string[]): HTMLElement {
  const section = element('section', 'sources');
  section.append(element('h2', '', sources.length === 1 ? 'Source' : 'Sources'));
  const list = element('ol', '');
  for (const source of sources) {
    const item = element('li', '');
    const { text, url } = sourceLink(source);
    if (text) item.append(document.createTextNode(url ? `${text} — ` : text));
    if (url) {
      const link = element('a', '', url);
      link.href = url;
      item.append(link);
    }
    list.append(item);
  }
  section.append(list);
  return section;
}

const id = new URLSearchParams(location.search).get('id') ?? '';
const stored = (await chrome.storage.session.get(`${MEDIA_PREFIX}${id}`))[`${MEDIA_PREFIX}${id}`] as Media | undefined;
if (stored?.kind !== 'file') {
  document.getElementById('gone')!.hidden = false;
  document.documentElement.setAttribute(STATE_ATTRIBUTE, 'gone');
} else {
  const locale = navigator.language || 'en-US';
  const parts = documentParts(stored.content, stored.name.replace(/\.[^.]+$/, '') || 'Document');
  // Chrome prints the title in the footer of every page.
  document.title = parts.title;
  document.documentElement.lang = locale;
  const paper = element('style', '');
  paper.textContent = `@page { size: ${paperFor(locale)}; }`;
  document.head.append(paper);

  const header = element('header', 'title-block');
  header.append(
    element('p', 'eyebrow', new Date().toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric' })),
    element('h1', '', parts.title),
  );
  if (parts.subtitle) header.append(element('p', 'subtitle', parts.subtitle));
  const article = element('article', '');
  // The title block is the only h1: the body's headings start at h2.
  article.append(renderMarkdown(document, parts.body, { headings: ['h2', 'h2', 'h3'] }));
  const page = document.getElementById('document')!;
  page.replaceChildren(header, article, ...(parts.sources.length > 0 ? [sourcesSection(parts.sources)] : []));
  await document.fonts.ready;
  document.documentElement.setAttribute(STATE_ATTRIBUTE, 'ready');
}
