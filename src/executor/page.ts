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
