/*
 * The on-device cleanup: Chrome's built-in model fixes punctuation and casing
 * in what was dictated, when this device has it ready. Nothing leaves the
 * device, nothing is downloaded on the owner's behalf (a model that is only
 * "downloadable" is skipped), and a result that changes any word is thrown
 * away (`sameWords`): this may punctuate what was said, not rewrite it.
 *
 * Chrome's Proofreader API is tried first, then the Prompt API with a narrow
 * instruction. Either can be missing; then the text rules alone stand.
 */

import { sameWords } from './polish.js';

export type Proofread = (text: string, lang: string) => Promise<string | null>;

interface Availability { availability(options?: unknown): Promise<string> }
interface ProofreaderClass extends Availability {
  create(options?: unknown): Promise<{ proofread(text: string): Promise<{ correctedInput?: string }>; destroy?(): void }>;
}
interface LanguageModelClass extends Availability {
  create(options?: unknown): Promise<{ prompt(text: string): Promise<string>; destroy?(): void }>;
}

/** Longer than this, a cleanup would keep the owner waiting: the rules suffice. */
const MAX_CHARS = 2_000;
const TIMEOUT_MS = 4_000;

const INSTRUCTION = 'You fix punctuation and capitalization in dictated speech. Reply with the same words in the same order, '
  + 'adding only punctuation (periods, commas, question marks…) and capital letters. Never add, remove, translate or reword anything. '
  + 'Reply with the corrected text only.';

function withTimeout<T>(work: Promise<T>): Promise<T | null> {
  return Promise.race([work, new Promise<null>((resolve) => { setTimeout(() => resolve(null), TIMEOUT_MS); })]);
}

/** Chrome's built-in models, or a test's stand-ins. */
export function onDeviceProofread(scope: { Proofreader?: ProofreaderClass; LanguageModel?: LanguageModelClass } = globalThis as never): Proofread {
  return async (text, lang) => {
    if (!text.trim() || text.length > MAX_CHARS) return null;
    const language = lang.split(/[-_]/)[0] ?? 'en';
    const accept = (result: string | null | undefined): string | null => {
      const cleaned = result?.trim();
      return cleaned && sameWords(text, cleaned) ? cleaned : null;
    };
    try {
      const { Proofreader } = scope;
      if (Proofreader && await Proofreader.availability({ expectedInputLanguages: [language] }) === 'available') {
        const proofreader = await Proofreader.create({ expectedInputLanguages: [language] });
        try {
          const result = accept((await withTimeout(proofreader.proofread(text)))?.correctedInput);
          if (result) return result;
        } finally { proofreader.destroy?.(); }
      }
    } catch { /* not this one */ }
    try {
      const { LanguageModel } = scope;
      const io = { expectedInputs: [{ type: 'text', languages: [language] }], expectedOutputs: [{ type: 'text', languages: [language] }] };
      if (LanguageModel && await LanguageModel.availability(io) === 'available') {
        const session = await LanguageModel.create({ ...io, initialPrompts: [{ role: 'system', content: INSTRUCTION }] });
        try {
          return accept(await withTimeout(session.prompt(text)));
        } finally { session.destroy?.(); }
      }
    } catch { /* not this one either */ }
    return null;
  };
}
