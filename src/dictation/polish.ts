/*
 * Text rules for dictated speech: pure functions, no browser.
 *
 * Speech recognition gives words without sentence casing or end punctuation.
 * Two moments fix that:
 *  - live, as each phrase settles: casing only (`settle`). Recognition
 *    settles at pauses, not at sentence ends, so a pause is no reason for a
 *    period;
 *  - once, when the owner stops: the end of the dictated text gets its
 *    period or question mark (`finish`). An on-device model may do better
 *    (proofread.ts); `sameWords` is what keeps it to punctuation and casing.
 *
 * The rules are for languages written with Latin script and Western
 * punctuation; the question test is English only. Elsewhere they do nothing.
 */

const LATIN = new Set(['en', 'fr', 'es', 'de', 'it', 'pt', 'nl', 'ca', 'da', 'sv', 'nb', 'no', 'fi', 'pl', 'cs', 'ro', 'hu', 'tr', 'id', 'ms', 'vi', 'sw']);

function base(lang: string): string {
  return lang.toLowerCase().split(/[-_]/)[0] ?? '';
}

export function rulesApply(lang: string): boolean {
  return LATIN.has(base(lang));
}

/** The text before this point ends a sentence, or there is no text yet. */
function sentenceStart(before: string): boolean {
  return before.trim() === '' || /[.?!…]["'”’)]*\s*$/.test(before);
}

function capitalizeFirst(text: string): string {
  return text.replace(/^(\s*["'“‘(]?)(\p{Ll})/u, (_, lead: string, letter: string) => lead + letter.toLocaleUpperCase());
}

/** English: the pronoun "I" on its own, and its contractions (I'm, I'll, I've, I'd). */
function capitalizeI(text: string): string {
  return text.replace(/(^|[^\p{L}\p{N}'’])i(?=$|[^\p{L}\p{N}'’]|['’](?:m|ll|ve|d)\b)/gu, '$1I');
}

/**
 * A phrase that just settled, as it should be written after `before` (the
 * field's text up to where it goes): capitalized at a sentence start, and the
 * English "i" made "I". Nothing else changes.
 */
export function settle(before: string, phrase: string, lang: string): string {
  if (!rulesApply(lang)) return phrase;
  let text = phrase;
  if (sentenceStart(before)) text = capitalizeFirst(text);
  if (base(lang) === 'en') text = capitalizeI(text);
  return text;
}

const QUESTION = /^(who|whom|whose|what|when|where|which|why|how|is|are|am|was|were|do|does|did|can|could|will|would|shall|should|may|might|must|have|has|had|isn't|aren't|wasn't|weren't|don't|doesn't|didn't|can't|couldn't|won't|wouldn't|shouldn't|haven't|hasn't)\b/i;

/** The last sentence of `text`, for the question test. */
function lastSentence(text: string): string {
  const parts = text.trim().split(/(?<=[.?!…])\s+/);
  return parts[parts.length - 1] ?? '';
}

/**
 * The dictated text once the owner stopped: its first letter capitalized
 * (after `before`), and a period or question mark at its end if it has no end
 * punctuation. A question is told by its first word, in English only.
 */
export function finish(before: string, dictated: string, lang: string): string {
  if (!rulesApply(lang)) return dictated;
  const trimmed = dictated.replace(/\s+$/, '');
  if (!trimmed.trim()) return dictated;
  let text = sentenceStart(before) ? capitalizeFirst(trimmed) : trimmed;
  if (!/[.?!…:;,]["'”’)]*$/.test(text)) {
    const question = base(lang) === 'en' && QUESTION.test(lastSentence(text).replace(/^["'“‘(]+/, ''));
    text += question ? '?' : '.';
  }
  return text + dictated.slice(trimmed.length);
}

/** The words of a text, ignoring case, punctuation and apostrophes. */
function words(text: string): string[] {
  return (text.toLocaleLowerCase().replace(/['’]/g, '').match(/[\p{L}\p{N}]+/gu) ?? []);
}

/**
 * Whether two texts say the same words in the same order: a cleanup may
 * change punctuation and casing, never what was said.
 */
export function sameWords(a: string, b: string): boolean {
  const left = words(a);
  const right = words(b);
  return left.length === right.length && left.every((word, i) => word === right[i]);
}
