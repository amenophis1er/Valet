/*
 * The composer's mic: Chrome's speech recognition, writing into the goal box
 * as the owner speaks. Nothing is sent until the owner presses Send.
 *
 * Where it can, recognition runs on this device (`processLocally`, newer
 * Chrome with the language pack installed). Otherwise Chrome sends the audio
 * to its speech service; the button's tooltip says which one is in use.
 *
 * The side panel cannot show the microphone prompt itself. The first time,
 * recognition fails with "not-allowed" and the panel opens mic.html in a tab,
 * where Chrome can ask; after that the extension has the permission.
 */

interface RecognitionResult { isFinal: boolean; 0: { transcript: string } }
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  processLocally?: boolean;
  start(): void;
  stop(): void;
  onresult: ((event: { resultIndex: number; results: ArrayLike<RecognitionResult> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}
interface RecognitionClass {
  new (): Recognition;
  available?(options: { langs: string[]; processLocally: boolean }): Promise<string>;
}

const Speech = (globalThis as unknown as { SpeechRecognition?: RecognitionClass; webkitSpeechRecognition?: RecognitionClass }).SpeechRecognition
  ?? (globalThis as unknown as { webkitSpeechRecognition?: RecognitionClass }).webkitSpeechRecognition;
const LANG = (globalThis.navigator?.language) || 'en-US';

/** Whether this device can recognize the owner's language without sending audio anywhere. */
let local = false;
void Speech?.available?.({ langs: [LANG], processLocally: true })
  .then((answer) => { local = answer === 'available'; })
  .catch(() => undefined);

export interface Dictation { stop(): void }

/**
 * Start listening. `onText` gets the words that became final since the last
 * call and the current guess; `onEnd` gets the error, if any. Nothing arrives
 * after `stop()`, even if Chrome still delivers a last result.
 */
export function startDictation(handlers: { onText(heard: string, guess: string): void; onEnd(error?: string): void }): Dictation | undefined {
  if (!Speech) return undefined;
  const recognition = new Speech();
  recognition.lang = LANG;
  recognition.continuous = true;
  recognition.interimResults = true;
  if (local) recognition.processLocally = true;
  let failure: string | undefined;
  let stopped = false;
  recognition.onresult = (event) => {
    if (stopped) return;
    let heard = '';
    let guess = '';
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i]!;
      if (result.isFinal) heard += result[0].transcript;
      else guess += result[0].transcript;
    }
    handlers.onText(heard, guess);
  };
  // "no-speech" and "aborted" are how a session normally ends; they are not worth a message.
  recognition.onerror = (event) => { if (event.error !== 'no-speech' && event.error !== 'aborted') failure = event.error; };
  recognition.onend = () => handlers.onEnd(failure);
  try {
    recognition.start();
  } catch {
    return undefined;
  }
  return { stop: () => { stopped = true; recognition.stop(); } };
}

startDictation.supported = (): boolean => !!Speech;
startDictation.describe = (): string => (local
  ? 'Dictate (recognized on this device)'
  : 'Dictate (Chrome sends the audio to its speech service to turn it into text)');
