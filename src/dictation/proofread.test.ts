import { describe, expect, it } from 'vitest';
import { onDeviceProofread } from './proofread.js';

const proofreader = (answer: string, availability = 'available') => ({
  availability: async () => availability,
  create: async () => ({ proofread: async () => ({ correctedInput: answer }) }),
});
const languageModel = (answer: string, availability = 'available') => ({
  availability: async () => availability,
  create: async () => ({ prompt: async () => answer }),
});

describe('the on-device cleanup', () => {
  it('takes the Proofreader\'s punctuation and casing', async () => {
    const proofread = onDeviceProofread({ Proofreader: proofreader('Hi, can you book it?') });
    expect(await proofread('hi can you book it', 'en-US')).toBe('Hi, can you book it?');
  });

  it('falls back to the Prompt API when there is no Proofreader', async () => {
    const proofread = onDeviceProofread({ LanguageModel: languageModel('Hi, can you book it?') });
    expect(await proofread('hi can you book it', 'en-US')).toBe('Hi, can you book it?');
  });

  it('throws away an answer that changed a word', async () => {
    const proofread = onDeviceProofread({ Proofreader: proofreader('Hello, could you book it?'), LanguageModel: languageModel('Sure! Hi, can you book it?') });
    expect(await proofread('hi can you book it', 'en-US')).toBeNull();
  });

  it('never downloads a model: only one that is ready is used', async () => {
    const proofread = onDeviceProofread({ Proofreader: proofreader('Hi.', 'downloadable'), LanguageModel: languageModel('Hi.', 'downloadable') });
    expect(await proofread('hi', 'en-US')).toBeNull();
  });

  it('is nothing without a built-in model, and survives one that throws', async () => {
    expect(await onDeviceProofread({})('hi', 'en-US')).toBeNull();
    const broken = { availability: async () => 'available', create: async () => { throw new Error('crashed'); } };
    expect(await onDeviceProofread({ Proofreader: broken, LanguageModel: broken })('hi', 'en-US')).toBeNull();
  });
});
