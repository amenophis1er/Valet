/*
 * Chrome's built-in model (Gemini Nano): whether this device has it, and
 * downloading it when the owner asks.
 *
 * Chrome downloads the model only for a page that asks in answer to a click,
 * so without a button most people would never get it. `download` is that
 * button's work: the language model the cleanup falls back to, then the
 * Proofreader's own part when Chrome has that API. Chrome keeps one copy per
 * profile, shared by every site and extension that uses it.
 *
 * Cancel aborts the request. Chrome may still finish a download it had well
 * under way; `state()` afterwards says which happened.
 */

export type ModelState =
  | { kind: 'unsupported'; reason: string }
  | { kind: 'downloadable' }
  | { kind: 'downloading' }
  | { kind: 'ready' };

interface Monitor { addEventListener(type: 'downloadprogress', listener: (event: { loaded: number }) => void): void }
interface Creatable {
  availability(options?: unknown): Promise<string>;
  create(options?: unknown): Promise<{ destroy?(): void }>;
}
export interface BuiltInAi { LanguageModel?: Creatable; Proofreader?: Creatable }

/** What the models are asked for: text in and out, in the owner's language. */
export function languageModelIo(lang: string): { expectedInputs: unknown[]; expectedOutputs: unknown[] } {
  const language = lang.split(/[-_]/)[0] ?? 'en';
  return { expectedInputs: [{ type: 'text', languages: [language] }], expectedOutputs: [{ type: 'text', languages: [language] }] };
}

export function proofreaderOptions(lang: string): { expectedInputLanguages: string[] } {
  return { expectedInputLanguages: [lang.split(/[-_]/)[0] ?? 'en'] };
}

export interface OnDeviceModel {
  state(): Promise<ModelState>;
  /** Download what the cleanup needs. `onProgress` gets 0 to 1. Rejects with an AbortError when cancelled. */
  download(options: { onProgress(fraction: number): void; signal: AbortSignal }): Promise<ModelState>;
}

export function onDeviceModel(lang: string, scope: BuiltInAi = globalThis as never): OnDeviceModel {
  const io = languageModelIo(lang);

  async function state(): Promise<ModelState> {
    const { LanguageModel } = scope;
    if (!LanguageModel) return { kind: 'unsupported', reason: 'This Chrome has no built-in model. It needs Chrome 138 or later on a computer.' };
    let answer: string;
    try { answer = await LanguageModel.availability(io); } catch { answer = 'unavailable'; }
    if (answer === 'unavailable') return { kind: 'unsupported', reason: 'This computer does not meet Chrome\'s requirements for its built-in model, or it does not handle your language yet.' };
    if (answer === 'downloading') return { kind: 'downloading' };
    if (answer === 'downloadable') return { kind: 'downloadable' };
    // The language model is here; the Proofreader's part may still be missing, and is optional.
    return { kind: 'ready' };
  }

  async function fetch(api: Creatable, options: unknown, signal: AbortSignal, onProgress: (fraction: number) => void): Promise<void> {
    const instance = await api.create({
      ...(options as object),
      signal,
      monitor: (monitor: Monitor) => monitor.addEventListener('downloadprogress', (event) => onProgress(Math.max(0, Math.min(1, event.loaded)))),
    });
    instance.destroy?.();
  }

  return {
    state,
    async download({ onProgress, signal }) {
      const { LanguageModel, Proofreader } = scope;
      if (!LanguageModel) return state();
      // The language model is the large part: it carries the bar from 0 to 90%.
      await fetch(LanguageModel, io, signal, (fraction) => onProgress(fraction * 0.9));
      if (Proofreader) {
        const options = proofreaderOptions(lang);
        const answer = await Proofreader.availability(options).catch(() => 'unavailable');
        if (answer === 'downloadable' || answer === 'downloading') {
          await fetch(Proofreader, options, signal, (fraction) => onProgress(0.9 + fraction * 0.1)).catch((error: unknown) => {
            // The Prompt API alone does the cleanup: a Proofreader that will not come is no failure, a cancel is.
            if (error instanceof Error && error.name === 'AbortError') throw error;
          });
        }
      }
      onProgress(1);
      return state();
    },
  };
}
