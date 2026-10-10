/*
 * What a document says about itself: its title, subtitle and sources, read
 * from a short header block the model may put at the top of the Markdown of a
 * PDF (save_file), and the body without it.
 *
 *   ---
 *   title: Apollo 11
 *   subtitle: The mission in eight points
 *   sources:
 *     - Wikipedia, "Apollo 11" — https://en.wikipedia.org/wiki/Apollo_11
 *   ---
 *
 * Without the block, a leading `# Heading` is the title, else the file name.
 * Everything here is model text: it is returned as strings, and the page puts
 * it in the document as text, never as markup.
 */

export interface DocumentParts {
  title: string;
  subtitle?: string;
  sources: string[];
  body: string;
}

const HEADER = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const MAX_FIELD = 300;
const MAX_SOURCES = 30;

function unquote(value: string): string {
  const trimmed = value.trim();
  return /^(["']).*\1$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
}

/** The title, subtitle and sources of a document, and its body. `fallback` names it when nothing else does. */
export function documentParts(markdown: string, fallback: string): DocumentParts {
  let body = markdown;
  let title = '';
  let subtitle = '';
  const sources: string[] = [];
  const header = HEADER.exec(markdown);
  if (header) {
    body = markdown.slice(header[0].length);
    let list: string[] | null = null;
    for (const line of header[1]!.split(/\r?\n/)) {
      const item = /^\s*-\s+(.+)$/.exec(line);
      if (item && list) { list.push(unquote(item[1]!).slice(0, MAX_FIELD)); continue; }
      const field = /^([A-Za-z]+)\s*:\s*(.*)$/.exec(line);
      if (!field) continue;
      const key = field[1]!.toLowerCase();
      const value = unquote(field[2]!).slice(0, MAX_FIELD);
      list = null;
      if (key === 'title') title = value;
      else if (key === 'subtitle') subtitle = value;
      else if (key === 'sources' || key === 'source') {
        if (value) sources.push(value);
        list = sources;
      }
    }
  }
  if (!title) {
    // A leading level-one heading names the document; it is not repeated in the body.
    const heading = /^\s*#[ \t]+(.+?)[ \t#]*(?:\r?\n|$)/.exec(body);
    if (heading) { title = heading[1]!.trim().slice(0, MAX_FIELD); body = body.slice(heading[0].length); }
  }
  return {
    title: title || fallback,
    ...(subtitle ? { subtitle } : {}),
    sources: sources.filter(Boolean).slice(0, MAX_SOURCES),
    body: body.replace(/^\s*\n/, ''),
  };
}

/** A source line split into its words and its web address, if it has one (only http and https). */
export function sourceLink(source: string): { text: string; url?: string } {
  const match = /https?:\/\/[^\s<>"')\]]+/i.exec(source);
  if (!match) return { text: source };
  const url = match[0].replace(/[.,;:]+$/, '');
  const text = source.slice(0, match.index).replace(/[\s—–:-]+$/, '').trim();
  return { text, url };
}

/** Letter in the countries that use it, A4 everywhere else. */
export function paperFor(locale: string): 'letter' | 'A4' {
  const region = (locale.split(/[-_]/)[1] ?? '').toUpperCase();
  return ['US', 'CA', 'MX', 'PH', 'CL', 'CO', 'VE', 'GT', 'CR', 'PR'].includes(region) ? 'letter' : 'A4';
}
