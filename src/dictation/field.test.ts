/**
 * @vitest-environment jsdom
 *
 * Dictation into a field with a scripted recognizer: what appears as words
 * settle, and what the end pass may and may not change.
 */
import { describe, expect, it } from 'vitest';
import { attachDictation } from './field.js';
import type { Proofread } from './proofread.js';
import type { Recognizer } from './recognizer.js';

function scripted() {
  let handlers: Parameters<Recognizer['listen']>[0] | undefined;
  const recognizer: Recognizer = {
    lang: 'en-US',
    supported: () => true,
    describe: () => 'Dictate',
    listen: (h) => { handlers = h; return { stop: () => handlers?.onEnd() }; },
  };
  return {
    recognizer,
    say: (heard: string, guess = '') => handlers!.onText(heard, guess),
    end: (error?: string) => handlers!.onEnd(error),
  };
}

function setup(proofread: Proofread | null = null, initial = '') {
  const field = document.createElement('textarea');
  field.value = initial;
  document.body.append(field);
  const speech = scripted();
  const events: string[] = [];
  const mic = attachDictation(field, { recognizer: speech.recognizer, proofread, onListening: (on) => events.push(on ? 'on' : 'off'), onEnd: (error) => events.push(`end ${error ?? ''}`.trim()) });
  return { field, speech, mic, events };
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('dictation into a field', () => {
  it('shows the guess live, writes settled phrases with sentence casing, and never adds a period at a pause', () => {
    const { field, speech, mic } = setup();
    mic.start();
    speech.say('', 'find flights');
    expect(field.value).toBe('find flights');
    speech.say('find flights to paris');
    expect(field.value).toBe('Find flights to paris');
    speech.say('', 'next fri');
    expect(field.value).toBe('Find flights to paris next fri');
    speech.say('next friday');
    expect(field.value).toBe('Find flights to paris next friday');
  });

  it('ends with a period or question mark once the owner stops', async () => {
    const { field, speech, mic, events } = setup();
    mic.start();
    speech.say('can you check the price');
    mic.stop();
    await settled();
    expect(field.value).toBe('Can you check the price?');
    expect(events).toEqual(['on', 'off', 'end']);
  });

  it('never touches what the owner typed before dictating', async () => {
    const proofread: Proofread = async () => 'Book it. then tell me, okay?';
    const { field, speech, mic } = setup(proofread, 'look at this page');
    mic.start();
    speech.say('book it then tell me okay');
    mic.stop();
    await settled();
    expect(field.value.startsWith('look at this page ')).toBe(true);
    expect(field.value).toBe('look at this page book it. then tell me, okay?');
  });

  it('takes the on-device cleanup when the stretch is unchanged', async () => {
    const proofread: Proofread = async (text) => (text === 'Book it then tell me okay.' ? 'Book it, then tell me. Okay?' : null);
    const { field, speech, mic } = setup(proofread);
    mic.start();
    speech.say('book it then tell me okay');
    mic.stop();
    await settled();
    expect(field.value).toBe('Book it, then tell me. Okay?');
  });

  it('keeps the owner\'s edit when they changed the text before the cleanup was ready', async () => {
    let answer: (value: string) => void = () => undefined;
    const proofread: Proofread = () => new Promise((resolve) => { answer = resolve; });
    const { field, speech, mic } = setup(proofread);
    mic.start();
    speech.say('book it');
    mic.stop();
    field.value = 'Book it now.';
    answer('Book it!');
    await settled();
    expect(field.value).toBe('Book it now.');
  });

  it('cleans nothing when the field was sent (emptied) as dictation ended', async () => {
    const proofread: Proofread = async () => 'Hello.';
    const { field, speech, mic } = setup(proofread);
    mic.start();
    speech.say('hello');
    field.value = '';
    mic.stop();
    await settled();
    expect(field.value).toBe('');
  });

  it('passes Chrome\'s error on, and reports listening off', () => {
    const { speech, mic, events } = setup();
    mic.start();
    speech.end('not-allowed');
    expect(events).toEqual(['on', 'off', 'end not-allowed']);
    expect(mic.listening).toBe(false);
  });
});
