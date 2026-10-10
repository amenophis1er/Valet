/*
 * Dictation for a text field, self-contained: it imports nothing from the
 * rest of Valet (a layering rule keeps it so), and works in any extension
 * page with a textarea. See README.md.
 *
 *   const mic = dictation(textarea, { onInput: resize, onListening: (on) => button.ariaPressed = String(on) });
 *   button.hidden = !mic.supported();
 *   button.onclick = () => mic.toggle();
 */

import { attachDictation, type DictationController, type DictationOptions } from './field.js';
import { onDeviceProofread } from './proofread.js';
import { chromeSpeech, createRecognizer } from './recognizer.js';

export type { DictationController, DictationOptions } from './field.js';
export type { Proofread } from './proofread.js';
export type { RecognitionClass, Recognizer } from './recognizer.js';
export { attachDictation } from './field.js';
export { finish, sameWords, settle } from './polish.js';
export { onDeviceProofread } from './proofread.js';
export { onDeviceModel, type ModelState, type OnDeviceModel } from './model.js';
export { chromeSpeech, createRecognizer } from './recognizer.js';

/**
 * Chrome's speech recognition in the browser's language, the text rules, and
 * the on-device cleanup when the device has it. Every part can be replaced.
 */
export function dictation(field: HTMLTextAreaElement | HTMLInputElement, options: Partial<DictationOptions> & { lang?: string } = {}): DictationController {
  const { lang, ...rest } = options;
  return attachDictation(field, {
    recognizer: createRecognizer({ lang: lang || globalThis.navigator?.language || 'en-US', speech: chromeSpeech() }),
    proofread: onDeviceProofread(),
    ...rest,
  });
}
