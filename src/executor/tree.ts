/*
 * The observation, built from a live document.
 *
 * A frame-by-frame aria-style snapshot plus a list of interactive targets with
 * refs: a YAML-ish indented tree, capped at 240 targets. An agent is told to
 * copy a ref out of `observation.targets`.
 *
 * Form controls also show their state — value,
 * special input type, checked, selected option — so the agent can verify what
 * it filled. A password's value is never read.
 *
 * Refs here are local to one frame (`l1`, `l2`, …). The service worker
 * renumbers them to `e1…` across frames, in frame order, so that a page with
 * iframes still hands the model one flat numbering.
 */

export interface CollectedElement {
  id: string;
  role: string;
  name: string;
  href?: string;
  bounds?: { x: number; y: number; width: number; height: number };
}

export interface Collected {
  url: string;
  title: string;
  tree: string;
  elements: CollectedElement[];
  scroll: { x: number; y: number };
}

const INTERACTIVE = 'a[href],button,input,select,textarea,[role="button"],[role="link"],[role="checkbox"],[role="tab"],[contenteditable="true"]';
/** The driver stops at 240 targets; more than that is noise the model cannot spend anyway. */
export const MAX_TARGETS = 240;
const MAX_TREE = 20_000;

const TAG_ROLES: Record<string, string> = {
  a: 'link', button: 'button', select: 'combobox', textarea: 'textbox',
  h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading',
  nav: 'navigation', main: 'main', header: 'banner', footer: 'contentinfo', aside: 'complementary',
  form: 'form', table: 'table', ul: 'list', ol: 'list', li: 'listitem', img: 'img',
};

function textOf(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

/** `textContent` includes the source of every script and stylesheet inside; a name never does. */
function visibleText(el: Element): string {
  let text = '';
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === 3) { text += node.nodeValue ?? ''; continue; }
    if (node.nodeType !== 1) continue;
    const child = node as Element;
    if (['script', 'style', 'noscript', 'template'].includes(child.tagName.toLowerCase())) continue;
    text += visibleText(child);
  }
  return text;
}

/** The same order of preference as driver.ts: aria-label, labelledby, labels, placeholder, value, text, title. */
export function accessibleName(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const type = el.getAttribute('type')?.toLowerCase() ?? '';
  const labelled = el.getAttribute('aria-labelledby')?.split(/\s+/)
    .map((id) => el.ownerDocument.getElementById(id)?.textContent ?? '').join(' ');
  const labels = 'labels' in el ? Array.from((el as HTMLInputElement).labels ?? []).map((label) => label.textContent).join(' ') : '';
  const raw = el.getAttribute('aria-label') || labelled || labels || el.getAttribute('placeholder') ||
    (tag === 'input' && ['submit', 'button'].includes(type) ? el.getAttribute('value') : '') ||
    (tag === 'input' || tag === 'textarea' || tag === 'select' ? '' : visibleText(el)) ||
    el.getAttribute('alt') || el.getAttribute('title') || '';
  return textOf(raw).slice(0, 300);
}

export function roleOf(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const type = el.getAttribute('type')?.toLowerCase() ?? '';
  if (el.getAttribute('role')) return el.getAttribute('role')!;
  if (tag === 'input') return ['checkbox', 'radio'].includes(type) ? type : 'textbox';
  return TAG_ROLES[tag] ?? tag;
}

/*
 * Whether the engine lays the document out at all.
 *
 * Chrome measures, so an element with no client rects is genuinely invisible
 * and the driver skips it. jsdom measures nothing: every rect is empty, and
 * requiring one there would make this builder return an empty tree in its own
 * tests. So the rect test only applies where rects mean something.
 */
function laysOut(doc: Document): boolean {
  return typeof doc.body?.getClientRects === 'function' && doc.body.getClientRects().length > 0;
}

function visible(el: Element, measured: boolean): boolean {
  if (!el.isConnected) return false;
  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  if (style && (style.visibility === 'hidden' || style.display === 'none')) return false;
  if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return false;
  if (!measured) return true;
  return el.getClientRects().length > 0;
}

function disabled(el: Element): boolean {
  return el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true';
}

function bounds(el: Element, view: Window & typeof globalThis): CollectedElement['bounds'] {
  const rect = el.getBoundingClientRect();
  if (!rect || (rect.width === 0 && rect.height === 0)) return undefined;
  return {
    x: Math.round(rect.left + (view.scrollX || 0)), y: Math.round(rect.top + (view.scrollY || 0)),
    width: Math.round(rect.width), height: Math.round(rect.height),
  };
}

const NAMED_ROLES = ['link', 'button', 'textbox', 'checkbox', 'radio', 'combobox', 'tab', 'heading', 'img', 'option', 'listitem'];

/** Input types whose value a person picks rather than types; worth naming in the tree. */
const SPECIAL_TYPES = new Set(['time', 'date', 'datetime-local', 'month', 'week', 'color', 'range', 'number', 'email', 'tel', 'url', 'search', 'file']);
/** A name or value as the tree quotes it: one line, no double quotes, and never a `[ref=` of its own — page text must not read as a target line. */
const quote = (text: string) => text.replace(/\s+/g, ' ').replace(/"/g, "'").replace(/\[ref=/gi, '[ref ').slice(0, 100);

/** A form control's current state, as tree annotations. Never a password's value. */
function state(el: Element): string {
  const tag = el.tagName.toLowerCase();
  if (tag === 'select') {
    const chosen = Array.from((el as HTMLSelectElement).selectedOptions ?? []).map((option) => quote(option.label || option.text));
    return chosen.length ? ` [selected="${chosen.join(', ')}"]` : '';
  }
  if (tag === 'textarea') {
    const value = (el as HTMLTextAreaElement).value;
    return value ? ` [value="${quote(value)}"]` : '';
  }
  if (tag !== 'input') return '';
  const input = el as HTMLInputElement;
  const type = (input.type || 'text').toLowerCase();
  if (type === 'password') return ' [password]';
  if (type === 'checkbox' || type === 'radio') return input.checked ? ' [checked]' : '';
  if (['submit', 'button', 'reset', 'image', 'hidden'].includes(type)) return '';
  const kind = SPECIAL_TYPES.has(type) ? ` [type=${type}]` : '';
  const value = type === 'file' ? '' : input.value;
  return `${kind}${value ? ` [value="${quote(value)}"]` : ''}`;
}

/** The line a node contributes to the tree, or null when it says nothing. */
function line(el: Element, role: string, name: string, ref: string | null): string | null {
  if (role === 'generic' || ['div', 'span', 'body', 'html', 'p', 'section', 'br', 'tbody'].includes(role)) return null;
  // A landmark is named by what it holds, and reading its whole subtree into a
  // quoted name is how a tree turns into a wall of text.
  const naming = ref !== null || NAMED_ROLES.includes(role) || el.children.length === 0;
  const quoted = naming && name ? ` "${name.replace(/"/g, "'").replace(/\[ref=/gi, '[ref ')}"` : '';
  const level = role === 'heading' ? ` [level=${el.tagName.toLowerCase().slice(1)}]` : '';
  return `- ${role}${quoted}${level}${state(el)}${ref ? ` [ref=${ref}]` : ''}`;
}

/**
 * Walks one document and returns its tree, its interactive elements and the
 * live nodes behind them, in document order. The caller keeps the nodes: they
 * are what a later click resolves a ref to.
 */
export function collect(doc: Document): Collected & { nodes: Element[] } {
  const view = (doc.defaultView ?? globalThis) as Window & typeof globalThis;
  const measured = laysOut(doc);
  const interactive = new Set<Element>();
  for (const el of Array.from(doc.querySelectorAll(INTERACTIVE))) {
    if (visible(el, measured) && !disabled(el)) interactive.add(el);
  }
  const elements: CollectedElement[] = [];
  const nodes: Element[] = [];
  const lines: string[] = [];

  const walk = (el: Element, depth: number): void => {
    // Our own overlay (the halo and the agent's cursor) is never part of the page the model reads.
    if (['script', 'style', 'noscript', 'template', 'svg', 'head', 'errand-overlay'].includes(el.tagName.toLowerCase())) return;
    if (!visible(el, measured)) return;
    let ref: string | null = null;
    if (interactive.has(el) && elements.length < MAX_TARGETS) {
      ref = `l${elements.length + 1}`;
      const href = el.tagName.toLowerCase() === 'a' ? (el as HTMLAnchorElement).href : undefined;
      const box = measured ? bounds(el, view) : undefined;
      elements.push({ id: ref, role: roleOf(el), name: accessibleName(el),
        ...(href ? { href: href.slice(0, 2048) } : {}), ...(box ? { bounds: box } : {}) });
      nodes.push(el);
    }
    const role = roleOf(el);
    const rendered = line(el, role, accessibleName(el), ref);
    let childDepth = depth;
    if (rendered) { lines.push(`${'  '.repeat(depth)}${rendered}`); childDepth = depth + 1; }
    for (const child of Array.from(el.children)) walk(child, childDepth);
    if (!rendered && el.children.length === 0) {
      const text = textOf(visibleText(el));
      if (text) lines.push(`${'  '.repeat(depth)}- text: ${text.slice(0, 200)}`);
    }
  };

  for (const child of Array.from(doc.body?.children ?? [])) walk(child, 0);

  return {
    url: doc.location?.href ?? '', title: doc.title ?? '',
    tree: lines.join('\n').slice(0, MAX_TREE), elements, nodes,
    scroll: { x: Math.round(view.scrollX || 0), y: Math.round(view.scrollY || 0) },
  };
}
