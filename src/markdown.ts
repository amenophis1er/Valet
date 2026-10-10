/*
 * A small Markdown renderer for the agent's answers in the side panel.
 *
 * The answer is model output, and the model reads untrusted pages, so nothing
 * here ever goes through innerHTML: every node is built with createElement and
 * every piece of text with a Text node. Supported: paragraphs, `#`–`###`
 * headings, `-`/`*`/`1.` lists, tables, fenced code, `>` quotes, `---` rules,
 * **bold**, *italic*, `code`, and links — only http(s), opened in a new tab,
 * with the URL shown on hover. An image is never fetched by the renderer: it
 * becomes a link to the image, or whatever the `image` option makes of it
 * (the panel shows a button that loads it on a click), so model text cannot
 * make the panel send a request anywhere by itself.
 */

type Inline = Node;

const INLINE = /(\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*|`([^`]+)`|!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))/;

/** What an image becomes; the default is a link to it. */
export type ImageRenderer = (doc: Document, alt: string, src: string) => Node;

const imageLink: ImageRenderer = (doc, alt, src) => {
  const el = doc.createElement('a');
  el.href = src;
  el.title = src;
  el.target = '_blank';
  el.rel = 'noopener noreferrer';
  el.textContent = alt ? `Image: ${alt}` : 'Image';
  return el;
};

function inlineWith(doc: Document, text: string, image: ImageRenderer = imageLink): Inline[] {
  const out: Inline[] = [];
  let rest = text;
  for (;;) {
    const match = INLINE.exec(rest);
    if (!match) { if (rest) out.push(doc.createTextNode(rest)); return out; }
    if (match.index > 0) out.push(doc.createTextNode(rest.slice(0, match.index)));
    const [whole, , bold, italic, code, alt, src, label, href] = match;
    if (bold !== undefined) { const el = doc.createElement('strong'); el.append(...inlineWith(doc, bold, image)); out.push(el); }
    else if (italic !== undefined) { const el = doc.createElement('em'); el.append(...inlineWith(doc, italic, image)); out.push(el); }
    else if (code !== undefined) { const el = doc.createElement('code'); el.textContent = code; out.push(el); }
    else if (alt !== undefined && src !== undefined) out.push(image(doc, alt.trim(), src));
    else if (label !== undefined && href !== undefined) {
      const el = doc.createElement('a');
      // Only web links; anything else the model wrote stays text.
      if (!/^https?:/i.test(href)) { out.push(doc.createTextNode(label)); continue; }
      el.href = href;
      el.title = href;
      el.target = '_blank';
      el.rel = 'noopener noreferrer';
      el.textContent = label;
      out.push(el);
    }
    rest = rest.slice(match.index + whole!.length);
  }
}

const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/** The cells of a table row: split on `|` outside code spans, `\|` kept as a pipe. */
function cells(line: string): string[] {
  const out: string[] = [];
  let cell = '';
  let code = false;
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i]!;
    if (char === '\\' && body[i + 1] === '|') { cell += '|'; i += 1; continue; }
    if (char === '`') code = !code;
    if (char === '|' && !code) { out.push(cell.trim()); cell = ''; continue; }
    cell += char;
  }
  out.push(cell.trim());
  return out;
}

function table(doc: Document, header: string, rule: string, rows: string[], image: ImageRenderer): HTMLElement {
  const align = cells(rule).map((cell) => (cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : ''));
  const wrap = doc.createElement('div');
  wrap.className = 'table-wrap';
  const el = doc.createElement('table');
  const row = (line: string, tag: 'th' | 'td') => {
    const tr = doc.createElement('tr');
    cells(line).forEach((text, i) => {
      const cell = doc.createElement(tag);
      if (align[i]) cell.style.textAlign = align[i]!;
      cell.append(...inlineWith(doc, text, image));
      tr.append(cell);
    });
    return tr;
  };
  const head = doc.createElement('thead');
  head.append(row(header, 'th'));
  const body = doc.createElement('tbody');
  for (const line of rows) body.append(row(line, 'td'));
  el.append(head, body);
  wrap.append(el);
  return wrap;
}

/** Which elements `#`, `##` and `###` become: small ones in the panel, a document's own in document.html. */
export interface MarkdownOptions {
  headings?: [string, string, string];
  /** What `![alt](https://…)` becomes; a link to the image unless the host says otherwise. */
  image?: ImageRenderer;
}

export function renderMarkdown(doc: Document, text: string, options: MarkdownOptions = {}): DocumentFragment {
  const headings = options.headings ?? ['h3', 'h4', 'h4'];
  const image = options.image ?? imageLink;
  const inline = (d: Document, t: string) => inlineWith(d, t, image);
  const fragment = doc.createDocumentFragment();
  let list: HTMLElement | null = null;
  let paragraph: string[] = [];
  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const p = doc.createElement('p');
    paragraph.forEach((line, i) => { if (i > 0) p.append(doc.createElement('br')); p.append(...inline(doc, line)); });
    fragment.append(p);
    paragraph = [];
  };
  const closeList = () => { list = null; };

  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trimEnd();
    // Fenced code: everything up to the closing fence, verbatim.
    if (/^\s*```/.test(line)) {
      flushParagraph(); closeList();
      const code: string[] = [];
      for (index += 1; index < lines.length && !/^\s*```/.test(lines[index]!); index += 1) code.push(lines[index]!);
      const pre = doc.createElement('pre');
      const el = doc.createElement('code');
      el.textContent = code.join('\n');
      pre.append(el);
      fragment.append(pre);
      continue;
    }
    // A table: a row of cells, then a rule of dashes, then its rows.
    if (line.includes('|') && TABLE_RULE.test(lines[index + 1] ?? '') && !TABLE_RULE.test(line) && cells(lines[index + 1]!).length === cells(line).length) {
      flushParagraph(); closeList();
      const rule = lines[index + 1]!;
      const rows: string[] = [];
      for (index += 2; index < lines.length && lines[index]!.includes('|') && lines[index]!.trim(); index += 1) rows.push(lines[index]!);
      index -= 1;
      fragment.append(table(doc, line, rule, rows, image));
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (!line.trim()) { flushParagraph(); closeList(); continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushParagraph(); closeList();
      fragment.append(doc.createElement('hr'));
      continue;
    }
    if (heading) {
      flushParagraph(); closeList();
      const el = doc.createElement(headings[heading[1]!.length - 1] ?? headings[2]);
      el.append(...inline(doc, heading[2]!));
      fragment.append(el);
      continue;
    }
    if (quote) {
      flushParagraph(); closeList();
      const last = fragment.lastChild as HTMLElement | null;
      const el = last?.nodeName === 'BLOCKQUOTE' ? last : fragment.appendChild(doc.createElement('blockquote'));
      if (el.childNodes.length > 0) el.append(doc.createElement('br'));
      el.append(...inline(doc, quote[1]!));
      continue;
    }
    if (bullet || numbered) {
      flushParagraph();
      const tag = bullet ? 'ul' : 'ol';
      if (!list || list.tagName.toLowerCase() !== tag) { list = doc.createElement(tag); fragment.append(list); }
      const item = doc.createElement('li');
      item.append(...inline(doc, (bullet ?? numbered)![1]!));
      list.append(item);
      continue;
    }
    closeList();
    paragraph.push(line);
  }
  flushParagraph();
  return fragment;
}
