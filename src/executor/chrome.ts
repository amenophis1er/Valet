/*
 * The slice of the Chrome extension API the executor uses, written out by
 * hand.
 *
 * `@types/chrome` would describe all of it, but it types every call as
 * available everywhere; naming the slice here also gives the tests something
 * to fake. `scripting` carries document ids (Chrome 106+).
 */

export interface TabInfo { id?: number; url?: string; pendingUrl?: string; title?: string; status?: string; windowId?: number; active?: boolean; index?: number; groupId?: number; pinned?: boolean }

export interface ChromeLike {
  tabs: {
    create(properties: { url: string; active?: boolean; windowId?: number; index?: number; openerTabId?: number }): Promise<TabInfo>;
    update(tabId: number, properties: { url?: string; active?: boolean }): Promise<TabInfo>;
    get(tabId: number): Promise<TabInfo>;
    remove(tabIds: number[]): Promise<void>;
    /** Into a group: an existing one, or a new one of these tabs. */
    group(options: { tabIds: number[]; groupId?: number }): Promise<number>;
    ungroup(tabIds: number[]): Promise<void>;
    goBack(tabId: number): Promise<void>;
    query(query: { windowId?: number }): Promise<TabInfo[]>;
    /** The visible part of a window's active tab, as a data URL. */
    captureVisibleTab?(windowId: number, options: { format: 'png' | 'jpeg' }): Promise<string>;
  };
  tabGroups: {
    update(groupId: number, properties: { title?: string; collapsed?: boolean; color?: string }): Promise<unknown>;
  };
  /** The frames of a tab, to inject into the page's own and never another extension's. Absent in tests: every frame then. */
  webNavigation?: {
    getAllFrames(details: { tabId: number }): Promise<Array<{ frameId: number; parentFrameId: number; url: string; documentId?: string }> | null>;
    /** One frame's current document: whether the main frame still holds the document that was observed. */
    getFrame?(details: { tabId: number; frameId: number }): Promise<{ url: string; documentId?: string } | null>;
  };
  /** Only to answer one question: is the owner looking at this tab right now? */
  windows: {
    get(windowId: number): Promise<{ id?: number; focused?: boolean }>;
  };
  scripting: {
    executeScript<Args extends unknown[] = [], Result = unknown>(injection: {
      /** One of `allFrames`, `frameIds` or `documentIds`. */
      target: { tabId: number; allFrames?: boolean; frameIds?: number[]; documentIds?: string[] };
      /** Either a function to serialize into the page, or a bundled file to inject. */
      func?: (...args: Args) => Result;
      files?: string[];
      args?: Args;
      world?: 'MAIN' | 'ISOLATED';
    }): Promise<Array<{ frameId: number; documentId?: string; result: Result }>>;
  };
  debugger: {
    attach(target: { tabId: number }, version: string): Promise<void>;
    detach(target: { tabId: number }): Promise<void>;
    sendCommand(target: { tabId: number }, method: string, params?: unknown): Promise<unknown>;
    /** Chrome took the debugger away: the tab closed, or the owner dismissed the yellow bar. */
    onDetach: { addListener(listener: (source: { tabId?: number }, reason?: string) => void): void };
  };
}

/** What the worker has; the same slice today. */
export type WorkerChrome = ChromeLike;
