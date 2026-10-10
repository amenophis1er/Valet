/*
 * Code that runs inside web pages, never in the worker.
 *
 * `chrome.scripting.executeScript` serializes each of these functions, so
 * they may not close over anything in this module: each is self-contained on
 * purpose. Most hand over to the content script's API (content.ts), which
 * holds the refs of the latest observation in the page's isolated world.
 */

import type { SubmitFingerprint } from './content.js';
import type { CollectedElement } from './tree.js';

export interface FrameObservation {
  url: string; title: string; tree: string; elements: CollectedElement[]; scroll: { x: number; y: number };
  /** `self.origin` in that frame: inherited for about:blank/srcdoc, "null" when opaque. */
  origin?: string;
}

/*
 * `chrome.scripting.executeScript` serializes these, so they may not close over
 * anything in this module. Each one is self-contained on purpose.
 */

export function readViewport(): string {
  return `${innerWidth}x${innerHeight}`;
}

export function readOrigin(): string {
  return self.origin;
}

/**
 * Every frame element in the page — through open and closed shadow roots and
 * same-origin frames — with a stable id per element, so two listings can be
 * compared. Frames in the top document carry their box in viewport CSS pixels
 * (padded, so a mask covers borders and rounding); a frame inside a
 * same-origin frame carries `within`, the top-level frame that contains it.
 */
export function listFrames(): { viewport: { width: number; height: number }; frames: Array<{ id: number; x: number; y: number; w: number; h: number; readable: boolean; origin: string | null; within?: number }> } {
  const holder = globalThis as unknown as { __valetFrameIds?: WeakMap<Element, number>; __valetFrameNext?: number };
  holder.__valetFrameIds ??= new WeakMap();
  const ids = holder.__valetFrameIds;
  const dom = (globalThis as unknown as { chrome?: { dom?: { openOrClosedShadowRoot?(element: Element): ShadowRoot | null } } }).chrome?.dom;
  const frames: Array<{ id: number; x: number; y: number; w: number; h: number; readable: boolean; origin: string | null; within?: number }> = [];
  const rootsOf = (root: Document | ShadowRoot): Array<Document | ShadowRoot> => {
    const roots: Array<Document | ShadowRoot> = [root];
    for (const element of root.querySelectorAll('*')) {
      let shadow: ShadowRoot | null = null;
      try { shadow = dom?.openOrClosedShadowRoot?.(element) ?? element.shadowRoot; } catch { shadow = element.shadowRoot; }
      if (shadow) roots.push(...rootsOf(shadow));
    }
    return roots;
  };
  const walk = (doc: Document, within: number | undefined, depth: number) => {
    for (const root of rootsOf(doc)) {
      for (const element of root.querySelectorAll('iframe, frame, object, embed')) {
        let id = ids.get(element);
        if (id === undefined) { id = (holder.__valetFrameNext = (holder.__valetFrameNext ?? 0) + 1); ids.set(element, id); }
        let inner: Document | null = null;
        try { inner = (element as HTMLIFrameElement).contentDocument ?? null; } catch { inner = null; }
        const src = (element as HTMLIFrameElement).src || (element as HTMLObjectElement).data || '';
        let origin: string | null = null;
        try { origin = src ? new URL(src, doc.baseURI).origin : null; } catch { origin = null; }
        if (origin === 'null') origin = null;
        const box = element.getBoundingClientRect();
        const readable = !!inner && depth < 5;
        frames.push({ id, x: Math.floor(box.left) - 2, y: Math.floor(box.top) - 2, w: Math.ceil(box.width) + 4, h: Math.ceil(box.height) + 4, readable, origin,
          ...(within !== undefined ? { within } : {}) });
        if (readable) walk(inner!, within ?? id, depth + 1);
      }
    }
  };
  walk(document, undefined, 0);
  return { viewport: { width: innerWidth, height: innerHeight }, frames };
}

export function readReadyState(): string {
  return document.readyState;
}

export function readObservation(): FrameObservation | null {
  const api = (globalThis as unknown as Record<string, { observe(): FrameObservation } | undefined>)['__valetPage'];
  return api ? api.observe() : null;
}

export function locateRef(ref: string, options: { focus?: boolean; clear?: boolean }): { ok: boolean; reason?: string; point?: { x: number; y: number } } {
  const api = (globalThis as unknown as Record<string, { locate(ref: string, options: unknown): { ok: boolean; reason?: string; point?: { x: number; y: number } } } | undefined>)['__valetPage'];
  return api ? api.locate(ref, options) : { ok: false, reason: 'The page was reloaded. Observe again.' };
}

export function pointAtRef(x: number, y: number): { ok: boolean; reason?: string; ref?: string; role?: string; name?: string; href?: string; token?: string } {
  const api = (globalThis as unknown as Record<string, { pointAt(x: number, y: number): { ok: boolean; reason?: string; ref?: string; role?: string; name?: string; href?: string; token?: string } } | undefined>)['__valetPage'];
  return api ? api.pointAt(x, y) : { ok: false, reason: 'The page was reloaded. Observe again.' };
}

export function tokenRef(): string | null {
  const api = (globalThis as unknown as Record<string, { token(): string } | undefined>)['__valetPage'];
  return api ? api.token() : null;
}

export function frameOffsetRef(): { x: number; y: number } | null {
  const api = (globalThis as unknown as Record<string, { frameOffset(): { x: number; y: number } | null } | undefined>)['__valetPage'];
  return api ? api.frameOffset() : null;
}

export function submitFactsRef(ref: string, via: 'click' | 'enter' | 'space'): { ok: boolean; reason?: string; submits?: boolean; fingerprint?: SubmitFingerprint } {
  const api = (globalThis as unknown as Record<string, { submitFacts(ref: string, via: string): { ok: boolean; reason?: string; submits?: boolean; fingerprint?: SubmitFingerprint } } | undefined>)['__valetPage'];
  return api ? api.submitFacts(ref, via) : { ok: false, reason: 'The page was reloaded. Observe again.' };
}

export function chooseRef(ref: string, value: string): { ok: boolean; reason?: string } {
  const api = (globalThis as unknown as Record<string, { choose(ref: string, value: string): { ok: boolean; reason?: string } } | undefined>)['__valetPage'];
  return api ? api.choose(ref, value) : { ok: false, reason: 'The page was reloaded. Observe again.' };
}

export function scrollPage(direction: 'up' | 'down'): void {
  const api = (globalThis as unknown as Record<string, { scroll(direction: 'up' | 'down'): void } | undefined>)['__valetPage'];
  api?.scroll(direction);
}

export function scrollStep(top: number): void {
  window.scrollBy({ top, behavior: 'instant' as ScrollBehavior });
}

export function clickRef(ref: string, count = 1, button: 'left' | 'right' = 'left'): void {
  const api = (globalThis as unknown as Record<string, { locate(ref: string, options: unknown): { ok: boolean } } | undefined>)['__valetPage'];
  api?.locate(ref, {});
  const holder = (globalThis as unknown as Record<string, { refs: Map<string, WeakRef<Element>> } | undefined>)['__valetPageRegistry'];
  const element = holder?.refs.get(ref)?.deref() as HTMLElement | undefined;
  if (!element) return;
  // Without the debugger: the events a page listens for, in the order a mouse sends them.
  const box = element.getBoundingClientRect();
  const at = { bubbles: true, cancelable: true, composed: true, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2, view: window };
  if (button === 'right') {
    element.dispatchEvent(new MouseEvent('mousedown', { ...at, button: 2, buttons: 2 }));
    element.dispatchEvent(new MouseEvent('mouseup', { ...at, button: 2 }));
    element.dispatchEvent(new MouseEvent('contextmenu', { ...at, button: 2 }));
    return;
  }
  element.click();
  if (count === 2) {
    element.dispatchEvent(new MouseEvent('click', { ...at, detail: 2 }));
    element.dispatchEvent(new MouseEvent('dblclick', { ...at, detail: 2 }));
  }
}

export function typeRef(ref: string, value: string): void {
  const holder = (globalThis as unknown as Record<string, { refs: Map<string, WeakRef<Element>> } | undefined>)['__valetPageRegistry'];
  const element = holder?.refs.get(ref)?.deref() as HTMLInputElement | undefined;
  if (!element) return;
  // The prototype's setter, so frameworks that track the value (React) see the change.
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(element, value); else element.value = value;
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

/** Exported for its test only: it runs in the page, through executeScript. */
export function pressRef(ref: string, key: string, code: string, keyCode: number): void {
  const holder = (globalThis as unknown as Record<string, { refs: Map<string, WeakRef<Element>> } | undefined>)['__valetPageRegistry'];
  const element = holder?.refs.get(ref)?.deref() as HTMLElement | undefined;
  if (!element) return;
  let handled = false;
  for (const type of ['keydown', 'keypress', 'keyup']) {
    const went = element.dispatchEvent(new KeyboardEvent(type, { key, code, keyCode, bubbles: true, cancelable: true } as KeyboardEventInit));
    if (type === 'keydown' && !went) handled = true;
  }
  // Enter in a text field submits its form, as a real key press would (implicit submission), unless the page took
  // the key — with the form's default button as the submitter, whose formaction/formmethod the approval was read from.
  const submits = ['text', 'search', 'email', 'url', 'tel', 'password', 'number', 'date', 'time', 'datetime-local', 'month', 'week'];
  if (key !== 'Enter' || handled || !(element instanceof HTMLInputElement) || !submits.includes(element.type) || !element.form) return;
  const form = element.form;
  const button = Array.from(form.elements).find((candidate) => {
    const tag = candidate.tagName.toLowerCase();
    const type = ((candidate as HTMLInputElement).type || '').toLowerCase();
    return (tag === 'button' && (type === 'submit' || type === '')) || (tag === 'input' && (type === 'submit' || type === 'image'));
  }) as HTMLButtonElement | HTMLInputElement | undefined;
  try { form.requestSubmit(button); } catch { form.requestSubmit(); }
}

export function hoverRef(ref: string): void {
  const holder = (globalThis as unknown as Record<string, { refs: Map<string, WeakRef<Element>> } | undefined>)['__valetPageRegistry'];
  const element = holder?.refs.get(ref)?.deref() as HTMLElement | undefined;
  if (!element) return;
  for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove']) {
    element.dispatchEvent(new MouseEvent(type, { bubbles: !type.endsWith('enter'), cancelable: true }));
  }
}

/**
 * The page's readable text, for `read`: the main content (the largest of
 * main, [role=main] and article, else the body) as light Markdown — headings,
 * paragraphs, lists, tables, quotes and code — without navigation, banners,
 * footers, sidebars, forms, hidden elements or footnote markers. Injected on
 * its own: everything it uses is inside it.
 */
export function readPageText(): { url: string; title: string; text: string } {
  const MAX = 400_000;
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'IFRAME', 'OBJECT', 'NAV', 'ASIDE', 'FOOTER', 'FORM', 'BUTTON', 'SELECT', 'INPUT', 'TEXTAREA', 'DIALOG', 'MENU']);
  const SKIP_ROLES = new Set(['navigation', 'banner', 'contentinfo', 'complementary', 'search', 'menu', 'menubar', 'toolbar', 'dialog', 'alertdialog', 'tablist', 'button']);
  const BLOCKS = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'HEADER', 'FIGURE', 'FIGCAPTION', 'DL', 'DT', 'DD', 'DETAILS', 'SUMMARY', 'ADDRESS', 'CAPTION', 'CENTER', 'HR']);

  const candidates = [...document.querySelectorAll<HTMLElement>('main, [role="main"], article')];
  let root: HTMLElement = document.body ?? document.documentElement;
  let best = 0;
  for (const candidate of candidates) {
    const size = candidate.textContent?.length ?? 0;
    if (size > best) { best = size; root = candidate; }
  }
  if (best < 500) root = document.body ?? document.documentElement;
  const atBody = root === document.body;

  const skipped = (el: Element): boolean => {
    if (SKIP_TAGS.has(el.tagName)) return true;
    if (el.tagName === 'HEADER' && atBody && el.parentElement === document.body) return true;
    const role = el.getAttribute('role');
    if (role && SKIP_ROLES.has(role)) return true;
    if (el.getAttribute('aria-hidden') === 'true' || (el as HTMLElement).hidden) return true;
    // Footnote markers ([1], [a]) and edit links ([edit]) are noise in a summary.
    if (el.tagName === 'SUP' && /^\s*\[[^\]]{1,6}\]\s*$/.test(el.textContent ?? '')) return true;
    if (/^\s*\[\s*edit\s*\]\s*$/i.test(el.textContent ?? '') && el.childElementCount <= 3 && (el.textContent ?? '').length < 20) return true;
    const style = el instanceof HTMLElement ? getComputedStyle(el) : null;
    return style !== null && (style.display === 'none' || style.visibility === 'hidden');
  };

  const out: string[] = [];
  let size = 0;
  const block = (text: string): void => {
    const clean = text.replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').trim();
    if (!clean || size > MAX) return;
    out.push(clean);
    size += clean.length + 2;
  };

  /** The text of an element as one line: inline content, skipped parts left out. */
  const inline = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
    if (!(node instanceof Element) || skipped(node)) return '';
    if (node.tagName === 'BR') return '\n';
    if (node.tagName === 'IMG') {
      // Icons and badges are not content: only an image drawn at a real size is named, by its alt text.
      const image = node as HTMLImageElement;
      const alt = image.getAttribute('alt')?.trim();
      const small = (image.width > 0 && image.width < 64) || (image.height > 0 && image.height < 64);
      return alt && !small ? ` [image: ${alt}] ` : '';
    }
    let text = '';
    for (const child of node.childNodes) {
      if (child instanceof Element && (child.tagName === 'UL' || child.tagName === 'OL')) continue;
      text += inline(child);
    }
    return /^(DIV|P|LI|TD|TH|DT|DD|SECTION)$/.test(node.tagName) ? ` ${text} ` : text;
  };

  const table = (el: HTMLTableElement): void => {
    const rows = [...el.rows].slice(0, 200).map((row) => [...row.cells].map((cell) => inline(cell).replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|').slice(0, 300)));
    const wide = Math.max(0, ...rows.map((row) => row.length));
    if (wide === 0) return;
    const lines = rows.filter((row) => row.some(Boolean)).map((row) => `| ${[...row, ...Array(wide - row.length).fill('')].join(' | ')} |`);
    if (lines.length === 0) return;
    const caption = el.caption ? inline(el.caption).trim() : '';
    block(`${caption ? `${caption}\n` : ''}${lines[0]}\n|${' --- |'.repeat(wide)}\n${lines.slice(1).join('\n')}`);
  };

  /** A list's lines, nested lists indented under their item. */
  const listLines = (el: Element, depth: number): string[] => {
    let index = 0;
    const lines: string[] = [];
    for (const item of el.children) {
      if (item.tagName !== 'LI' || skipped(item)) continue;
      index += 1;
      const marker = el.tagName === 'OL' ? `${index}.` : '-';
      const text = inline(item).replace(/\s+/g, ' ').trim();
      if (text) lines.push(`${'  '.repeat(depth)}${marker} ${text}`);
      for (const nested of item.children) {
        if (nested.tagName === 'UL' || nested.tagName === 'OL') lines.push(...listLines(nested, depth + 1));
      }
    }
    return lines;
  };

  const walk = (el: Element): void => {
    if (size > MAX || skipped(el)) return;
    const tag = el.tagName;
    if (/^H[1-6]$/.test(tag)) { block(`${'#'.repeat(Number(tag[1]))} ${inline(el).replace(/\s+/g, ' ')}`); return; }
    if (tag === 'UL' || tag === 'OL') {
      const lines = listLines(el, 0);
      // Pushed as they are: the indentation of nested items is the point.
      if (lines.length > 0 && size <= MAX) { out.push(lines.join('\n')); size += lines.join('\n').length + 2; }
      return;
    }
    if (tag === 'TABLE') { table(el as HTMLTableElement); return; }
    if (tag === 'PRE') { block(`\`\`\`\n${(el.textContent ?? '').slice(0, 20_000)}\n\`\`\``); return; }
    if (tag === 'BLOCKQUOTE') { block(inline(el).trim().split('\n').map((line) => `> ${line.trim()}`).join('\n')); return; }
    // A block made only of inline content is one paragraph; otherwise its children are walked.
    const hasBlocks = [...el.children].some((child) => BLOCKS.has(child.tagName) || /^(H[1-6]|UL|OL|TABLE|PRE|BLOCKQUOTE)$/.test(child.tagName));
    if (!hasBlocks) { block(inline(el)); return; }
    let run = '';
    for (const child of el.childNodes) {
      const isBlock = child instanceof Element && (BLOCKS.has(child.tagName) || /^(H[1-6]|UL|OL|TABLE|PRE|BLOCKQUOTE)$/.test(child.tagName));
      if (isBlock) { block(run); run = ''; walk(child as Element); }
      else run += inline(child);
    }
    block(run);
  };

  walk(root);
  return { url: location.href, title: document.title, text: out.join('\n\n').slice(0, MAX) };
}
