/*
 * The page half, injected on demand.
 *
 * Each frame reports its origin.
 *
 * It is not declared in the manifest for every page: the worker injects it
 * with `chrome.scripting` when a command needs the document, which keeps the
 * extension off every site the owner visits on their own. Injection is
 * idempotent, so a second observation reuses the registry the first one built.
 *
 * What it does *not* do is dispatch input. Clicks, typing and keys go through
 * the debugger in the worker, because a synthetic DOM event is not a real one
 * and half the web knows the difference. The page side only finds the element,
 * scrolls it into view and reports where it is.
 */

import { accessibleName, collect, roleOf, type CollectedElement } from './tree.js';

interface Registry {
  /*
   * Refs are looked up by name, and a page that has moved on must not hand back
   * a detached node, so each entry is a weak handle: the document decides how
   * long the element lives, this map never does.
   */
  refs: Map<string, WeakRef<Element>>;
  signatures: WeakMap<Element, string>;
  generation: number;
  /**
   * The edit ledger: every field the agent filled or
   * chose in this document, kept across observations, so a submission's
   * fingerprint carries the values it would send. Lives as long as the page.
   */
  edited: Array<WeakRef<Element>>;
  editedSet: WeakSet<Element>;
  /** Refs handed out for points, numbered apart from the tree's. */
  pointRefs?: number;
  /** This document's name for the worker, which only knows Chrome's frame ids. */
  token?: string;
}

export interface Located {
  ok: boolean;
  reason?: string;
  /** Viewport pixels, which is what the debugger's Input domain speaks. */
  point?: { x: number; y: number };
  password?: boolean;
  /** Set by value rather than typed: time, date, color… inputs ignore inserted text. */
  setByValue?: boolean;
  /** A field that reacts to each key (suggestions, search-as-you-type): typed key by key, even at the fast pace. */
  keyByKey?: boolean;
  /** A textarea or editable region: a line break is a line break there, not an Enter that could submit. */
  multiline?: boolean;
  role?: string;
  name?: string;
}

const KEY = '__errandPage';
/** Segmented pickers: Chrome ignores inserted text in these, so fill sets the value. */
const BY_VALUE = new Set(['time', 'date', 'datetime-local', 'month', 'week', 'color', 'range']);

function registry(): Registry {
  const holder = globalThis as unknown as Record<string, Registry | undefined>;
  const existing = holder[`${KEY}Registry`];
  if (existing) return existing;
  const created: Registry = { refs: new Map(), signatures: new WeakMap(), generation: 0, edited: [], editedSet: new WeakSet() };
  holder[`${KEY}Registry`] = created;
  return created;
}

/** What has to stay the same between an observation and the command that acts on it. */
function signature(el: Element): string {
  return JSON.stringify([el.tagName, roleOf(el), accessibleName(el),
    el.getAttribute('type') ?? '', el.getAttribute('href') ?? '', el.hasAttribute('disabled')]);
}

function recordEdit(element: Element): void {
  const state = registry();
  if (state.editedSet.has(element)) return;
  state.editedSet.add(element);
  state.edited.push(new WeakRef(element));
}

function resolve(ref: string): Element | null {
  const state = registry();
  const element = state.refs.get(ref)?.deref() ?? null;
  if (!element || !element.isConnected) return null;
  if (state.signatures.get(element) !== signature(element)) return null;
  return element;
}

function observe(): { url: string; title: string; tree: string; elements: CollectedElement[]; scroll: { x: number; y: number }; origin: string } {
  const state = registry();
  state.refs.clear();
  const result = collect(document);
  result.elements.forEach((element, index) => {
    const node = result.nodes[index];
    if (!node) return;
    state.refs.set(element.id, new WeakRef(node));
    state.signatures.set(node, signature(node));
  });
  state.generation += 1;
  // `self.origin` is the frame's effective origin: inherited for about:blank
  // and srcdoc frames, "null" when opaque (sandboxed).
  return { url: result.url, title: result.title, tree: result.tree, elements: result.elements, scroll: result.scroll, origin: self.origin };
}

function locate(ref: string, options: { focus?: boolean; clear?: boolean; mark?: boolean; still?: boolean } = {}): Located {
  const element = resolve(ref);
  if (!element) return { ok: false, reason: 'The referenced element changed or disappeared.' };
  const input = element as HTMLInputElement;
  const password = element.tagName.toLowerCase() === 'input' && input.type?.toLowerCase() === 'password';
  if (password && (options.focus || options.clear)) return { ok: false, password: true, reason: 'Passwords are entered by the owner, never by the agent. Ask the owner to sign in in this tab.' };
  // A click by point acts where the screenshot showed it: nothing may move.
  if (!options.still) element.scrollIntoView({ block: 'center', inline: 'center' });
  if (options.focus && 'focus' in element) (element as HTMLElement).focus();
  // A click the agent makes on a checkbox or radio changes what the form sends: it goes in the ledger too.
  const checkable = element.tagName.toLowerCase() === 'input' && ['checkbox', 'radio'].includes((input.type || '').toLowerCase());
  if (options.mark && checkable) recordEdit(element);
  if (options.clear && 'value' in element) {
    recordEdit(element);
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  const rect = element.getBoundingClientRect();
  const setByValue = element.tagName.toLowerCase() === 'input' && BY_VALUE.has((input.type || '').toLowerCase());
  const autocomplete = (element.getAttribute('aria-autocomplete') ?? 'none').toLowerCase();
  const keyByKey = element.getAttribute('role') === 'combobox' || autocomplete !== 'none' || element.hasAttribute('list')
    || (element.tagName.toLowerCase() === 'input' && (input.type || '').toLowerCase() === 'search');
  const multiline = element.tagName.toLowerCase() === 'textarea' || (element as HTMLElement).isContentEditable === true;
  return { ok: true, password, setByValue, keyByKey, multiline, role: roleOf(element), name: accessibleName(element),
    point: { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) } };
}

/**
 * The element under a point of the viewport, given a ref of its own so the
 * click that follows goes through the same checks as any other — the form
 * ledger, the submission fingerprint. A frame is refused: what is inside it
 * belongs to another document, and a point cannot say which.
 */
export interface PointHit { ok: boolean; reason?: string; ref?: string; role?: string; name?: string; href?: string; /** The document the ref lives in, when not this one. */ token?: string }

/** What a click activates: the nearest of these around the point. */
const CONTROLS = 'button, a[href], input, select, textarea, summary, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="checkbox"], [role="radio"], [role="switch"], [role="option"]';

function tokenOf(state: Registry): string {
  return (state.token ??= Math.random().toString(36).slice(2));
}

function pointAt(x: number, y: number): PointHit {
  const state = registry();
  const element = document.elementFromPoint(x, y);
  if (!element) return { ok: false, reason: 'There is nothing at that point (it may be outside the page).' };
  if (['iframe', 'frame', 'object', 'embed'].includes(element.tagName.toLowerCase())) {
    // A frame from the same site: the point continues inside it, in its own coordinates, and the ref is that document's.
    const frame = element as HTMLIFrameElement;
    type InnerWindow = { __errandPage?: { pointAt(x: number, y: number): PointHit }; __errandPageRegistry?: Registry };
    let inner: InnerWindow | null = null;
    try { inner = frame.contentDocument ? (frame.contentWindow as unknown as InnerWindow) : null; } catch { inner = null; }
    const api = inner?.__errandPage;
    if (!inner || !api) return { ok: false, reason: 'That point is inside a frame from another site, which a point cannot reach. Use a ref from observation.targets.' };
    const box = frame.getBoundingClientRect();
    const hit = api.pointAt(x - box.left - frame.clientLeft, y - box.top - frame.clientTop);
    if (!hit.ok || hit.token) return hit;
    const innerRegistry = inner.__errandPageRegistry;
    return innerRegistry ? { ...hit, token: tokenOf(innerRegistry) } : { ok: false, reason: 'That frame could not be read. Observe again.' };
  }
  // The click activates the control the point is in, not the text node it landed on: a span inside a submit
  // button is that button, so the submission check (submitFacts) sees what will really be submitted.
  const control = (element.closest(CONTROLS) as Element | null) ?? element;
  state.pointRefs = (state.pointRefs ?? 0) + 1;
  const ref = `p${state.pointRefs}`;
  state.refs.set(ref, new WeakRef(control));
  state.signatures.set(control, signature(control));
  const link = control.closest('a[href]') as HTMLAnchorElement | null;
  return { ok: true, ref, role: roleOf(control), name: accessibleName(control), ...(link?.href ? { href: link.href } : {}) };
}

/** This document's token, for the worker to tell which Chrome frame a point landed in. */
function token(): string {
  return tokenOf(registry());
}

/**
 * Where this document sits in the tab's viewport: the sum of its frame
 * elements' boxes up the chain. Null once a parent is another site, whose
 * frame element cannot be read.
 */
function frameOffset(): { x: number; y: number } | null {
  let x = 0;
  let y = 0;
  let win: Window = window;
  while (win !== win.top) {
    let element: Element | null = null;
    try { element = win.frameElement; } catch { element = null; }
    if (!element) return null;
    const box = element.getBoundingClientRect();
    x += box.left + element.clientLeft;
    y += box.top + element.clientTop;
    win = win.parent;
  }
  return { x: Math.round(x), y: Math.round(y) };
}

/** A native `select` is the one control where setting the value is the honest action. */
function choose(ref: string, value: string): Located {
  const element = resolve(ref);
  if (!element) return { ok: false, reason: 'The referenced element changed or disappeared.' };
  const select = element as HTMLSelectElement;
  if (select.tagName?.toLowerCase() !== 'select') return { ok: false, reason: 'That element is not a select.' };
  const option = Array.from(select.options).find((candidate) => candidate.label === value || candidate.text === value || candidate.value === value);
  if (!option) return { ok: false, reason: `No option named ${value} in that select.` };
  recordEdit(select);
  select.value = option.value;
  select.dispatchEvent(new Event('input', { bubbles: true }));
  select.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, role: 'combobox', name: accessibleName(select) };
}

function scrollPage(direction: 'up' | 'down'): { ok: true } {
  window.scrollBy({ top: direction === 'up' ? -600 : 600, behavior: 'instant' as ScrollBehavior });
  return { ok: true };
}

/* ---- form submission facts ---- */

export interface SubmitFingerprint {
  frameOrigin: string;
  form: { index: number; id: string; name: string };
  /** The complete resolved URL the form would go to, fragment dropped. */
  action: string;
  method: string;
  submitter: { role: string; name: string; index: number } | null;
  /** Current values of every field the agent edited in this form. */
  fields: Array<{ name: string; value: string }>;
}

export interface SubmitFacts { ok: boolean; reason?: string; submits?: boolean; fingerprint?: SubmitFingerprint }

type Submittable = HTMLButtonElement | HTMLInputElement;

function isSubmitButton(element: Element): element is Submittable {
  const tag = element.tagName.toLowerCase();
  const type = (element.getAttribute('type') ?? '').toLowerCase();
  if (tag === 'button') return type !== 'button' && type !== 'reset';
  return tag === 'input' && (type === 'submit' || type === 'image');
}

/** Input types where Enter submits the form (implicit submission). */
const IMPLICIT = new Set(['', 'text', 'search', 'url', 'tel', 'email', 'password', 'number', 'date', 'datetime-local', 'month', 'week', 'time']);

/**
 * The effective submitter: the element the browser will submit with. For a
 * click or Space on a submit button, the button. For Enter in a field, the
 * form's default button — its first submit button in tree order — whose
 * formaction/formmethod override the form's (HTML implicit submission).
 */
function submission(element: Element, via: 'click' | 'enter' | 'space'): { form: HTMLFormElement; submitter: Submittable | null } | null {
  if (isSubmitButton(element)) {
    if (via === 'click' || via === 'space' || via === 'enter') return element.form ? { form: element.form, submitter: element } : null;
  }
  if (via !== 'enter') return null;
  const input = element as HTMLInputElement;
  if (element.tagName.toLowerCase() !== 'input' || !IMPLICIT.has((input.type || '').toLowerCase()) || !input.form) return null;
  const form = input.form;
  const button = Array.from(form.elements).find((candidate) => isSubmitButton(candidate)) as Submittable | undefined;
  return { form, submitter: button ?? null };
}

function withoutFragment(url: string): string {
  try { const parsed = new URL(url); parsed.hash = ''; return parsed.href; } catch { return url; }
}

function submitFacts(ref: string, via: 'click' | 'enter' | 'space'): SubmitFacts {
  const element = resolve(ref);
  if (!element) return { ok: false, reason: 'The referenced element changed or disappeared.' };
  const found = submission(element, via);
  if (!found) return { ok: true, submits: false };
  const { form, submitter } = found;
  // Read from the attributes and resolve per HTML: the submitter's formaction /
  // formmethod win over the form's; a missing or empty action is the document.
  const rawAction = submitter?.hasAttribute('formaction') ? submitter.getAttribute('formaction') : form.getAttribute('action');
  const action = new URL(rawAction || document.URL, document.baseURI).href;
  const rawMethod = ((submitter?.hasAttribute('formmethod') ? submitter.getAttribute('formmethod') : form.getAttribute('method')) ?? '').toLowerCase();
  const method = ['post', 'dialog'].includes(rawMethod) ? rawMethod : 'get';
  const fields = registry().edited
    .map((handle) => handle.deref())
    .filter((field): field is HTMLInputElement => !!field && field.isConnected && (field as HTMLInputElement).form === form)
    .flatMap((field) => {
      const name = field.name || accessibleName(field);
      const type = (field.type || '').toLowerCase();
      if (type === 'password') return [{ name, value: '' }];
      // A radio shows only when it is the chosen one; a checkbox says whether it is on.
      if (type === 'radio') return field.checked ? [{ name, value: field.value }] : [];
      if (type === 'checkbox') return [{ name, value: field.checked ? field.value : '(unchecked)' }];
      return [{ name, value: field.value }];
    });
  return {
    ok: true,
    submits: true,
    fingerprint: {
      frameOrigin: self.origin,
      form: { index: Array.from(document.forms).indexOf(form), id: form.id, name: form.getAttribute('name') ?? '' },
      action: withoutFragment(action),
      method: method.toUpperCase(),
      submitter: submitter ? { role: roleOf(submitter), name: accessibleName(submitter), index: Array.from(form.elements).indexOf(submitter) } : null,
      fields,
    },
  };
}

const api = { observe, locate, choose, scroll: scrollPage, submitFacts, pointAt, token, frameOffset };
export type ContentApi = typeof api;
(globalThis as unknown as Record<string, ContentApi>)[KEY] = api;
