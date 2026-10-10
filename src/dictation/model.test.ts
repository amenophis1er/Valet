import { describe, expect, it } from 'vitest';
import { onDeviceModel } from './model.js';

/** A built-in API that downloads in two steps, and can be cancelled midway. */
function api(initial: string) {
  let availability = initial;
  const created: unknown[] = [];
  return {
    created,
    set: (value: string) => { availability = value; },
    availability: async () => availability,
    create: async (options: { signal?: AbortSignal; monitor?: (m: { addEventListener(type: string, listener: (event: { loaded: number }) => void): void }) => void }) => {
      created.push(options);
      const listeners: Array<(event: { loaded: number }) => void> = [];
      options.monitor?.({ addEventListener: (_type, listener) => listeners.push(listener) });
      for (const loaded of [0.5, 1]) {
        await Promise.resolve();
        if (options.signal?.aborted) throw Object.assign(new Error('The download was cancelled.'), { name: 'AbortError' });
        for (const listener of listeners) listener({ loaded });
      }
      availability = 'available';
      return { destroy() {} };
    },
  };
}

describe('the built-in model', () => {
  it('tells what this device has', async () => {
    expect((await onDeviceModel('en-US', {}).state()).kind).toBe('unsupported');
    expect((await onDeviceModel('en-US', { LanguageModel: api('unavailable') }).state()).kind).toBe('unsupported');
    expect(await onDeviceModel('en-US', { LanguageModel: api('downloadable') }).state()).toEqual({ kind: 'downloadable' });
    expect(await onDeviceModel('en-US', { LanguageModel: api('downloading') }).state()).toEqual({ kind: 'downloading' });
    expect(await onDeviceModel('en-US', { LanguageModel: api('available') }).state()).toEqual({ kind: 'ready' });
  });

  it('downloads the language model, then the Proofreader\'s part, with progress from 0 to 1', async () => {
    const LanguageModel = api('downloadable');
    const Proofreader = api('downloadable');
    const progress: number[] = [];
    const state = await onDeviceModel('en-US', { LanguageModel, Proofreader }).download({ signal: new AbortController().signal, onProgress: (f) => progress.push(f) });
    expect(state).toEqual({ kind: 'ready' });
    expect(progress.map((f) => Math.round(f * 100))).toEqual([45, 90, 95, 100, 100]);
    expect(LanguageModel.created).toHaveLength(1);
    expect(Proofreader.created).toHaveLength(1);
  });

  it('is ready without a Proofreader: the language model alone does the cleanup', async () => {
    const state = await onDeviceModel('en-US', { LanguageModel: api('downloadable') }).download({ signal: new AbortController().signal, onProgress: () => undefined });
    expect(state).toEqual({ kind: 'ready' });
  });

  it('stops when cancelled, with an AbortError', async () => {
    const controller = new AbortController();
    const LanguageModel = api('downloadable');
    const download = onDeviceModel('en-US', { LanguageModel }).download({ signal: controller.signal, onProgress: () => controller.abort() });
    await expect(download).rejects.toMatchObject({ name: 'AbortError' });
    expect(await onDeviceModel('en-US', { LanguageModel }).state()).toEqual({ kind: 'downloadable' });
  });
});
