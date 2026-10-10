/**
 * Targets, from both ends: the ref the model copied, and the role and name it
 * wrote instead. Chrome is a fake here; what is under test is which element a
 * command lands on and what it refuses.
 */
import { describe, expect, it, } from 'vitest';
import { BrowserCommands, type FrameList, type Imaging, type Rect } from './commands.js';
import type { WorkerChrome } from './chrome.js';
import { Cancellation, CancelledError, PreconditionError, type Command } from './protocol.js';
import type { CollectedElement } from './tree.js';

interface FrameResult { url: string; title: string; tree: string; elements: CollectedElement[]; scroll: { x: number; y: number }; origin?: string }

const PAGE: FrameResult = {
  url: 'https://example.test/', title: 'Example', scroll: { x: 0, y: 0 }, origin: 'https://example.test',
  tree: '- main\n  - link "Sign in" [ref=l1]\n  - button "Sign in" [ref=l2]\n  - textbox "Email" [ref=l3]\n  - link "Docs" [ref=l4]',
  elements: [
    { id: 'l1', role: 'link', name: 'Sign in', href: 'https://example.test/in' },
    { id: 'l2', role: 'button', name: 'Sign in' },
    { id: 'l3', role: 'textbox', name: 'Email' },
    { id: 'l4', role: 'link', name: ' Docs ' },
  ],
};

interface FakeTab { id: number; url: string; title: string; status: string; groupId: number; windowId: number; active: boolean; index?: number; pinned?: boolean; openerTabId?: number }

type DebuggerDetach = (source: { tabId?: number }, reason?: string) => void;

type FrameAnswer = { frameId: number; documentId?: string; result: FrameResult | null };

function fakeChrome(frames: FrameAnswer[] = [{ frameId: 0, documentId: 'doc-0', result: structuredClone(PAGE) }]) {
  const located: string[] = [];
  const dispatched: string[] = [];
  const sent: Array<{ method: string; params?: unknown }> = [];
  const attachments: number[] = [];
  /** The groupId each tabs.group call asked for (null: a new group). */
  /** Groups already titled valet in the window, as after a worker restart. */
  /** Every injection's target, with what was injected. */
  const targets: Array<{ frameIds?: number[]; documentIds?: string[]; allFrames?: boolean; what: string }> = [];
  /** Document ids whose frame has navigated away: a script aimed at one fails. */
  const goneDocuments = new Set<string>();
  const detaches: DebuggerDetach[] = [];
  const injected: string[] = [];
  const tabs = new Map<number, FakeTab>();
  const windows = new Map<number, { id: number; focused: boolean }>([[1, { id: 1, focused: true }]]);
  const failures: { attach?: string; /** The nth debugger command (1-based) fails with this. */ commandFails?: { at: number; message: string } } = {};
  let commands = 0;
  /*
   * What the page side answers when the worker locates an element it is about
   * to act on. Tests mutate it to play a moved page.
   */
  const field = { ok: true, reason: undefined as string | undefined, point: { x: 10, y: 20 }, password: false, name: 'Email', keyByKey: false, multiline: false };
  /* What the next reads of the page answer, in turn, before falling back to `frames`; and its load state. */
  const page = { answers: [] as FrameAnswer[][], readyState: 'complete',
    /* What listing the page's frame elements answers, in turn (the last one repeats); and every frame's real origin. */
    frameLists: [{ viewport: { width: 1000, height: 800 }, frames: [] }] as FrameList[], origins: ['https://example.test'] as string[],
    /* Origins answered by the next probes, in turn, before falling back to `origins`. */
    originSequence: [] as string[][],
    /* The viewport sizes the page reports, in turn (the last one repeats). */
    viewports: ['1000x800'] as string[],
    /* Where a subframe's document sits in the viewport; null past a frame from another site. */
    frameOffset: { x: 100, y: 50 } as { x: number; y: number } | null,
    painted: [] as boolean[],
    /* Every overlay paint, whole. */
    paints: [] as Array<{ halo: boolean; cursor?: unknown; note?: unknown }> };
  let nextTabId = 100;
  let nextGroupId = 6;
  const groupCalls: number[][] = [];
  const ungrouped: number[] = [];
  const groupTitles: string[] = [];
  const chrome = {
    tabs: {
      async create({ url, openerTabId, index }: { url: string; openerTabId?: number; index?: number }) {
        const tab = { id: (nextTabId += 1), url, title: 'Example', status: 'complete', groupId: -1, windowId: 1, active: false, openerTabId, index: index ?? tabs.size, pinned: false };
        tabs.set(tab.id, tab);
        return tab;
      },
      // Groups: a new one gets the next id from 7; the fake moves nothing.
      async group({ tabIds, groupId }: { tabIds: number[]; groupId?: number }) {
        for (const id of tabIds) if (tabs.get(id)!.pinned) throw new Error('Pinned tabs cannot be grouped');
        const into = groupId ?? (nextGroupId += 1);
        for (const id of tabIds) tabs.get(id)!.groupId = into;
        groupCalls.push([...tabIds]);
        return into;
      },
      async ungroup(ids: number[]) { for (const id of ids) { tabs.get(id)!.groupId = -1; ungrouped.push(id); } },
      async update(id: number, { url }: { url?: string }) { const tab = tabs.get(id)!; if (url) tab.url = url; return tab; },
      async get(id: number) { const tab = tabs.get(id); if (!tab) throw new Error('no such tab'); return tab; },
      async remove(ids: number[]) { for (const id of ids) tabs.delete(id); },
      async query() { return [...tabs.values()]; },
      async captureVisibleTab() { dispatched.push('captureVisibleTab'); return 'data:image/png;base64,VklTSUJMRQ=='; },
    },
    tabGroups: { async update(_id: number, { title }: { title?: string }) { if (title) groupTitles.push(title); return {}; } },
    windows: { async get(id: number) { const found = windows.get(id); if (!found) throw new Error('no such window'); return found; } },
    scripting: {
      async executeScript(injection: { target: { frameIds?: number[]; documentIds?: string[]; allFrames?: boolean }; files?: string[]; func?: { name: string } }) {
        targets.push({ ...injection.target, what: injection.files ? 'content' : injection.func?.name ?? '' });
        if (injection.files) { injected.push(injection.files.join(',')); return []; }
        if (injection.func?.name === 'readReadyState') return [{ frameId: 0, result: page.readyState }];
        if (injection.func?.name === 'readViewport') return [{ frameId: 0, result: page.viewports.length > 1 ? page.viewports.shift() : page.viewports[0] }];
        if (injection.func?.name === 'readOrigin') return (page.originSequence.shift() ?? page.origins).map((origin, frameId) => ({ frameId, documentId: `doc-${frameId}-${origin}`, result: origin }));
        if (injection.func?.name === 'listFrames') return [{ frameId: 0, result: page.frameLists.length > 1 ? page.frameLists.shift() : page.frameLists[0] }];
        if (injection.func?.name === 'frameOffsetRef') return [{ frameId: injection.target.frameIds?.[0] ?? 0, result: page.frameOffset }];
        if (injection.func?.name === 'paintOverlay') { const state = (injection as unknown as { args: [{ halo: boolean; cursor?: unknown; note?: unknown }] }).args[0]; page.painted.push(state.halo); page.paints.push(state); return []; }
        if (injection.func?.name === 'readObservation') return page.answers.length > 0 ? page.answers.shift()! : frames;
        if (injection.target.documentIds) {
          const documentId = injection.target.documentIds[0]!;
          if (goneDocuments.has(documentId)) throw new Error('No document with id');
          located.push(documentId);
          return [{ frameId: 0, documentId, result: field }];
        }
        if (injection.target.frameIds) {
          located.push(String(injection.target.frameIds[0]));
          return [{ frameId: injection.target.frameIds[0]!, result: field }];
        }
        return frames;
      },
    },
    debugger: {
      async attach({ tabId }: { tabId: number }) { if (failures.attach) throw new Error(failures.attach); attachments.push(tabId); },
      async detach() { dispatched.push('detach'); },
      async sendCommand(_target: unknown, method: string, params?: unknown) {
        commands += 1;
        if (failures.commandFails && commands === failures.commandFails.at) throw new Error(failures.commandFails.message);
        dispatched.push(method);
        sent.push({ method, params });
        return { data: 'iVBORw0KGgo=' };
      },
      onDetach: { addListener(listener: DebuggerDetach) { detaches.push(listener); } },
    },
  } as unknown as WorkerChrome;
  return { chrome, located, dispatched, sent, attachments, detaches, injected, tabs, windows, failures, field, page, goneDocuments, targets, groupCalls, ungrouped, groupTitles };
}

const command = (name: Command['name'], args: Record<string, unknown> = {}): Command => ({ id: 'c1', name, session: 's1', args });

async function opened(frames?: FrameAnswer[]) {
  const fake = fakeChrome(frames);
  const waits: number[] = [];
  const masks: Rect[][] = [];
  const imaging: Imaging = async (png, _viewport, painted) => { masks.push(painted); return { data: `jpeg:${png}`, width: 1000, height: 800 }; };
  const commands = new BrowserCommands(fake.chrome, { uuid: () => 'fixed-uuid-value', wait: async (ms) => { waits.push(ms); }, imaging, random: () => 0.5 });
  await commands.run(command('navigate', { url: 'https://example.test/' }));
  return { ...fake, commands, waits, masks };
}

describe('observing', () => {
  it('numbers refs across the observation and reports them as targets', async () => {
    const { commands } = await opened();
    const { observation } = await commands.run(command('observe'));
    expect(observation!.targets!.map((target) => [target.ref, target.role, target.name])).toEqual([
      ['e1', 'link', 'Sign in'], ['e2', 'button', 'Sign in'], ['e3', 'textbox', 'Email'], ['e4', 'link', ' Docs '],
    ]);
    expect(observation!.tree).toContain('- link "Sign in" [ref=e1]');
    expect(observation!.tree).toContain('Frame 0 (https://example.test/)');
    expect(observation!.tree).toContain('Scroll: 0, 0');
    expect(observation!.tabs).toHaveLength(1);
  });
});

describe('targets', () => {
  it('acts on the ref the model copied', async () => {
    const { commands, dispatched } = await opened();
    await commands.run(command('observe'));
    await commands.run(command('click', { target: { ref: 'e2' } }));
    expect(dispatched).toEqual(['Input.dispatchMouseEvent', 'Input.dispatchMouseEvent', 'Input.dispatchMouseEvent', 'detach']);
  });

  it('resolves a role and a name against the last observation', async () => {
    const { commands } = await opened();
    await commands.run(command('observe'));
    await expect(commands.run(command('click', { target: { by: 'role', role: 'link', name: 'Sign in' } }))).resolves.toEqual({});
  });

  it('ignores case and surrounding space in the name', async () => {
    const { commands } = await opened();
    await commands.run(command('observe'));
    await expect(commands.run(command('click', { target: { by: 'role', role: 'link', name: 'docs' } }))).resolves.toEqual({});
  });

  it('takes by:"link" as the shorthand for a link', async () => {
    const { commands } = await opened();
    await commands.run(command('observe'));
    await expect(commands.run(command('click', { target: { by: 'link', name: 'Docs' } }))).resolves.toEqual({});
  });

  it('matches a label, a placeholder and a text target against the accessible name', async () => {
    const { commands } = await opened();
    await commands.run(command('observe'));
    await expect(commands.run(command('fill', { target: { by: 'label', name: 'Email' }, value: 'a@b.test' }))).resolves.toEqual({});
    await expect(commands.run(command('click', { target: { by: 'text', name: 'Docs' } }))).resolves.toEqual({});
  });

  it('refuses a name that is not on the page, without dispatching anything', async () => {
    const { commands, dispatched } = await opened();
    await commands.run(command('observe'));
    await expect(commands.run(command('click', { target: { by: 'role', role: 'button', name: 'Checkout' } })))
      .rejects.toThrow(/No button named Checkout in the last observation/);
    expect(dispatched).toEqual([]);
  });

  it('refuses an ambiguous label and says which refs to choose between', async () => {
    const { commands } = await opened();
    await commands.run(command('observe'));
    const failure = await commands.run(command('click', { target: { by: 'text', name: 'Sign in' } })).catch((error) => error);
    expect(failure).toBeInstanceOf(PreconditionError);
    expect(String(failure.message)).toBe('More than one element named Sign in in the last observation (e1, e2). Use one of those refs.');
  });

  it('refuses a coordinate target', async () => {
    const { commands } = await opened();
    await commands.run(command('observe'));
    await expect(commands.run(command('click', { target: { x: 10, y: 20 } }))).rejects.toThrow(/Coordinate targets are not supported/);
  });

  it('refuses any target before the first observation', async () => {
    const { commands } = await opened();
    await expect(commands.run(command('click', { target: { ref: 'e1' } }))).rejects.toThrow(/Stale page observation/);
    await expect(commands.run(command('click', { target: { by: 'role', role: 'link', name: 'Sign in' } }))).rejects.toThrow(/Stale page observation/);
  });

  it('refuses a target with neither a ref nor a name', async () => {
    const { commands } = await opened();
    await commands.run(command('observe'));
    await expect(commands.run(command('click', {}))).rejects.toThrow(/Use a ref from the latest observation.targets/);
  });

  it('keeps a semantic target inside the frame it names', async () => {
    const second: FrameResult = { url: 'https://example.test/frame', title: '', scroll: { x: 0, y: 0 },
      tree: '- button "Only here" [ref=l1]', elements: [{ id: 'l1', role: 'button', name: 'Only here' }] };
    const { commands } = await opened([
      { frameId: 0, result: structuredClone(PAGE) },
      { frameId: 4, result: second },
    ]);
    await commands.run(command('observe'));
    await expect(commands.run(command('click', { target: { by: 'role', role: 'button', name: 'Only here' } })))
      .rejects.toThrow(/No button named Only here in the last observation/);
    await expect(commands.run(command('click', { target: { by: 'role', role: 'button', name: 'Only here', frame: 1 } }))).resolves.toEqual({});
  });
});

describe('the session', () => {
  it('closes the tabs it opened and forgets the refs', async () => {
    const { commands, tabs } = await opened();
    await commands.run(command('observe'));
    expect(tabs.size).toBe(1);
    await commands.run(command('close'));
    expect(tabs.size).toBe(0);
    await expect(commands.run(command('click', { target: { ref: 'e1' } }))).rejects.toThrow(/Stale page observation/);
  });

  it('screenshots the tab of the session through the debugger', async () => {
    const { commands, dispatched } = await opened();
    const { screenshot } = await commands.run(command('screenshot'));
    expect(screenshot).toBe('jpeg:iVBORw0KGgo=');
    expect(dispatched).toContain('Page.captureScreenshot');
  });

  const frame = (id: number, origin: string | null, readable = false) => ({ id, x: 10 * id, y: 20, w: 100, h: 50, readable, origin });

  it('paints over frames it cannot vouch for, and leaves allowed ones and same-origin ones', async () => {
    const { commands, page, masks } = await opened();
    page.origins = ['https://example.test', 'https://maps.test', 'https://example.test', 'https://maps.test'];
    // An opaque (sandboxed) frame has no origin to allow: it is painted over.
    page.frameLists = [{ viewport: { width: 1000, height: 800 }, frames: [frame(1, null), frame(2, 'https://maps.test'), frame(3, 'https://example.test', true)] }];
    const allowed = new Set(['https://example.test', 'https://maps.test']);
    const shot = await commands.capture('s1', undefined, (origin) => allowed.has(origin));
    expect(shot).toMatchObject({ data: 'jpeg:iVBORw0KGgo=', mediaType: 'image/jpeg', masked: 1 });
    expect(masks[0]).toEqual([{ x: 10, y: 20, w: 100, h: 50 }]);
  });

  it('paints over every cross-origin frame when any frame has gone somewhere outside the run', async () => {
    const { commands, page, masks } = await opened();
    // The maps frame's element still says maps.test, but some frame is now on ads.test.
    page.origins = ['https://example.test', 'https://ads.test'];
    page.frameLists = [{ viewport: { width: 1000, height: 800 }, frames: [frame(2, 'https://maps.test')] }];
    await commands.capture('s1', undefined, (origin) => origin !== 'https://ads.test');
    expect(masks[0]).toHaveLength(1);
  });

  it('keeps nothing when a frame navigated somewhere else during the capture', async () => {
    const { commands, page, masks } = await opened();
    page.frameLists = [{ viewport: { width: 1000, height: 800 }, frames: [frame(2, 'https://maps.test')] }];
    page.originSequence = [['https://example.test', 'https://maps.test'], ['https://example.test', 'https://ads.test']];
    await expect(commands.capture('s1', undefined, (origin) => origin !== 'https://ads.test')).rejects.toThrow(/changing while the screenshot was taken/);
    expect(masks).toHaveLength(0);
  });

  it('keeps nothing when the page itself navigated during the capture', async () => {
    const { commands, page, masks } = await opened();
    page.originSequence = [['https://example.test'], ['https://evil.test']];
    await expect(commands.capture('s1', undefined, (origin) => origin === 'https://example.test')).rejects.toThrow(/changing while the screenshot was taken/);
    expect(masks).toHaveLength(0);
  });

  it('keeps nothing when the page has more frames than it could locate', async () => {
    const { commands, page, masks } = await opened();
    page.origins = ['https://example.test', 'https://ads.test'];
    await expect(commands.capture('s1', undefined, () => true)).rejects.toThrow(/cannot locate/);
    expect(masks).toHaveLength(0);
  });

  it('paints over the whole outer frame when a frame inside a same-origin frame needs painting', async () => {
    const { commands, page, masks } = await opened();
    page.origins = ['https://example.test', 'https://example.test', 'https://ads.test'];
    page.frameLists = [{ viewport: { width: 1000, height: 800 }, frames: [frame(3, 'https://example.test', true), { ...frame(4, 'https://ads.test'), within: 3 }] }];
    await commands.capture('s1', undefined, (origin) => origin === 'https://example.test');
    expect(masks[0]).toEqual([{ x: 30, y: 20, w: 100, h: 50 }]);
  });

  it('reads the page only once the debugger bar has appeared and the page stopped resizing', async () => {
    const { commands, page, waits, attachments, dispatched } = await opened();
    // Attaching shows Chrome's bar: the page is 800 high, then 760, then stays there.
    page.viewports = ['1000x800', '1000x760', '1000x760'];
    const shot = await commands.capture('s1', undefined, () => true);
    expect(shot.data).toBe('jpeg:iVBORw0KGgo=');
    expect(waits.filter((ms) => ms === 120)).toHaveLength(2);
    // The debugger was attached before the first reading, and released after the second.
    expect(attachments.length).toBeGreaterThan(0);
    expect(dispatched.indexOf('Page.captureScreenshot')).toBeLessThan(dispatched.lastIndexOf('detach'));
  });

  it('keeps nothing when the frames moved during the capture', async () => {
    const { commands, page, masks } = await opened();
    page.frameLists = [
      { viewport: { width: 1000, height: 800 }, frames: [frame(1, 'https://ads.test')] },
      { viewport: { width: 1000, height: 800 }, frames: [{ ...frame(1, 'https://ads.test'), y: 300 }] },
    ];
    await expect(commands.capture('s1', undefined, () => true)).rejects.toThrow(/changing while the screenshot was taken/);
    expect(masks).toHaveLength(0);
  });

  it('refuses a tab on a site outside the run before capturing anything', async () => {
    const { commands, dispatched } = await opened();
    await expect(commands.capture('s1', undefined, () => false)).rejects.toThrow(/not allowed for this run/);
    expect(dispatched).not.toContain('Page.captureScreenshot');
  });

  it('captures the owner\'s active tab without the debugger, and a background one with it, unmasked', async () => {
    const { commands, tabs, dispatched, masks } = await opened();
    const tab = [...tabs.values()][0]!;
    tab.active = true;
    expect(await commands.captureTab(tab.id)).toMatchObject({ data: 'jpeg:VklTSUJMRQ==', title: 'Example' });
    expect(dispatched).not.toContain('Page.captureScreenshot');
    tab.active = false;
    expect(await commands.captureTab(tab.id)).toMatchObject({ data: 'jpeg:iVBORw0KGgo=' });
    expect(dispatched).toContain('Page.captureScreenshot');
    expect(masks).toEqual([[], []]);
  });

  it('refuses to capture a tab that is not a web page, or is gone', async () => {
    const { commands, tabs } = await opened();
    const tab = [...tabs.values()][0]!;
    tab.url = 'chrome://settings/';
    await expect(commands.captureTab(tab.id)).rejects.toThrow(/Only http and https/);
    await expect(commands.captureTab(9999)).rejects.toThrow(/That tab is gone/);
  });

  it('lifts the halo and the cursor for the capture and puts the halo back', async () => {
    const { commands, page } = await opened();
    await commands.highlight('s1', true);
    page.painted.length = 0;
    await commands.capture('s1', undefined, () => true);
    expect(page.painted).toEqual([false, true]);
  });
});

describe('the owner’s tabs', () => {
  it('acts in its own tab while the owner watches it', async () => {
    const { commands, tabs, dispatched } = await opened();
    await commands.run(command('observe'));
    [...tabs.values()][0]!.active = true;
    await commands.run(command('click', { target: { ref: 'e1' } }));
    expect(dispatched).toContain('Input.dispatchMouseEvent');
  });

  it('acts in an active tab whose window is not focused', async () => {
    const { commands, tabs, windows } = await opened();
    await commands.run(command('observe'));
    [...tabs.values()][0]!.active = true;
    windows.get(1)!.focused = false;
    await expect(commands.run(command('click', { target: { ref: 'e1' } }))).resolves.toEqual({});
  });

  it('navigate with newTab opens a second tab right after the first, in the conversation\'s group with the owner\'s tab, and works there', async () => {
    const fake = fakeChrome();
    let n = 0;
    const commands = new BrowserCommands(fake.chrome, { uuid: () => `uuid-${n += 1}-xxxxxxxxxx`, wait: async () => undefined, imaging: async () => ({ data: '', width: 1, height: 1 }), anchor: () => 999 });
    const origin = { id: 999, url: 'https://example.test/origin', title: 'Origin', status: 'complete', groupId: -1, windowId: 4, active: true, index: 3, pinned: false };
    fake.tabs.set(origin.id, origin);
    await commands.run(command('navigate', { url: 'https://example.test/' }));
    await commands.run(command('navigate', { url: 'https://example.test/second', newTab: true }));
    // Right after the owner's tab, one after the other, in its window; the owner's tab and both in one group named valet.
    expect([...fake.tabs.values()].filter((tab) => tab.id !== 999).map((tab) => [tab.url, (tab as { index?: number }).index, tab.groupId])).toEqual([['https://example.test/', 4, 7], ['https://example.test/second', 5, 7]]);
    expect(origin.groupId).toBe(7);
    expect(fake.groupCalls).toEqual([[999, 101], [102]]);
    expect(fake.groupTitles).toEqual(['valet']);
    expect(commands.tabIds('s1')).toHaveLength(2);
    // The new tab is where it works now.
    expect((await commands.workspace('s1'))?.url).toBe('https://example.test/second');
    // close takes the agent's tabs away and puts the owner's tab back out of the group.
    await commands.run(command('close'));
    expect(fake.tabs.size).toBe(1);
    expect(origin.groupId).toBe(-1);
    expect(fake.ungrouped).toEqual([999]);
  });

  it('forgets sessions and refs on reset, and leaves the tabs open', async () => {
    const { commands, tabs } = await opened();
    await commands.run(command('observe'));
    commands.reset();
    expect(tabs.size).toBe(1);
    await expect(commands.run(command('click', { target: { ref: 'e1' } }))).rejects.toThrow(/Stale page observation/);
  });
});

describe('what a ref is bound to', () => {
  it('refuses a ref whose page has moved on, and an untargeted scroll after it', async () => {
    const { commands, tabs, dispatched } = await opened();
    await commands.run(command('observe'));
    [...tabs.values()][0]!.url = 'https://example.test/elsewhere';
    await expect(commands.run(command('click', { target: { ref: 'e1' } }))).rejects.toThrow(/has changed since that observation/);
    await expect(commands.run(command('scroll', { direction: 'down' }))).rejects.toThrow(/has changed since that observation/);
    expect(dispatched).toEqual([]);
  });

  it('still acts when only the fragment changed: a map or a hash router stays on its document', async () => {
    const { commands, tabs, dispatched } = await opened();
    await commands.run(command('observe'));
    [...tabs.values()][0]!.url = 'https://example.test/#map=5/38.00/-95.82';
    await commands.run(command('click', { target: { ref: 'e1' } }));
    expect(dispatched.length).toBeGreaterThan(0);
  });

  it('refuses a scroll before the first observation', async () => {
    const { commands } = await opened();
    await expect(commands.run(command('scroll', { direction: 'down' }))).rejects.toThrow(/Stale page observation/);
  });

  it('refuses a tab that is no longer http', async () => {
    const { commands, tabs } = await opened();
    await commands.run(command('observe'));
    [...tabs.values()][0]!.url = 'chrome://settings';
    await expect(commands.run(command('click', { target: { ref: 'e1' } }))).rejects.toThrow(/http and https/);
  });
});

describe('what the page answers', () => {
  it('reads the main frame by its id, whatever order the frames answered in', async () => {
    const second: FrameResult = { url: 'https://example.test/frame', title: '', scroll: { x: 0, y: 0 },
      tree: '- button "Only here" [ref=l1]', elements: [{ id: 'l1', role: 'button', name: 'Only here' }] };
    const { commands } = await opened([{ frameId: 9, result: second }, { frameId: 0, result: structuredClone(PAGE) }]);
    const { observation } = await commands.run(command('observe'));
    expect(observation!.url).toBe('https://example.test/');
    expect(observation!.tree.startsWith('Frame 0 (https://example.test/)')).toBe(true);
    expect(observation!.targets![0]).toMatchObject({ ref: 'e1', name: 'Sign in' });
  });

  it('has no observation to give when the main frame did not answer three more times', async () => {
    const { commands, waits, injected } = await opened([{ frameId: 9, result: structuredClone(PAGE) }]);
    await expect(commands.run(command('observe'))).rejects.toThrow(
      new PreconditionError('The page has not answered after three tries. Wait a few seconds and observe again.'));
    expect(waits).toEqual([500, 1_000, 2_000]);
    expect(injected).toHaveLength(4);
  });

  it('says the page is still loading when it is', async () => {
    const { commands, page } = await opened([{ frameId: 0, result: null }]);
    page.readyState = 'loading';
    await expect(commands.run(command('observe'))).rejects.toThrow(/after three tries\. The page is still loading\. Wait a few seconds/);
  });

  it('injects the page side again and reads the page once it answers', async () => {
    const { commands, waits, injected, page } = await opened();
    page.answers.push([{ frameId: 0, result: null }]);
    const { observation } = await commands.run(command('observe'));
    expect(observation!.url).toBe('https://example.test/');
    expect(waits).toEqual([500]);
    expect(injected).toEqual(['content.js', 'content.js']);
  });

  it('reads the page when it answers on a later try', async () => {
    const { commands, waits, page } = await opened();
    page.answers.push([], [{ frameId: 0, result: null }]);
    const { observation } = await commands.run(command('observe'));
    expect(observation!.targets).toHaveLength(4);
    expect(waits).toEqual([500, 1_000]);
  });

  it('stops retrying when the command is cancelled', async () => {
    const fake = fakeChrome([{ frameId: 0, result: null }]);
    const cancel = new Cancellation();
    const commands = new BrowserCommands(fake.chrome, { uuid: () => 'fixed-uuid-value', wait: async () => { cancel.cancel(); } });
    await commands.run(command('navigate', { url: 'https://example.test/' }));
    await expect(commands.run(command('observe'), cancel)).rejects.toBeInstanceOf(CancelledError);
  });

  it('strips the refs it had no room to number instead of leaving them in the tree', async () => {
    const many: FrameResult = { url: 'https://example.test/', title: 'Many', scroll: { x: 0, y: 0 },
      tree: Array.from({ length: 245 }, (_, i) => `- link "Row ${i + 1}" [ref=l${i + 1}]`).join('\n'),
      elements: Array.from({ length: 245 }, (_, i) => ({ id: `l${i + 1}`, role: 'link', name: `Row ${i + 1}` })) };
    const { commands } = await opened([{ frameId: 0, result: many }]);
    const { observation } = await commands.run(command('observe'));
    expect(observation!.targets).toHaveLength(240);
    expect(observation!.tree).toContain('- link "Row 240" [ref=e240]');
    expect(observation!.tree).toContain('- link "Row 241"');
    expect(observation!.tree).not.toMatch(/\[ref=l\d+\]/);
  });

  it('calls a debugger that will not attach a precondition failure', async () => {
    const { commands, failures } = await opened();
    await commands.run(command('observe'));
    failures.attach = 'Another debugger is already attached';
    const failure = await commands.run(command('click', { target: { ref: 'e1' } })).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PreconditionError);
    expect(String((failure as Error).message)).toMatch(/Close DevTools on it/);
  });
});

describe('cancelling', () => {
  it('stops before the next step and reports whether anything was dispatched', async () => {
    const { commands, dispatched } = await opened();
    await commands.run(command('observe'));
    const cancel = new Cancellation();
    cancel.cancel();
    await expect(commands.run(command('click', { target: { ref: 'e1' } }), cancel)).rejects.toBeInstanceOf(CancelledError);
    expect(cancel.dispatched).toBe(false);
    expect(dispatched).toEqual([]);
  });

  it('detaches the debugger even when the command is cancelled mid-flight', async () => {
    const { commands, chrome, dispatched } = await opened();
    await commands.run(command('observe'));
    const cancel = new Cancellation();
    // The tab dies just as the first input event goes out.
    chrome.debugger.sendCommand = async () => { cancel.cancel(); throw new Error('the tab went away'); };
    await expect(commands.run(command('click', { target: { ref: 'e1' } }), cancel)).rejects.toThrow();
    expect(cancel.dispatched).toBe(true);
    expect(dispatched).toContain('detach');
  });
});

describe('waiting for what the input started', () => {
  it('waits for the navigation a click starts, instead of returning on the old page', async () => {
    const { commands, chrome, tabs } = await opened();
    await commands.run(command('observe'));
    const tab = [...tabs.values()][0]!;
    let loaded = false;
    // A real click that submits leaves `status` at `complete` for a moment and
    // only then starts loading the next page.
    chrome.debugger.sendCommand = async () => {
      setTimeout(() => { tab.status = 'loading'; tab.url = 'https://example.test/next'; }, 20);
      setTimeout(() => { tab.status = 'complete'; loaded = true; }, 260);
      return {};
    };
    await commands.run(command('click', { target: { ref: 'e1' } }));
    expect(loaded).toBe(true);
    expect(tab.url).toBe('https://example.test/next');
  });
});

describe('watched tabs, stops and frames', () => {
  it('navigates its own tab while the owner watches it, rather than opening another', async () => {
    const { commands, tabs } = await opened();
    const tab = [...tabs.values()][0]!;
    tab.active = true;
    await commands.run(command('navigate', { url: 'https://example.test/other' }));
    expect(tab.url).toBe('https://example.test/other');
    expect(tabs.size).toBe(1);
  });

  it('keeps a watched tab open on close instead of removing it', async () => {
    // Removing unwatched tabs is covered by "closes the tabs it opened".
    const { commands, tabs } = await opened();
    const tab = [...tabs.values()][0]!;
    await commands.run(command('observe'));
    tab.active = true;
    await commands.run(command('close'));
    expect(tabs.has(tab.id)).toBe(true);
  });

  it('stops a click between the hover and the press, and says something was dispatched', async () => {
    const { commands, chrome, sent } = await opened();
    await commands.run(command('observe'));
    const cancel = new Cancellation();
    const original = chrome.debugger.sendCommand;
    chrome.debugger.sendCommand = async (target, method, params) => {
      const answer = await original(target, method, params);
      if ((params as { type?: string } | undefined)?.type === 'mouseMoved') cancel.cancel();
      return answer;
    };
    await expect(commands.run(command('click', { target: { ref: 'e1' } }), cancel)).rejects.toBeInstanceOf(CancelledError);
    expect(sent.map(({ params }) => (params as { type: string }).type)).toEqual(['mouseMoved']);
    expect(cancel.dispatched).toBe(true);
  });

  it('always releases a mouse button it pressed, even when stopped', async () => {
    const { commands, chrome, sent } = await opened();
    await commands.run(command('observe'));
    const cancel = new Cancellation();
    const original = chrome.debugger.sendCommand;
    chrome.debugger.sendCommand = async (target, method, params) => {
      const answer = await original(target, method, params);
      if ((params as { type?: string } | undefined)?.type === 'mousePressed') cancel.cancel();
      return answer;
    };
    await commands.run(command('click', { target: { ref: 'e1' } }), cancel);
    expect(sent.map(({ params }) => (params as { type: string }).type)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased']);
  });

  it('reports each frame with its document and origin, for the run controller', async () => {
    const second: FrameResult = { url: 'https://ads.test/frame', title: '', scroll: { x: 0, y: 0 }, origin: 'https://ads.test',
      tree: '- button "Buy" [ref=l1]', elements: [{ id: 'l1', role: 'button', name: 'Buy' }] };
    const { commands } = await opened([
      { frameId: 0, documentId: 'doc-0', result: structuredClone(PAGE) },
      { frameId: 4, documentId: 'doc-4', result: second },
      { frameId: 5, documentId: 'doc-5', result: null },
    ]);
    const observation = await commands.observe('s1');
    expect(observation.frames).toEqual([
      { index: 0, frameId: 0, documentId: 'doc-0', origin: 'https://example.test', url: 'https://example.test/' },
      { index: 1, frameId: 4, documentId: 'doc-4', origin: 'https://ads.test', url: 'https://ads.test/frame' },
      { index: 2, frameId: 5, documentId: 'doc-5', origin: 'null', url: '' },
    ]);
  });

  it('aims page-side calls at the ref\'s own document, and calls a document that is gone stale', async () => {
    const { commands, located, goneDocuments } = await opened();
    await commands.run(command('observe'));
    await commands.run(command('fill', { target: { ref: 'e3' }, value: 'a@b.test' }));
    expect(located).toEqual(['doc-0']);
    goneDocuments.add('doc-0');
    const cancel = new Cancellation();
    await expect(commands.run(command('click', { target: { ref: 'e1' } }), cancel)).rejects.toThrow(/Stale page observation/);
    expect(cancel.dispatched).toBe(false);
  });

  it('marks a fill whose debugger will not attach as dispatched: the field was already cleared', async () => {
    const { commands, failures } = await opened();
    await commands.run(command('observe'));
    failures.attach = 'Another debugger is already attached';
    const cancel = new Cancellation();
    await expect(commands.run(command('fill', { target: { ref: 'e3' }, value: 'x' }), cancel)).rejects.toBeInstanceOf(PreconditionError);
    expect(cancel.dispatched).toBe(true);
  });
});

describe('the handed tab', () => {
  /** The owner's own tab, active in the focused window: the page they asked about. */
  function ownerTab(fake: ReturnType<typeof fakeChrome>, url = 'https://example.test/') {
    const tab = { id: 500, url, title: 'Mine', status: 'complete', groupId: -1, windowId: 1, active: true, index: 0, pinned: false };
    fake.tabs.set(tab.id, tab);
    return tab;
  }

  it('acts in the tab the owner is looking at once it was handed over', async () => {
    const fake = fakeChrome();
    const commands = new BrowserCommands(fake.chrome, { uuid: () => 'fixed-uuid-value' });
    const tab = ownerTab(fake);
    await commands.adopt('s1', tab.id);
    const { observation } = await commands.run(command('observe'));
    expect(observation!.tabs).toEqual([{ id: 'tab-fixed-uuid-v', url: 'https://example.test/', title: 'Mine' }]);
    await expect(commands.run(command('click', { target: { ref: 'e1' } }))).resolves.toEqual({});
    expect(fake.dispatched).toContain('Input.dispatchMouseEvent');
  });

  it('navigates the handed tab itself', async () => {
    const fake = fakeChrome();
    const commands = new BrowserCommands(fake.chrome, { uuid: () => 'fixed-uuid-value' });
    const tab = ownerTab(fake);
    await commands.adopt('s1', tab.id);
    await commands.run(command('navigate', { url: 'https://example.test/next' }));
    expect(tab.url).toBe('https://example.test/next');
    expect(fake.tabs.size).toBe(1);
  });

  it('a new tab of a conversation with a handed tab opens beside that tab, grouped with it', async () => {
    const fake = fakeChrome();
    const commands = new BrowserCommands(fake.chrome, { uuid: () => 'fixed-uuid-value' });
    const mine = ownerTab(fake);
    await commands.adopt('s1', mine.id);
    await commands.run(command('navigate', { url: 'https://example.test/other', newTab: true }));
    const opened = [...fake.tabs.values()].find((tab) => tab.id !== mine.id) as { openerTabId?: number; url: string; index?: number; groupId: number };
    expect([opened.openerTabId, opened.index, opened.url]).toEqual([mine.id, 1, 'https://example.test/other']);
    expect([mine.groupId, opened.groupId]).toEqual([7, 7]);
  });

  it('leaves the owner\'s tab where they moved it: only a tab still in the conversation\'s group is taken out', async () => {
    const fake = fakeChrome();
    const commands = new BrowserCommands(fake.chrome, { uuid: () => 'fixed-uuid-value' });
    const mine = ownerTab(fake);
    await commands.adopt('s1', mine.id);
    await commands.run(command('navigate', { url: 'https://example.test/other', newTab: true }));
    expect(mine.groupId).toBe(7);
    mine.groupId = 3; // the owner dragged it into a group of their own during the run
    await commands.run(command('close'));
    expect(mine.groupId).toBe(3);
    expect(fake.ungrouped).toEqual([]);
  });

  it('a watched agent tab kept open on close leaves the group too: it is the owner\'s now', async () => {
    const fake = fakeChrome();
    let n = 0;
    const commands = new BrowserCommands(fake.chrome, { uuid: () => `uuid-${n += 1}-xxxxxxxxxx` });
    const mine = ownerTab(fake);
    await commands.adopt('s1', mine.id);
    await commands.run(command('navigate', { url: 'https://example.test/other', newTab: true }));
    const opened = [...fake.tabs.values()].find((tab) => tab.id !== mine.id)!;
    opened.active = true; // the owner is looking at it
    mine.active = false;
    await commands.run(command('close'));
    expect(fake.tabs.has(opened.id)).toBe(true);
    expect([mine.groupId, opened.groupId]).toEqual([-1, -1]);
  });

  it('joins the group the owner\'s tab is already in, and never takes the tab out of it', async () => {
    const fake = fakeChrome();
    const commands = new BrowserCommands(fake.chrome, { uuid: () => 'fixed-uuid-value' });
    const mine = ownerTab(fake);
    mine.groupId = 3;
    await commands.adopt('s1', mine.id);
    await commands.run(command('navigate', { url: 'https://example.test/other', newTab: true }));
    const opened = [...fake.tabs.values()].find((tab) => tab.id !== mine.id)!;
    expect(opened.groupId).toBe(3);
    expect(fake.groupTitles).toEqual([]);
    await commands.run(command('close'));
    expect(mine.groupId).toBe(3);
    expect(fake.ungrouped).toEqual([]);
  });

  it('leaves a pinned owner tab alone: the new tab sits beside it, ungrouped', async () => {
    const fake = fakeChrome();
    const commands = new BrowserCommands(fake.chrome, { uuid: () => 'fixed-uuid-value' });
    const mine = ownerTab(fake);
    (mine as { pinned?: boolean }).pinned = true;
    await commands.adopt('s1', mine.id);
    await commands.run(command('navigate', { url: 'https://example.test/other', newTab: true }));
    const opened = [...fake.tabs.values()].find((tab) => tab.id !== mine.id)!;
    expect([mine.groupId, opened.groupId]).toEqual([-1, -1]);
  });

  /** Two tabs in one session need distinct keys, so these use a counting uuid. */
  async function withAgentTab() {
    const fake = fakeChrome();
    let n = 0;
    const commands = new BrowserCommands(fake.chrome, { uuid: () => `uuid-${(n += 1)}-padding` });
    await commands.run(command('navigate', { url: 'https://example.test/' }));
    const agentTab = [...fake.tabs.values()][0]!;
    const mine = ownerTab(fake);
    mine.active = false;
    await commands.adopt('s1', mine.id);
    return { ...fake, commands, agentTab, mine };
  }


  it('releases the handed tab on close without closing it, and closes its own', async () => {
    const { commands, tabs, agentTab, mine } = await withAgentTab();
    await commands.run(command('close'));
    expect(tabs.has(mine.id)).toBe(true);
    expect(tabs.has(agentTab.id)).toBe(false);
  });

  it('forgets the handed tab on release, leaving it untouched', async () => {
    const fake = fakeChrome();
    const commands = new BrowserCommands(fake.chrome, { uuid: () => 'fixed-uuid-value' });
    const tab = ownerTab(fake);
    await commands.adopt('s1', tab.id);
    commands.release('s1');
    expect(commands.hasTab('s1')).toBe(false);
    expect(fake.tabs.has(tab.id)).toBe(true);
    await expect(commands.run(command('observe'))).rejects.toThrow(/no browser tab yet/);
  });

  it('refuses to adopt a page that is not http(s)', async () => {
    const fake = fakeChrome();
    const commands = new BrowserCommands(fake.chrome, { uuid: () => 'fixed-uuid-value' });
    const tab = ownerTab(fake, 'chrome://settings');
    await expect(commands.adopt('s1', tab.id)).rejects.toThrow(/http and https/);
    expect(commands.hasTab('s1')).toBe(false);
  });
});

describe('when Chrome refuses to run scripts on the page', () => {
  it('says the extension lacks site access, with Chrome\'s own words, instead of "not answering"', async () => {
    const { commands, chrome } = await opened();
    chrome.scripting.executeScript = async () => { throw new Error('Cannot access contents of the page. Extension manifest must request permission to access the respective host.'); };
    await expect(commands.run(command('observe'))).rejects.toThrow(/not allowed to read this site.*Chrome: Cannot access contents/);
  });

  it('carries any other Chrome error in the "not answering" refusal', async () => {
    const { commands, chrome } = await opened();
    chrome.scripting.executeScript = async () => { throw new Error('Frame with ID 0 was removed.'); };
    await expect(commands.run(command('observe'))).rejects.toThrow(/has not answered after three tries.*Chrome: Frame with ID 0 was removed/);
  });
});


describe('containment hook', () => {
  it('opens a new tab at about:blank and navigates it only after the hook resolved', async () => {
    const fake = fakeChrome();
    const order: string[] = [];
    const created: string[] = [];
    const create = fake.chrome.tabs.create;
    fake.chrome.tabs.create = async (properties) => { created.push(properties.url); return create(properties); };
    const update = fake.chrome.tabs.update;
    fake.chrome.tabs.update = async (id, properties) => { if (properties.url) order.push(`navigate ${properties.url}`); return update(id, properties); };
    const commands = new BrowserCommands(fake.chrome, { uuid: () => 'fixed-uuid-value', beforeNavigate: async (tabId) => { order.push(`rules for ${tabId}`); } });
    await commands.run(command('navigate', { url: 'https://example.test/' }));
    expect(created).toEqual(['about:blank']);
    expect(order).toEqual(['rules for 101', 'navigate https://example.test/']);
    await commands.run(command('navigate', { url: 'https://example.test/next' }));
    expect(order.slice(2)).toEqual(['rules for 101', 'navigate https://example.test/next']);
    expect(commands.tabIds('s1')).toEqual([101]);
  });

  it('hides a subframe whose origin is not allowed, before the tree is built', async () => {
    const ads: FrameResult = { url: 'https://ads.test/frame', title: '', scroll: { x: 0, y: 0 }, origin: 'https://ads.test',
      tree: '- button "Buy now" [ref=l1]', elements: [{ id: 'l1', role: 'button', name: 'Buy now' }] };
    const { commands } = await opened([{ frameId: 0, documentId: 'doc-0', result: structuredClone(PAGE) }, { frameId: 4, documentId: 'doc-4', result: ads }]);
    const observation = await commands.observe('s1', undefined, (origin) => origin === 'https://example.test');
    expect(observation.tree).toContain('Frame 1 (origin not approved) — hidden');
    expect(observation.tree).not.toContain('Buy now');
    expect(observation.targets!.map((target) => target.name)).not.toContain('Buy now');
    expect(observation.frames[1]).toMatchObject({ origin: 'https://ads.test' });
  });
});

describe('navigating a new tab', () => {
  it('re-issues a navigation Chrome dropped, until the tab is actually going somewhere', async () => {
    const fake = fakeChrome();
    let drops = 2;
    const update = fake.chrome.tabs.update;
    let updates = 0;
    fake.chrome.tabs.update = async (id, properties) => {
      updates += 1;
      // The first two navigations are lost: the tab stays at about:blank, "unloaded".
      if (properties.url && drops > 0) { drops -= 1; const tab = fake.tabs.get(id)!; tab.status = 'unloaded'; return tab; }
      const tab = await update(id, properties);
      tab.status = 'complete';
      return tab;
    };
    const commands = new BrowserCommands(fake.chrome, { uuid: () => 'fixed-uuid-value' });
    await commands.run(command('navigate', { url: 'https://example.test/' }));
    expect(updates).toBe(3);
    expect([...fake.tabs.values()][0]!.url).toBe('https://example.test/');
  });

  it('does not blame site access when the tab is not on a web page', async () => {
    const { commands, chrome, tabs } = await opened();
    [...tabs.values()][0]!.url = 'about:blank';
    chrome.scripting.executeScript = async () => { throw new Error('Cannot access contents of the page. Extension manifest must request permission to access the respective host.'); };
    const failure = await commands.run(command('observe')).catch((error: Error) => error);
    expect(String((failure as Error).message)).not.toMatch(/not allowed to read this site/);
  });
});

describe('pace', () => {
  const keys = (sent: Array<{ method: string; params?: unknown }>) => sent.filter((entry) => entry.method === 'Input.dispatchKeyEvent' && (entry.params as { type: string }).type === 'keyDown')
    .map((entry) => (entry.params as { key: string }).key);

  it('fast: a plain field gets its value at once, with no pauses', async () => {
    const { commands, sent, waits } = await opened();
    await commands.run(command('observe'));
    waits.length = 0;
    await commands.run(command('fill', { target: { ref: 'e3' }, value: 'hi' }));
    expect(sent.filter((entry) => entry.method === 'Input.insertText').map((entry) => entry.params)).toEqual([{ text: 'hi' }]);
    expect(keys(sent)).toEqual([]);
    expect(waits.filter((ms) => ms >= 500)).toEqual([]);
  });

  it('fast: a field that suggests as you type is typed key by key, quickly', async () => {
    const { commands, sent, field } = await opened();
    field.keyByKey = true;
    await commands.run(command('observe'));
    await commands.run(command('fill', { target: { ref: 'e3' }, value: 'Lomé' }));
    expect(keys(sent)).toEqual(['L', 'o', 'm', 'é']);
    expect(sent.some((entry) => entry.method === 'Input.insertText')).toBe(false);
  });

  it('natural: pauses before an action, types each key with a gap, line breaks as Enter (in a textarea)', async () => {
    const { commands, sent, waits, field } = await opened();
    commands.setPace('natural');
    await commands.run(command('observe'));
    field.multiline = true;
    waits.length = 0;
    await commands.run(command('fill', { target: { ref: 'e3' }, value: 'a\nb' }));
    expect(waits[0]).toBe(1000);
    expect(keys(sent)).toEqual(['a', 'Enter', 'b']);
    expect(waits.filter((ms) => ms === 90)).toHaveLength(3);
  });

  it('natural: a long value is typed key by key up to a point, the rest inserted', async () => {
    const { commands, sent } = await opened();
    commands.setPace('natural');
    await commands.run(command('observe'));
    await commands.run(command('fill', { target: { ref: 'e3' }, value: 'x'.repeat(450) }));
    expect(keys(sent)).toHaveLength(400);
    expect(sent.filter((entry) => entry.method === 'Input.insertText').map((entry) => entry.params)).toEqual([{ text: 'x'.repeat(50) }]);
  });

  it('natural: the mouse moves along a path before the press, then presses and releases where aimed', async () => {
    const { commands, sent } = await opened();
    commands.setPace('natural');
    await commands.run(command('observe'));
    await commands.run(command('click', { target: { ref: 'e2' } }));
    const mouse = sent.filter((entry) => entry.method === 'Input.dispatchMouseEvent').map((entry) => entry.params as { type: string; x: number; y: number });
    const moves = mouse.filter((event) => event.type === 'mouseMoved');
    expect(moves.length).toBeGreaterThan(5);
    expect(new Set(moves.map((event) => `${event.x},${event.y}`)).size).toBeGreaterThan(5);
    expect(mouse.slice(-2)).toEqual([expect.objectContaining({ type: 'mousePressed', x: 10, y: 20 }), expect.objectContaining({ type: 'mouseReleased', x: 10, y: 20 })]);
  });

  it('natural: a Stop during typing stops it, after dispatch began', async () => {
    const { commands, sent } = await opened();
    commands.setPace('natural');
    await commands.run(command('observe'));
    const cancel = new Cancellation();
    let typed = 0;
    const original = sent.push.bind(sent);
    sent.push = (...items) => { for (const item of items) if (item.method === 'Input.dispatchKeyEvent' && (item.params as { type: string }).type === 'keyDown' && ++typed === 2) cancel.cancel(); return original(...items); };
    await expect(commands.run(command('fill', { target: { ref: 'e3' }, value: 'abcdef' }), cancel)).rejects.toBeInstanceOf(CancelledError);
    expect(cancel.dispatched).toBe(true);
    expect(typed).toBe(2);
  });

  it('natural: scrolls the same distance in steps', async () => {
    const { commands, chrome } = await opened();
    commands.setPace('natural');
    await commands.run(command('observe'));
    const steps: number[] = [];
    const run = chrome.scripting.executeScript.bind(chrome.scripting);
    chrome.scripting.executeScript = (async (injection: { func?: { name: string }; args?: unknown[] }) => {
      if (injection.func?.name === 'scrollStep') { steps.push(injection.args![0] as number); return []; }
      return run(injection as never);
    }) as typeof chrome.scripting.executeScript;
    await commands.run(command('scroll', { direction: 'down' }));
    expect(steps).toEqual([150, 150, 150, 150]);
  });
});

describe('a tab a page opened by itself', () => {
  it('from one of the session\'s tabs becomes the session\'s, grouped, and is where it works next', async () => {
    const fake = fakeChrome();
    let n = 0;
    const commands = new BrowserCommands(fake.chrome, { uuid: () => `uuid-${n += 1}-xxxxxxxxxx`, anchor: () => 999 });
    const origin = { id: 999, url: 'https://example.test/origin', title: 'Origin', status: 'complete', groupId: -1, windowId: 1, active: true, index: 0, pinned: false };
    fake.tabs.set(origin.id, origin);
    await commands.run(command('navigate', { url: 'https://example.test/' }));
    const [agentTab] = commands.tabIds('s1');
    const popup = { id: 777, url: 'https://example.test/popup', title: 'Popup', status: 'complete', groupId: -1, windowId: 1, active: true, index: 2, pinned: false };
    fake.tabs.set(popup.id, popup);
    expect(await commands.claimOpened(popup.id, agentTab!)).toBe(true);
    expect(commands.tabIds('s1')).toEqual([agentTab, popup.id]);
    expect((await commands.workspace('s1'))?.url).toBe('https://example.test/popup');
    expect(popup.groupId).toBe(origin.groupId);
    // Not twice, and never for an opener no session has.
    expect(await commands.claimOpened(popup.id, agentTab!)).toBe(false);
    expect(await commands.claimOpened(778, 12345)).toBe(false);
  });
});

describe('a line break in a fill', () => {
  it('is refused for a one-line field before anything is touched: an Enter would submit without the approval a press gets', async () => {
    const { commands, dispatched, located } = await opened();
    await commands.run(command('observe'));
    const before = located.length;
    const cancel = new Cancellation();
    await expect(commands.run(command('fill', { target: { ref: 'e1' }, value: 'blue mug\n' }), cancel)).rejects.toThrow(/one line.*press with key Enter/);
    expect(cancel.dispatched).toBe(false);
    expect(dispatched.filter((method) => method.startsWith('Input.'))).toEqual([]);
    // Only the look at the field, nothing that focuses or clears it.
    expect(located.length).toBe(before + 1);
  });

  it('is typed into a textarea, where it is a line break', async () => {
    const { commands, field, sent } = await opened();
    await commands.run(command('observe'));
    field.multiline = true;
    await commands.run(command('fill', { target: { ref: 'e1' }, value: 'line one\nline two' }));
    expect(sent.some((entry) => entry.method === 'Input.insertText' && (entry.params as { text: string }).text === 'line one\nline two')).toBe(true);
  });
});

describe('frames of other extensions', () => {
  const KEPT_OUT = 'Cannot access a chrome-extension:// URL of different extension';
  const ready = async () => {
    const got = await opened();
    await got.commands.run(command('observe'));
    return got;
  };

  it('types, presses and clicks through the page\'s own events when Chrome keeps the debugger out, and says so only if nothing else works', async () => {
    const h = await ready();
    h.failures.attach = KEPT_OUT;
    await h.commands.run(command('fill', { target: { ref: 'e1' }, value: 'blue mug' }));
    await h.commands.run(command('press', { target: { ref: 'e1' }, key: 'Enter' }));
    await h.commands.run(command('click', { target: { ref: 'e1' } }));
    await h.commands.run(command('hover', { target: { ref: 'e1' } }));
    expect(h.targets.map((target) => target.what).filter((what) => ['typeRef', 'pressRef', 'clickRef', 'hoverRef'].includes(what))).toEqual(['typeRef', 'pressRef', 'clickRef', 'hoverRef']);
    expect(h.dispatched.filter((method) => method.startsWith('Input.'))).toEqual([]);
  });

  it('other attach failures are still refusals that name the cause', async () => {
    const h = await ready();
    h.failures.attach = 'Another debugger is already attached';
    await expect(h.commands.run(command('fill', { target: { ref: 'e1' }, value: 'x' }))).rejects.toThrow(/Close DevTools/);
    expect(h.targets.some((target) => target.what === 'typeRef')).toBe(false);
  });

  it('a key press or a click kept out partway is a failure, never a second one', async () => {
    const h = await ready();
    h.failures.commandFails = { at: 2, message: KEPT_OUT };
    await expect(h.commands.run(command('press', { target: { ref: 'e1' }, key: 'Enter' }))).rejects.toThrow(/partway through/);
    expect(h.targets.some((target) => target.what === 'pressRef')).toBe(false);
  });

  it('typing kept out partway (the frame appears on the first key) sets the whole value through the page instead', async () => {
    const h = await ready();
    h.commands.setPace('natural');
    h.failures.commandFails = { at: 2, message: KEPT_OUT };
    await h.commands.run(command('fill', { target: { ref: 'e1' }, value: 'Nora' }));
    expect(h.targets.filter((target) => target.what === 'typeRef')).toHaveLength(1);
  });

  it('a drag kept out of the debugger is refused before anything is dispatched', async () => {
    const h = await ready();
    h.failures.attach = KEPT_OUT;
    const cancel = new Cancellation();
    await expect(h.commands.run(command('drag', { target: { ref: 'e2' }, to: { point: { x: 300, y: 20 } } }), cancel)).rejects.toThrow(/A drag needs it/);
    expect(cancel.dispatched).toBe(false);
    expect(h.dispatched.filter((method) => method.startsWith('Input.'))).toEqual([]);
  });

  it('two commands claiming the debugger at once attach to the tab once', async () => {
    const h = await ready();
    await Promise.all([
      h.commands.run(command('click', { target: { ref: 'e1' } })),
      h.commands.capture('s1', undefined, () => true),
    ]);
    expect(h.attachments).toHaveLength(1);
  });

  it('a screenshot the debugger is kept out of is a refusal that says so, with the halo put back', async () => {
    const h = await ready();
    h.failures.attach = KEPT_OUT;
    await expect(h.commands.capture('s1', undefined, () => true)).rejects.toThrow(/No screenshot can be taken/);
  });

  it('injects into the page\'s own frames by id, never into a frame another extension planted', async () => {
    const fake = fakeChrome();
    (fake.chrome as unknown as { webNavigation: unknown }).webNavigation = {
      async getAllFrames() {
        return [
          { frameId: 0, parentFrameId: -1, url: 'https://example.test/' },
          { frameId: 5, parentFrameId: 0, url: 'chrome-extension://aeblfdkhhhdcdjpifhhbdiojplfjncoa/inline-menu.html' },
          { frameId: 7, parentFrameId: 0, url: 'https://example.test/widget' },
          { frameId: 9, parentFrameId: 0, url: 'about:blank' },
        ];
      },
    };
    const commands = new BrowserCommands(fake.chrome, { uuid: () => 'u', wait: async () => undefined, imaging: async () => ({ data: '', width: 1, height: 1 }) });
    await commands.run(command('navigate', { url: 'https://example.test/' }));
    await commands.run(command('observe'));
    const wide = fake.targets.filter((target) => target.what === 'content' || target.what === 'readObservation' || target.what === 'readOrigin');
    expect(wide.length).toBeGreaterThan(0);
    for (const target of wide) {
      expect(target.allFrames).toBeUndefined();
      expect(target.frameIds).toEqual([0, 7, 9]);
    }
  });

  it('without webNavigation (or when it answers nothing) injects into every frame, as before', async () => {
    const { commands, targets } = await opened();
    await commands.run(command('observe'));
    expect(targets.filter((target) => target.what === 'readObservation').every((target) => target.allFrames === true)).toBe(true);
  });
});

describe('dropping a session', () => {
  it('drop forgets a session and leaves its tabs open', async () => {
    const fake = fakeChrome();
    let stored: unknown;
    const store = { get: async () => structuredClone(stored), set: async (value: unknown) => { stored = structuredClone(value); } };
    const commands = new BrowserCommands(fake.chrome, { uuid: () => 'u', wait: async () => undefined, imaging: async () => ({ data: '', width: 1, height: 1 }), store });
    await commands.run(command('navigate', { url: 'https://example.test/' }));
    expect(commands.tabIds('s1')).toHaveLength(1);
    commands.drop('s1');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(commands.tabIds('s1')).toEqual([]);
    expect(fake.tabs.size).toBe(1);
    expect((stored as { sessions: unknown[] }).sessions).toEqual([]);
  });
});

describe('a worker restart', () => {
  it('keeps the session\'s tabs — handed, its own, active — so a follow-up continues in them', async () => {
    const fake = fakeChrome();
    let stored: unknown;
    const store = { get: async () => structuredClone(stored), set: async (value: unknown) => { stored = structuredClone(value); } };
    const options = { uuid: () => 'u', wait: async () => undefined, imaging: async () => ({ data: '', width: 1, height: 1 }), store };
    const before = new BrowserCommands(fake.chrome, options);
    const mine = { id: 55, url: 'https://mail.example/inbox', title: 'Inbox', status: 'complete', groupId: -1, windowId: 1, active: true };
    fake.tabs.set(mine.id, mine);
    await before.adopt('s1', mine.id);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The worker is stopped and started again: a new executor, the same storage.
    const after = new BrowserCommands(fake.chrome, options);
    await after.restore();
    expect(after.tabIds('s1')).toEqual([55]);
    expect(await after.workspace('s1')).toEqual({ title: 'Inbox', url: 'https://mail.example/inbox' });
    // It navigates the same tab rather than opening another.
    await after.run(command('navigate', { url: 'https://mail.example/search' }));
    expect(fake.tabs.size).toBe(1);
    expect(mine.url).toBe('https://mail.example/search');
  });
});

describe('hover and drag', () => {
  const mouse = (sent: Array<{ method: string; params?: unknown }>) => sent.filter((entry) => entry.method === 'Input.dispatchMouseEvent').map((entry) => entry.params as { type: string; x: number; y: number; buttons: number });

  it('hover moves the mouse onto the element and presses nothing', async () => {
    const { commands, sent } = await opened();
    await commands.run(command('observe'));
    const cancel = new Cancellation();
    await commands.run(command('hover', { target: { ref: 'e2' } }), cancel);
    const events = mouse(sent);
    expect(events.every((event) => event.type === 'mouseMoved' && event.buttons === 0)).toBe(true);
    expect(events.at(-1)).toMatchObject({ x: 10, y: 20 });
    expect(cancel.dispatched).toBe(true);
  });

  it('drag presses at the start, moves in steps with the button held, and releases at the end', async () => {
    const { commands, sent } = await opened();
    await commands.run(command('observe'));
    await commands.run(command('drag', { target: { ref: 'e2' }, to: { point: { x: 300, y: 20 } } }));
    const events = mouse(sent);
    const pressed = events.findIndex((event) => event.type === 'mousePressed');
    expect(events[pressed]).toMatchObject({ x: 10, y: 20, buttons: 1 });
    const held = events.slice(pressed + 1, -1);
    expect(held.length).toBeGreaterThan(5);
    expect(held.every((event) => event.type === 'mouseMoved' && event.buttons === 1)).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'mouseReleased', x: 300, y: 20 });
  });

  it('drag releases the button even when stopped mid-way', async () => {
    const { commands, sent } = await opened();
    await commands.run(command('observe'));
    const cancel = new Cancellation();
    const original = commands.run.bind(commands);
    // A Stop right after the press: the wait between steps is where it is noticed.
    let pressed = false;
    const hooked = sent as Array<{ method: string; params?: unknown }>;
    const check = setInterval(() => { if (!pressed && hooked.some((entry) => (entry.params as { type?: string })?.type === 'mousePressed')) { pressed = true; cancel.cancel(); } }, 0);
    await expect(original(command('drag', { target: { ref: 'e2' }, to: { point: { x: 300, y: 20 } } }), cancel)).resolves.toBeDefined();
    clearInterval(check);
    expect(mouse(sent).at(-1)?.type).toBe('mouseReleased');
  });
});

describe('the mouse in frames', () => {
  const inFrame = (): FrameAnswer[] => [
    { frameId: 0, result: structuredClone(PAGE) },
    { frameId: 4, result: { url: 'https://example.test/frame', title: '', scroll: { x: 0, y: 0 }, tree: '- button "Only here" [ref=l1]', elements: [{ id: 'l1', role: 'button', name: 'Only here' }] } },
  ];
  const mouse = (sent: Array<{ method: string; params?: unknown }>) => sent.filter((entry) => entry.method === 'Input.dispatchMouseEvent').map((entry) => entry.params as { type: string; x: number; y: number });

  it('aims at an element in a same-site frame by adding the frame\'s place in the viewport', async () => {
    const { commands, sent } = await opened(inFrame());
    await commands.run(command('observe'));
    await commands.run(command('hover', { target: { by: 'role', role: 'button', name: 'Only here', frame: 1 } }));
    expect(mouse(sent).at(-1)).toMatchObject({ type: 'mouseMoved', x: 110, y: 70 });
    await commands.run(command('observe'));
    await commands.run(command('click', { target: { by: 'role', role: 'button', name: 'Only here', frame: 1 } }));
    expect(mouse(sent).at(-1)).toMatchObject({ type: 'mouseReleased', x: 110, y: 70 });
  });

  it('refuses to aim past a frame from another site, and a click there falls back to the element clicking itself', async () => {
    const fake = await opened(inFrame());
    fake.page.frameOffset = null;
    await fake.commands.run(command('observe'));
    await expect(fake.commands.run(command('hover', { target: { by: 'role', role: 'button', name: 'Only here', frame: 1 } }))).rejects.toThrow(/frame from another site/);
    await expect(fake.commands.run(command('drag', { target: { by: 'role', role: 'button', name: 'Only here', frame: 1 }, to: { point: { x: 1, y: 1 } } }))).rejects.toThrow(/frame from another site/);
    const before = mouse(fake.sent).length;
    await fake.commands.run(command('click', { target: { by: 'role', role: 'button', name: 'Only here', frame: 1 } }));
    expect(mouse(fake.sent)).toHaveLength(before);
  });
});

describe('Learning: the bubble and the preview', () => {
  it('preview points the cursor at the target without dispatching; note paints the bubble there and takes it away', async () => {
    const { commands, page, sent } = await opened();
    await commands.highlight('s1', true);
    await commands.run(command('observe'));
    await commands.preview('s1', { target: { ref: 'e2' } });
    expect(sent.filter((entry) => entry.method === 'Input.dispatchMouseEvent')).toEqual([]);
    expect(page.paints.at(-1)).toMatchObject({ halo: true, cursor: { x: 10, y: 20 } });
    await commands.note('s1', { text: 'Click button "Sign in"', why: 'To sign in.', waiting: true });
    expect(page.paints.at(-1)).toEqual({ halo: true, cursor: { x: 10, y: 20 }, note: { text: 'Click button "Sign in"', why: 'To sign in.', waiting: true } });
    await commands.note('s1', null);
    expect(page.paints.at(-1)).toEqual({ halo: true, cursor: { x: 10, y: 20 }, note: null });
    // The bubble survives a repaint (the halo put back after a capture) until it is taken away.
    await commands.note('s1', { text: 'Next', waiting: false });
    await commands.highlight('s1', true);
    expect(page.paints.at(-1)).toMatchObject({ note: { text: 'Next', waiting: false } });
    await commands.highlight('s1', false);
    expect(page.paints.at(-1)).toEqual({ halo: false, note: null });
  });

  it('paints nothing when the run is not highlighted', async () => {
    const { commands, page } = await opened();
    await commands.run(command('observe'));
    page.paints.length = 0;
    await commands.note('s1', { text: 'x', waiting: true });
    await commands.preview('s1', { target: { ref: 'e2' } });
    expect(page.paints).toEqual([]);
  });
});

describe('double and right clicks', () => {
  const mouse = (sent: Array<{ method: string; params?: unknown }>) => sent.filter((entry) => entry.method === 'Input.dispatchMouseEvent').map((entry) => entry.params as { type: string; button: string; clickCount: number });

  it('a double-click presses twice, the second counted as the second', async () => {
    const { commands, sent } = await opened();
    await commands.run(command('observe'));
    await commands.run(command('click', { target: { ref: 'e2' }, count: 2 }));
    const presses = mouse(sent).filter((event) => event.type !== 'mouseMoved');
    expect(presses.map((event) => `${event.type}:${event.clickCount}`)).toEqual(['mousePressed:1', 'mouseReleased:1', 'mousePressed:2', 'mouseReleased:2']);
    expect(presses.every((event) => event.button === 'left')).toBe(true);
  });

  it('a right click presses the right button once', async () => {
    const { commands, sent } = await opened();
    await commands.run(command('observe'));
    await commands.run(command('click', { target: { ref: 'e2' }, button: 'right' }));
    const presses = mouse(sent).filter((event) => event.type !== 'mouseMoved');
    expect(presses.map((event) => `${event.type}:${event.button}`)).toEqual(['mousePressed:right', 'mouseReleased:right']);
  });
});
