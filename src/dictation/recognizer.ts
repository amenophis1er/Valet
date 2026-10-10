/*
 * Chrome's speech recognition, as a stream of settled text and the current
 * guess. Nothing here knows about fields or text rules.
 *
 * Where it can, recognition runs on this device (`processLocally`, newer
 * Chrome with the language pack installed). Otherwise Chrome sends the audio
 * to its speech service; `describe()` says which one is in use.
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
export interface RecognitionClass {
  new (): Recognition;
  available?(options: { langs: string[]; processLocally: boolean }): Promise<string>;
}

/** Chrome's own, or none (another browser, a test). */
export function chromeSpeech(): RecognitionClass | undefined {
  const scope = globalThis as unknown as { SpeechRecognition?: RecognitionClass; webkitSpeechRecognition?: RecognitionClass };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
}

export interface Listening { stop(): void }

export interface Recognizer {
  readonly lang: string;
  supported(): boolean;
  /** For a tooltip: whether audio stays on this device. */
  describe(): string;
  /**
   * Start listening. `onText` gets the words that became final since the last
   * call and the current guess; `onEnd` gets the error, if any. Nothing
   * arrives after `stop()`, even if Chrome still delivers a last result.
   */
  listen(handlers: { onText(heard: string, guess: string): void; onEnd(error?: string): void }): Listening | undefined;
}

export function createRecognizer(options: { lang: string; speech?: RecognitionClass | undefined }): Recognizer {
  const Speech = options.speech;
  const lang = options.lang;
  /** Whether this device can recognize the language without sending audio anywhere. */
  let local = false;
  void Speech?.available?.({ langs: [lang], processLocally: true })
    .then((answer) => { local = answer === 'available'; })
    .catch(() => undefined);

  return {
    lang,
    supported: () => !!Speech,
    describe: () => (local
      ? 'Dictate (recognized on this device)'
      : 'Dictate (Chrome sends the audio to its speech service to turn it into text)'),
    listen(handlers) {
      if (!Speech) return undefined;
      const recognition = new Speech();
      recognition.lang = lang;
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
    },
  };
}
