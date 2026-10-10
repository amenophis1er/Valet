/** Chrome prints one of the extension's pages: the tab and the debugger never outlive the call. */
import { describe, expect, it } from 'vitest';
import { printToPdf, type PdfChrome } from './pdf.js';

function fakeChrome(options: { state?: string; attachError?: string; printError?: string; hang?: boolean; neverLoads?: boolean } = {}) {
  const calls: string[] = [];
  const open = new Set<number>();
  let attached: number | undefined;
  let url = '';
  let polls = 0;
  const chrome: PdfChrome = {
    tabs: {
      async create(properties) { calls.push(`create ${properties.url} active=${properties.active}`); open.add(7); url = properties.url; return { id: 7 }; },
      // Loading for the first two looks: the initial blank page, then the document.
      async get(tabId) { polls += 1; if (polls === 1) calls.push(`get ${tabId}`); return polls < 3 || options.neverLoads ? { url: 'about:blank', status: 'loading' } : { url, status: 'complete' }; },
      async remove(ids) { calls.push(`remove ${ids.join(',')}`); for (const id of ids) open.delete(id); },
    },
    debugger: {
      async attach(target, version) { if (options.attachError) throw new Error(options.attachError); calls.push(`attach ${target.tabId} ${version}`); attached = target.tabId; },
      async detach(target) { calls.push(`detach ${target.tabId}`); attached = undefined; },
      async sendCommand(target, method, params) {
        calls.push(`${method} ${target.tabId}`);
        if (attached !== target.tabId) throw new Error('Debugger is not attached.');
        if (method === 'Runtime.evaluate') {
          expect(params).toMatchObject({ awaitPromise: true, returnByValue: true });
          if (options.hang) return new Promise(() => undefined);
          return { result: { value: options.state ?? 'ready' } };
        }
        if (method === 'Page.printToPDF') {
          expect(params).toMatchObject({ printBackground: true, preferCSSPageSize: true });
          if (options.printError) throw new Error(options.printError);
          return { data: 'JVBERi0=' };
        }
        throw new Error(`Unexpected ${method}`);
      },
    },
  };
  return { chrome, calls, open, attached: () => attached };
}

describe('printToPdf', () => {
  it('opens the page in a background tab, waits for it to say it is ready, prints, and closes everything', async () => {
    const f = fakeChrome();
    expect(await printToPdf(f.chrome, 'chrome-extension://x/document.html?id=file-1')).toBe('JVBERi0=');
    expect(f.calls).toEqual([
      'create chrome-extension://x/document.html?id=file-1 active=false', 'get 7',
      'attach 7 1.3', 'Runtime.evaluate 7', 'Page.printToPDF 7', 'detach 7', 'remove 7',
    ]);
    expect(f.open.size).toBe(0);
    expect(f.attached()).toBeUndefined();
  });

  it('fails, and still closes the tab, when the attach is refused, the document is gone, or printing fails', async () => {
    for (const [options, message] of [
      [{ attachError: 'Cannot attach to this target' }, /Cannot attach/],
      [{ state: 'gone' }, /no longer stored/],
      [{ printError: 'PrintToPDF is not implemented' }, /not implemented/],
    ] as const) {
      const f = fakeChrome(options);
      await expect(printToPdf(f.chrome, 'chrome-extension://x/document.html?id=file-1')).rejects.toThrow(message);
      expect(f.open.size).toBe(0);
      expect(f.calls.at(-1)).toBe('remove 7');
    }
  });

  it('gives up after the timeout when the page never loads or never becomes ready', async () => {
    for (const options of [{ hang: true }, { neverLoads: true }]) {
      const f = fakeChrome(options);
      await expect(printToPdf(f.chrome, 'chrome-extension://x/document.html?id=file-1', 20)).rejects.toThrow(/took too long/);
      expect(f.open.size).toBe(0);
      expect(f.attached()).toBeUndefined();
    }
  });
});
