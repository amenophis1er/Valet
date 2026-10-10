/*
 * Dictation into a text field: the words appear as they are spoken, and are
 * cleaned up once the owner stops.
 *
 * Live: the current guess is shown at the end of the field and replaced as it
 * firms up; a phrase that settles is written for good, with its casing fixed
 * (`settle`). Words already written and anything typed meanwhile stay.
 *
 * At the end: the dictated stretch — from where dictation began to the end of
 * the field — gets its end punctuation (`finish`), then, when the device has
 * a built-in model, one cleanup pass for the punctuation inside it. Two rules
 * keep that safe: only the dictated stretch is touched, never text before it;
 * and if the stretch changed by the time a cleanup is ready (the owner edited
 * or sent it), nothing is replaced. In a focused field the replacement goes
 * through the browser's own editing, so Cmd+Z brings the raw words back.
 */

import { finish, sameWords, settle } from './polish.js';
import type { Proofread } from './proofread.js';
import type { Recognizer } from './recognizer.js';

export interface DictationOptions {
  recognizer: Recognizer;
  /** The on-device cleanup at the end; null for none. */
  proofread: Proofread | null;
  /** Fix casing and end punctuation with the text rules. Default true. */
  polish?: boolean;
  /** The field's text changed (to resize it, save a draft…). */
  onInput?(): void;
  /** Listening started or stopped. */
  onListening?(listening: boolean): void;
  /** A session ended; `error` is Chrome's, e.g. "not-allowed" before the microphone was allowed. */
  onEnd?(error?: string): void;
}

export interface DictationController {
  supported(): boolean;
  /** For the mic button's tooltip. */
  describe(): string;
  readonly listening: boolean;
  /** Start listening; false when the browser cannot. */
  start(): boolean;
  stop(): void;
  toggle(): boolean;
}

type TextField = HTMLTextAreaElement | HTMLInputElement;

/** Replace part of the field: through the browser's editing when it has focus (undoable), else directly. */
function replaceRange(field: TextField, start: number, end: number, text: string): void {
  const doc = field.ownerDocument;
  if (doc.activeElement === field) {
    field.setSelectionRange(start, end);
    if (doc.execCommand?.('insertText', false, text)) return;
  }
  field.value = field.value.slice(0, start) + text + field.value.slice(end);
  field.setSelectionRange(field.value.length, field.value.length);
}

export function attachDictation(field: TextField, options: DictationOptions): DictationController {
  const { recognizer, proofread } = options;
  const polish = options.polish !== false;
  const lang = recognizer.lang;
  let session: { stop(): void } | undefined;

  const start = (): boolean => {
    if (session) return true;
    /** Where the dictated stretch begins: set when its first phrase is written. */
    let from: number | undefined;
    /** The stretch as dictation last wrote it: the end pass touches it only if it is still exactly that. */
    let written = '';
    let guess = '';
    session = recognizer.listen({
      onText: (heard, guessing) => {
        let text = guess && field.value.endsWith(guess) ? field.value.slice(0, -guess.length) : field.value;
        const separator = (value: string) => (text && value && !/\s$/.test(text) ? ' ' : '');
        const phrase = heard.trim();
        if (phrase) {
          const sep = separator(phrase);
          from ??= text.length + sep.length;
          text += sep + (polish ? settle(text, phrase, lang) : phrase);
        }
        guess = guessing.trim() ? separator(guessing) + guessing.trim() : '';
        field.value = text + guess;
        if (from !== undefined) written = field.value.slice(from);
        options.onInput?.();
      },
      onEnd: (error) => {
        session = undefined;
        options.onListening?.(false);
        options.onEnd?.(error);
        if (from !== undefined && field.value.slice(from) === written) void cleanUp(from);
      },
    });
    if (!session) return false;
    options.onListening?.(true);
    return true;
  };

  /** The end of a session: end punctuation now, then the on-device pass if the stretch is still as it was. */
  async function cleanUp(from: number): Promise<void> {
    const before = field.value.slice(0, from);
    const raw = field.value.slice(from);
    if (!raw.trim()) return;
    let current = raw;
    if (polish) {
      current = finish(before, raw, lang);
      if (current !== raw) { replaceRange(field, from, field.value.length, current); options.onInput?.(); }
    }
    if (!proofread) return;
    const better = await proofread(current.trim(), lang).catch(() => null);
    // Edited, sent or dictated over meanwhile: the owner's text wins.
    if (!better || !sameWords(current, better) || field.value.slice(from) !== current || session) return;
    // Mid-sentence (after text the owner typed), the first word keeps its case: the cleanup saw only the stretch.
    const lead = /[.?!…]["'”’)]*\s*$/.test(before) || !before.trim() ? better : current.trimStart().charAt(0) + better.trimStart().slice(1);
    const fixed = (polish ? finish(before, lead, lang) : lead) + current.slice(current.trimEnd().length);
    if (fixed !== current) { replaceRange(field, from, field.value.length, fixed); options.onInput?.(); }
  }

  const stop = (): void => { session?.stop(); };
  return {
    supported: () => recognizer.supported(),
    describe: () => recognizer.describe(),
    get listening() { return session !== undefined; },
    start,
    stop,
    toggle: () => { if (session) { stop(); return false; } return start(); },
  };
}
