/*
 * A PDF from one of the extension's own pages, made by Chrome itself.
 *
 * The worker has no DOM and the extension bundles no PDF library: it opens
 * document.html in a window of its own, minimized and unfocused, attaches the
 * debugger it already holds the permission for, asks Chrome to print the page
 * to PDF, and closes the window. Chrome's layout engine does the typesetting,
 * with the system's fonts, so anything the page can show ends up in the PDF.
 *
 * A window of its own, not a background tab in the owner's window: a tab
 * opened and closed beside the conversation's tab closed the open side panel
 * (the panel is per tab). Nothing happens in the owner's windows.
 */

export interface PdfChrome {
  windows: {
    create(properties: { url: string; focused: boolean; state: 'minimized' }): Promise<{ id?: number; tabs?: Array<{ id?: number }> }>;
    remove(windowId: number): Promise<void>;
  };
  tabs: {
    get(tabId: number): Promise<{ url?: string; status?: string }>;
  };
  debugger: {
    attach(target: { tabId: number }, version: string): Promise<void>;
    detach(target: { tabId: number }): Promise<void>;
    sendCommand(target: { tabId: number }, method: string, params?: unknown): Promise<unknown>;
  };
}

/** The document page says it is `ready` (rendered, fonts loaded) or `gone` (nothing stored under that id) here. */
export const STATE_ATTRIBUTE = 'data-state';
/** How long the whole thing may take before the file is given up on. */
const PRINT_TIMEOUT_MS = 15_000;

/** Waits, in the page, until document.ts has set its state; rejects if it never does. */
const READY = `new Promise((resolve, reject) => {
  const started = Date.now();
  const tick = () => {
    const state = document.documentElement.getAttribute(${JSON.stringify(STATE_ATTRIBUTE)});
    if (state) resolve(state);
    else if (Date.now() - started > 10000) reject(new Error('The document did not render in time.'));
    else setTimeout(tick, 25);
  };
  tick();
})`;

/**
 * The PDF of `url` (one of this extension's pages), as base64. The window is
 * closed and the debugger released whatever happens.
 */
export async function printToPdf(chrome: PdfChrome, url: string, timeoutMs = PRINT_TIMEOUT_MS): Promise<string> {
  const window = await chrome.windows.create({ url, focused: false, state: 'minimized' });
  const tabId = window.tabs?.[0]?.id;
  if (tabId === undefined) {
    if (window.id !== undefined) await chrome.windows.remove(window.id).catch(() => undefined);
    throw new Error('Chrome did not open the document.');
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Making the PDF took too long.')), timeoutMs); });
  try {
    return await Promise.race([expiry, print(chrome, tabId, url)]);
  } finally {
    clearTimeout(timer);
    await chrome.debugger.detach({ tabId }).catch(() => undefined);
    if (window.id !== undefined) await chrome.windows.remove(window.id).catch(() => undefined);
  }
}

/** Until the tab has finished loading the page: attached earlier, the debugger would evaluate in the blank page the navigation replaces. */
async function loaded(chrome: PdfChrome, tabId: number, url: string): Promise<void> {
  for (;;) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete' && tab.url === url) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function print(chrome: PdfChrome, tabId: number, url: string): Promise<string> {
  await loaded(chrome, tabId, url);
  await chrome.debugger.attach({ tabId }, '1.3');
  const send = (method: string, params?: unknown) => chrome.debugger.sendCommand({ tabId }, method, params);
  const ready = await send('Runtime.evaluate', { expression: READY, awaitPromise: true, returnByValue: true }) as
    { result?: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } } | undefined;
  if (ready?.exceptionDetails) throw new Error(ready.exceptionDetails.exception?.description ?? ready.exceptionDetails.text ?? 'The document did not render.');
  if (ready?.result?.value === 'gone') throw new Error('The document to print was no longer stored.');
  if (ready?.result?.value !== 'ready') throw new Error('The document did not render.');
  const printed = await send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true }) as { data?: string } | undefined;
  if (!printed?.data) throw new Error('Chrome returned no PDF.');
  return printed.data;
}
