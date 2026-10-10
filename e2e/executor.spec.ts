/**
 * The executor, end to end in Chromium: the built extension loads unpacked;
 * observing a fixture page with a cross-origin iframe gives the aria tree and a
 * flat e-ref numbering; a stale observation id and an out-of-generation ref are
 * refused; a fill whose debugger attach fails after the clear is "outcome
 * unknown". The run controller is driven through the worker's dev global.
 */
import { chromium, expect, test, type BrowserContext, type Worker } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildExtension } from '../scripts/build.mjs';
import { EXTENSION_ID } from '../src/id.js';
import { startFixture, type Fixture } from './fixtures/server.js';

let context: BrowserContext;
let worker: Worker;
let fixture: Fixture;
let profile: string;
const logs: string[] = [];

// The tests share one browser and build on one another: in order, and a failure stops the rest.
test.describe.configure({ mode: 'serial' });

let dist: string;

test.beforeAll(async () => {
  // A build of its own: never the dist/ a dev loop may be serving.
  dist = await buildExtension({ out: await mkdtemp(path.join(os.tmpdir(), 'valet-e2e-dist-')) });
  fixture = await startFixture();
  profile = await mkdtemp(path.join(os.tmpdir(), 'valet-e2e-'));
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: !process.env['HEADFUL'],
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
  });
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  worker.on('console', (message) => logs.push(message.text()));
});

test.afterAll(async () => {
  await context?.close();
  await fixture?.close();
  if (profile) await rm(profile, { recursive: true, force: true });
  if (dist) await rm(dist, { recursive: true, force: true });
});

type Result = Record<string, any>;
const run = (session: string, input: unknown): Promise<Result> =>
  worker.evaluate(([s, i]) => (globalThis as any).__valet.run(s, i), [session, input] as const);

test('loads unpacked with its fixed id, and the worker starts without errors', async () => {
  expect(new URL(worker.url()).host).toBe(EXTENSION_ID);
  const manifest = await worker.evaluate(() => (globalThis as any).chrome.runtime.getManifest());
  expect(manifest.name).toBe('Valet');
  expect(logs.filter((line) => /error/i.test(line))).toEqual([]);
});

test('shows no errors or manifest warnings on chrome://extensions', async () => {
  const page = await context.newPage();
  await page.goto(`chrome://extensions/?id=${EXTENSION_ID}`);
  // The details view pierces into the extensions-manager shadow roots. Limits:
  // Chrome lists install warnings under "Errors" only in Developer mode, and
  // switching Developer mode on restarts the extension's worker (which broke
  // the tests after this one), so this checks the default view only; an
  // extension loaded with --load-extension does not surface every warning here
  // anyway. manifest.test.ts pins the manifest's keys.
  await expect(page.locator('extensions-detail-view')).toBeVisible();
  await expect(page.locator('#errors-button')).toHaveCount(0);
  // Manifest problems surface as install warnings ("Unrecognized manifest key",
  // "There were warnings…"); the Incognito toggle's standing disclaimer is not one.
  await expect(page.locator('extensions-detail-view')).not.toContainText(/Unrecognized manifest key|There were warnings|is not allowed|Permission '.*' is unknown/i);
  await page.close();
});

test('observes a page with a cross-origin iframe as one flat numbering', async () => {
  const result = await run('s-observe', { action: 'navigate', url: `${fixture.main}/shop` });
  expect(result['completed']).toBe(true);
  const observation = result['observation'];
  expect(observation.url).toBe(`${fixture.main}/shop`);
  expect(observation.tree).toContain(`Frame 0 (${fixture.main}/shop)`);
  expect(observation.tree).toContain(`Frame 1 (${fixture.other}/widget)`);
  const refs = observation.targets.map((target: { ref: string }) => target.ref);
  expect(refs).toEqual(refs.map((_: string, i: number) => `e${i + 1}`));
  const inFrame = observation.targets.find((target: { name: string }) => target.name === 'Partner offer');
  expect(inFrame).toMatchObject({ frame: 1, role: 'button' });
  expect(observation.tree).toMatch(/link "Blue mug" \[ref=e\d+\]/);
  expect(observation).not.toHaveProperty('frames');
});

test('refuses a stale observation id and an out-of-generation ref, dispatching nothing', async () => {
  const first = (await run('s-stale', { action: 'navigate', url: `${fixture.main}/shop` }))['observation'];
  const before = fixture.requests.main.length;
  const stale = await run('s-stale', { action: 'click', observation: 'not-the-latest', target: { ref: 'e1' } });
  expect(stale['refused']).toMatch(/Stale page observation/);
  const latest = stale['observation'];
  expect(latest.id).not.toBe(first.id);
  const outOfGeneration = await run('s-stale', { action: 'click', observation: latest.id, target: { ref: 'e999' } });
  expect(outOfGeneration['refused']).toMatch(/Stale page observation/);
  // Recovery observations re-read the page; they never submit or navigate.
  expect(fixture.requests.main.slice(before).filter((line) => !line.startsWith('GET /shop'))).toEqual([]);
});

test('fills a field through the debugger, and calls a fill whose attach fails after the clear "outcome unknown"', async () => {
  const observation = (await run('s-fill', { action: 'navigate', url: `${fixture.main}/shop?t=fill` }))['observation'];
  const search = observation.targets.find((target: { role: string }) => target.role === 'searchbox' || target.role === 'textbox');
  const filled = await run('s-fill', { action: 'fill', observation: observation.id, target: { ref: search.ref }, value: 'blue mug' });
  expect(filled['completed']).toBe(true);
  const page = context.pages().find((p) => p.url() === `${fixture.main}/shop?t=fill`)!;
  await expect(page.locator('input[name=q]')).toHaveValue('blue mug');

  await worker.evaluate(() => {
    const api = (globalThis as any).chrome.debugger;
    api.__attach = api.attach;
    api.attach = () => Promise.reject(new Error('Another debugger is already attached'));
  });
  try {
    const latest = filled['observation'];
    const again = latest.targets.find((target: { ref: string; name: string }) => target.name === search.name);
    const failed = await run('s-fill', { action: 'fill', observation: latest.id, target: { ref: again.ref }, value: 'red mug' });
    expect(failed['completed']).toBe('unknown');
    expect(failed['notice']).toMatch(/do not repeat a submission/);
    // The clear really happened before the attach failed.
    await expect(page.locator('input[name=q]')).toHaveValue('');
  } finally {
    await worker.evaluate(() => { const api = (globalThis as any).chrome.debugger; api.attach = api.__attach; });
  }
});

test('refuses to fill a password field', async () => {
  const observation = (await run('s-password', { action: 'navigate', url: `${fixture.main}/shop` }))['observation'];
  const password = observation.targets.find((target: { name: string }) => /Password/.test(target.name));
  const result = await run('s-password', { action: 'fill', observation: observation.id, target: { ref: password.ref }, value: 'hunter2' });
  expect(JSON.stringify(result)).toMatch(/Passwords are entered by the owner/);
});

test('works in the page the owner has open once it is handed over', async () => {
  const page = await context.newPage();
  await page.goto(`${fixture.main}/shop?t=handed`);
  await page.bringToFront();
  const tabId = await worker.evaluate(async (url) => {
    const [tab] = await (globalThis as any).chrome.tabs.query({ url });
    return tab.id as number;
  }, `${fixture.main}/shop?t=handed`);
  await worker.evaluate(([s, id]) => (globalThis as any).__valet.adopt(s, id), ['s-handed', tabId] as const);
  const observation = (await run('s-handed', { action: 'observe' }))['observation'];
  expect(observation.url).toBe(`${fixture.main}/shop?t=handed`);
  const search = observation.targets.find((target: { role: string }) => target.role === 'searchbox' || target.role === 'textbox');
  const filled = await run('s-handed', { action: 'fill', observation: observation.id, target: { ref: search.ref }, value: 'blue mug' });
  expect(filled['completed']).toBe(true);
  await expect(page.locator('input[name=q]')).toHaveValue('blue mug');
  // The owner's tab stays where they put it: never grouped, and not closed on close.
  await run('s-handed', { action: 'close' });
  expect(page.isClosed()).toBe(false);
  const groupId = await worker.evaluate(async (id) => (await (globalThis as any).chrome.tabs.get(id)).groupId, tabId);
  expect(groupId).toBe(-1);
});

test('fills time and date pickers and shows every field\'s value in the next observation', async () => {
  const observation = (await run('s-order', { action: 'navigate', url: `${fixture.main}/order` }))['observation'];
  const byName = (targets: Array<{ ref: string; name: string }>, pattern: RegExp) => targets.find((target) => pattern.test(target.name))!.ref;
  let latest = observation;
  for (const [pattern, value] of [[/Customer name/, 'Test User'], [/delivery time/, '19:30'], [/Delivery date/, '2026-10-01']] as const) {
    const result = await run('s-order', { action: 'fill', observation: latest.id, target: { ref: byName(latest.targets, pattern) }, value });
    expect(result['completed']).toBe(true);
    latest = result['observation'];
  }
  const checked = await run('s-order', { action: 'click', observation: latest.id, target: { ref: byName(latest.targets, /Bacon/) } });
  const tree: string = checked['observation'].tree;
  expect(tree).toMatch(/textbox "Customer name[^"]*" \[value="Test User"\]/);
  expect(tree).toMatch(/textbox "Preferred delivery time[^"]*" \[type=time\] \[value="19:30"\]/);
  expect(tree).toMatch(/textbox "Delivery date[^"]*" \[type=date\] \[value="2026-10-01"\]/);
  expect(tree).toMatch(/checkbox "Bacon" \[checked\]/);
  const page = context.pages().find((p) => p.url() === `${fixture.main}/order`)!;
  await expect(page.locator('input[name=delivery]')).toHaveValue('19:30');
});


test('clicks a point of a screenshot: the link under it is followed, a point inside a frame is refused', async () => {
  const observation = (await run('s-point', { action: 'navigate', url: `${fixture.main}/shop?t=point` }))['observation'];
  const shot = (await run('s-point', { action: 'screenshot' }))['screenshot'];
  expect(shot.id).toBeTruthy();
  const page = context.pages().find((p) => p.url() === `${fixture.main}/shop?t=point`)!;
  const boxes = await page.evaluate(() => {
    const at = (selector: string) => { const r = document.querySelector(selector)!.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; };
    return { link: at('a[href="/item/blue-mug"]'), frame: at('iframe') };
  });
  const scale = shot.width / shot.viewport.width;
  const toShot = (p: { x: number; y: number }) => ({ x: Math.round(p.x * scale), y: Math.round(p.y * scale) });
  const inFrame = await run('s-point', { action: 'click', observation: observation.id, screenshot: shot.id, point: toShot(boxes.frame) });
  expect(inFrame['refused']).toMatch(/inside a frame/);
  const latest = inFrame['observation'];
  const clicked = await run('s-point', { action: 'click', observation: latest.id, screenshot: shot.id, point: toShot(boxes.link) });
  expect(clicked['completed']).toBe(true);
  expect(clicked['observation'].url).toBe(`${fixture.main}/item/blue-mug`);
});

test('drags a slider thumb to the end, and hovers where a page reacts to the mouse', async () => {
  const observation = (await run('s-mouse', { action: 'navigate', url: `${fixture.main}/slider` }))['observation'];
  const page = context.pages().find((p) => p.url() === `${fixture.main}/slider`)!;
  const slider = observation.targets.find((target: { name: string }) => /Volume/.test(target.name));
  const box = await page.evaluate(() => { const r = document.querySelector('input[type=range]')!.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
  const shot = (await run('s-mouse', { action: 'screenshot' }))['screenshot'];
  const scale = shot.width / shot.viewport.width;
  // The thumb sits at the left end (value 0); drag it past the right end.
  const dragged = await run('s-mouse', { action: 'drag', observation: observation.id, screenshot: shot.id,
    point: { x: Math.round((box.x + 8) * scale), y: Math.round((box.y + box.height / 2) * scale) }, to: { point: { x: Math.round((box.x + box.width + 4) * scale), y: Math.round((box.y + box.height / 2) * scale) } } });
  expect(dragged, JSON.stringify(dragged).slice(0, 400)).toMatchObject({ completed: true });
  expect(Number(await page.locator('input[type=range]').inputValue())).toBeGreaterThan(90);
  expect(slider).toBeTruthy();

  const latest = dragged['observation'];
  await expect(page.locator('#hovered')).toHaveText('not hovered');
  const hovered = await run('s-mouse', { action: 'hover', observation: latest.id, target: { by: 'role', role: 'button', name: 'Hover me' } });
  expect(hovered, JSON.stringify(hovered).slice(0, 500)).toMatchObject({ completed: true });
  await expect(page.locator('#hovered')).toHaveText('hovered');
});

test('aims the mouse into a frame from the same site: drag and hover by ref, and a click by point that lands in it', async () => {
  const observation = (await run('s-framed', { action: 'navigate', url: `${fixture.main}/framed` }))['observation'];
  const page = context.pages().find((p) => p.url() === `${fixture.main}/framed`)!;
  const frame = page.frameLocator('iframe');
  const slider = observation.targets.find((target: { name: string }) => /Volume/.test(target.name));
  expect(slider.frame).toBe(1);
  // The slider's right end, in the tab's viewport: the frame's box plus the input's place in it.
  const box = await page.evaluate(() => {
    const iframe = document.querySelector('iframe')!;
    const outer = iframe.getBoundingClientRect();
    const input = iframe.contentDocument!.querySelector('input[type=range]')!.getBoundingClientRect();
    return { x: outer.left + iframe.clientLeft + input.right + 4, y: outer.top + iframe.clientTop + input.top + input.height / 2 };
  });
  const shot = (await run('s-framed', { action: 'screenshot' }))['screenshot'];
  const scale = shot.width / shot.viewport.width;
  const dragged = await run('s-framed', { action: 'drag', observation: observation.id, screenshot: shot.id, target: { ref: slider.ref }, to: { point: { x: Math.round(box.x * scale), y: Math.round(box.y * scale) } } });
  expect(dragged, JSON.stringify(dragged).slice(0, 300)).toMatchObject({ completed: true });
  expect(Number(await frame.locator('input[type=range]').inputValue())).toBeGreaterThan(90);

  let latest = dragged['observation'];
  const hovered = await run('s-framed', { action: 'hover', observation: latest.id, target: { by: 'role', role: 'button', name: 'Hover me', frame: 1 } });
  expect(hovered, JSON.stringify(hovered).slice(0, 300)).toMatchObject({ completed: true });
  await expect(frame.locator('#hovered')).toHaveText('hovered');

  latest = hovered['observation'];
  const button = await page.evaluate(() => {
    const iframe = document.querySelector('iframe')!;
    const outer = iframe.getBoundingClientRect();
    const target = iframe.contentDocument!.getElementById('target')!.getBoundingClientRect();
    return { x: outer.left + iframe.clientLeft + target.left + target.width / 2, y: outer.top + iframe.clientTop + target.top + target.height / 2 };
  });
  const shot2 = (await run('s-framed', { action: 'screenshot' }))['screenshot'];
  const clicked = await run('s-framed', { action: 'click', observation: latest.id, screenshot: shot2.id, point: { x: Math.round(button.x * scale), y: Math.round(button.y * scale) } });
  expect(clicked, JSON.stringify(clicked).slice(0, 300)).toMatchObject({ completed: true });
  await expect(frame.locator('#hovered')).toHaveText('clicked');
});

test('a conversation\'s new tab opens right after the owner\'s tab and in one group with it, which the owner\'s tab leaves on close', async () => {
  const page = await context.newPage();
  await page.goto(`${fixture.main}/shop?t=origin`);
  await page.bringToFront();
  const tabId = await worker.evaluate(async (url) => (await (globalThis as any).chrome.tabs.query({ url }))[0].id as number, `${fixture.main}/shop?t=origin`);
  const tab = async (id: number) => worker.evaluate(async (i) => { const t = await (globalThis as any).chrome.tabs.get(i); return { index: t.index, groupId: t.groupId, url: t.url }; }, id);
  // The session is the tab's conversation; the owner handed that tab over and the agent read it, then asked for another tab, as an owner does.
  const session = `tab:${tabId}`;
  await worker.evaluate(([s, id]) => (globalThis as any).__valet.adopt(s, id), [session, tabId] as const);
  const read = await run(session, { action: 'observe' });
  expect(read['completed']).toBe(true);
  const opened = await run(session, { action: 'navigate', url: `${fixture.main}/shop?t=second`, newTab: true });
  expect(opened['completed']).toBe(true);
  expect(page.url()).toContain('t=origin');
  const secondId = (await worker.evaluate((s) => (globalThis as any).__valet.executor.tabIds(s), session) as number[]).find((id) => id !== tabId);
  const origin = await tab(tabId);
  const second = await tab(secondId!);
  expect(second.index).toBe(origin.index + 1);
  expect(origin.groupId).toBeGreaterThanOrEqual(0);
  expect(second.groupId).toBe(origin.groupId);
  const title = await worker.evaluate(async (id) => (await (globalThis as any).chrome.tabGroups.get(id)).title, origin.groupId);
  expect(title).toBe('valet');
  await run(session, { action: 'close' });
  expect((await tab(tabId)).groupId).toBe(-1);
  await page.close();
});

test('a link that opens a new tab: the tab becomes the conversation\'s, and the agent reads it next', async () => {
  const page = await context.newPage();
  await page.goto(`${fixture.main}/shop?t=opener`);
  await page.bringToFront();
  const tabId = await worker.evaluate(async (url) => (await (globalThis as any).chrome.tabs.query({ url }))[0].id as number, `${fixture.main}/shop?t=opener`);
  const session = `tab:${tabId}`;
  await worker.evaluate(([s, id]) => (globalThis as any).__valet.adopt(s, id), [session, tabId] as const);
  const observation = (await run(session, { action: 'observe' }))['observation'];
  const link = observation.targets.find((target: { role: string; name: string }) => target.role === 'link' && /new tab/.test(target.name));
  expect(link).toBeTruthy();
  const tabsOf = () => worker.evaluate((s) => (globalThis as any).__valet.executor.tabIds(s), session) as Promise<number[]>;
  // Claimed straight through the executor, as the worker does on tabs.onCreated.
  const before = await tabsOf();
  const clicked = await run(session, { action: 'click', observation: observation.id, target: { ref: link.ref } });
  expect(clicked['completed']).toBe(true);
  const opened = await (async () => {
    for (let i = 0; i < 40; i += 1) {
      const all = await worker.evaluate(async (origin) => (await (globalThis as any).chrome.tabs.query({})).filter((t: { openerTabId?: number }) => t.openerTabId === origin).map((t: { id: number }) => t.id), tabId) as number[];
      if (all.length > 0) return all[0]!;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('no tab was opened');
  })();
  expect(before).not.toContain(opened);
  expect(await worker.evaluate(([_s, id, opener]) => (globalThis as any).__valet.executor.claimOpened(id, opener), [session, opened, tabId] as const)).toBe(true);
  expect(await tabsOf()).toContain(opened);
  const next = (await run(session, { action: 'observe' }))['observation'];
  expect(next.url).toBe(`${fixture.main}/item/blue-mug`);
  expect(next.tabs.map((tab: { url: string }) => tab.url)).toEqual(expect.arrayContaining([`${fixture.main}/shop?t=opener`, `${fixture.main}/item/blue-mug`]));
  await run(session, { action: 'close' });
  await page.close();
});

test('double-clicks and right-clicks: a page sees dblclick and contextmenu', async () => {
  let observation = (await run('s-clicks', { action: 'navigate', url: `${fixture.main}/slider?t=clicks` }))['observation'];
  const page = context.pages().find((p) => p.url() === `${fixture.main}/slider?t=clicks`)!;
  const file = observation.targets.find((target: { name: string }) => target.name === 'report.pdf');
  const right = await run('s-clicks', { action: 'click', observation: observation.id, target: { ref: file.ref }, button: 'right' });
  expect(right, JSON.stringify(right).slice(0, 300)).toMatchObject({ completed: true });
  await expect(page.locator('#opened')).toHaveText('menu by right click');
  observation = right['observation'];
  const again = observation.targets.find((target: { name: string }) => target.name === 'report.pdf');
  const double = await run('s-clicks', { action: 'click', observation: observation.id, target: { ref: again.ref }, count: 2 });
  expect(double, JSON.stringify(double).slice(0, 300)).toMatchObject({ completed: true });
  await expect(page.locator('#opened')).toHaveText('opened by double-click');
});

test('a page that rewrites its own URL keeps its refs; a reload does not', async () => {
  let observation = (await run('s-spa', { action: 'navigate', url: `${fixture.main}/slider?t=spa` }))['observation'];
  const page = context.pages().find((p) => p.url() === `${fixture.main}/slider?t=spa`)!;
  // As Google Maps does as its map settles: same document, a new path.
  await page.evaluate(() => history.replaceState(null, '', '/maps/place/Somewhere/@48.858,2.294,17z'));
  const file = observation.targets.find((target: { name: string }) => target.name === 'report.pdf');
  const clicked = await run('s-spa', { action: 'click', observation: observation.id, target: { ref: file.ref }, count: 2 });
  expect(clicked, JSON.stringify(clicked).slice(0, 300)).toMatchObject({ completed: true });
  await expect(page.locator('#opened')).toHaveText('opened by double-click');
  observation = clicked['observation'];
  const again = observation.targets.find((target: { name: string }) => target.name === 'report.pdf');
  await page.reload();
  const refused = await run('s-spa', { action: 'click', observation: observation.id, target: { ref: again.ref } });
  expect(refused, JSON.stringify(refused).slice(0, 300)).toMatchObject({ refused: expect.stringMatching(/changed since that observation|Stale/) });
});
