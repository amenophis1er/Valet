/**
 * Every screen and state of the UI, in light and dark, as PNGs: the side
 * panel (empty, menus, composer, cards, a run, a finished conversation,
 * Learn, a pause, Settings), the welcome page, the image viewer, the
 * microphone page, the document page and the overlay on a web page.
 *
 * Driven like the e2e suite — the built extension in Chromium, a scripted
 * model, the fixture site — so the states are real, not mocked. A scene that
 * fails is reported and skipped; the rest still run.
 *
 *   npm run screenshots            → screenshots/{light,dark}/NN-name.png
 *   SHOTS=dir npm run screenshots  → dir/{light,dark}/…
 */
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildExtension } from '../build.mjs';
import { EXTENSION_ID } from '../../src/id.js';
import { refOf, startModel, type ScriptedModel } from '../../e2e/fixtures/model.js';
import { startFixture, type Fixture } from '../../e2e/fixtures/server.js';

const OUT = path.resolve(process.env['SHOTS'] ?? 'screenshots');
const PANEL = { width: 400, height: 780 };
const PAGE = { width: 1200, height: 800 };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64');

const ANSWER = [
  'The **blue mug** costs **$12.40** and ships in 2 days.',
  '',
  '### What I compared',
  '- Blue mug — $12.40, in stock',
  '- Red mug — $14.00, back order',
  '- [Shop page](https://example.com/shop)',
  '',
  '| Item | Price | Stock |',
  '| --- | --- | --- |',
  '| Blue mug | $12.40 | Yes |',
  '| Red mug | $14.00 | No |',
  '',
  'Use `blue-mug` as the code at checkout.',
].join('\n');

const DOCUMENT = ['# Mug comparison', '', 'A short report the agent wrote.', '', '## Prices', '', '| Item | Price |', '| --- | --- |', '| Blue mug | $12.40 |', '| Red mug | $14.00 |', '', '## Notes', '', '- The blue mug ships in 2 days.', '- The red mug is on back order.', '', '> Prices as of today.'].join('\n');

for (const scheme of ['light', 'dark'] as const) {
  test(`screenshots (${scheme})`, async () => {
    const dir = path.join(OUT, scheme);
    await mkdir(dir, { recursive: true });
    const dist = await buildExtension();
    const fixture: Fixture = await startFixture();
    const model: ScriptedModel = await startModel([]);
    const profile = await mkdtemp(path.join(os.tmpdir(), 'errand-shots-'));
    const context: BrowserContext = await chromium.launchPersistentContext(profile, {
      channel: 'chromium', colorScheme: scheme,
      args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
    });
    const failed: string[] = [];
    let n = 0;
    const shot = async (page: Page, name: string, options: { fullPage?: boolean; hover?: boolean } = {}) => {
      n += 1;
      // No stray tooltip from the last click, unless the hover is the point.
      if (!options.hover) await page.mouse.move(1, 1);
      await page.waitForTimeout(250);
      await page.screenshot({ path: path.join(dir, `${String(n).padStart(2, '0')}-${name}.png`), fullPage: options.fullPage ?? false });
    };
    const scene = async (name: string, body: () => Promise<void>) => {
      const started = Date.now();
      try { await body(); } catch (error) { failed.push(`${name}: ${String(error).split('\n').slice(0, 3).join(' | ')}`); }
      console.log(`[${scheme}] ${name} (${Math.round((Date.now() - started) / 1000)}s)`);
    };
    const extension = (file: string) => `chrome-extension://${EXTENSION_ID}/${file}`;
    /** Every run scene starts the same way: a new conversation in Ask, Learn off, on the shop's tab. */
    const fresh = async (panel: Page, shop: Page) => {
      await panel.getByRole('button', { name: 'New conversation' }).click();
      if (await panel.locator('#learn').getAttribute('aria-pressed') === 'true') await panel.locator('#learn').click();
      if ((await panel.locator('#mode').textContent())?.includes('Auto')) { await panel.locator('#mode').click(); await panel.locator('#mode-ask').click(); }
      await shop.bringToFront();
    };

    try {
      context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');

      await scene('welcome', async () => {
        const welcome = context.pages().find((page) => page.url().endsWith('/welcome.html')) ?? await context.waitForEvent('page', { predicate: (page) => page.url().endsWith('/welcome.html'), timeout: 10_000 });
        await welcome.setViewportSize({ width: 1000, height: 900 });
        await welcome.bringToFront();
        await shot(welcome, 'welcome', { fullPage: true });
        await welcome.getByLabel('Provider').selectOption('claude-sub');
        await shot(welcome, 'welcome-provider-claude', { fullPage: true });
        await welcome.close();
      });

      const shop = await context.newPage();
      await shop.setViewportSize(PAGE);
      await shop.goto(`${fixture.main}/shop`);
      const panel = await context.newPage();
      await panel.setViewportSize(PANEL);
      await panel.goto(extension('panel.html'));
      await shop.bringToFront();

      await scene('panel empty, no connection', async () => {
        await shot(panel, 'panel-empty-no-connection');
        await panel.locator('#goal').fill('Find the price of the blue mug');
        await panel.getByRole('button', { name: 'Send' }).click();
        await expect(panel.locator('.notice').last()).toContainText('connection');
        await shot(panel, 'panel-notice-no-connection');
        await panel.getByRole('button', { name: 'New conversation' }).click();
      });

      await scene('settings', async () => {
        await panel.getByRole('button', { name: 'Settings' }).click();
        await shot(panel, 'settings-no-connection', { fullPage: true });
        await panel.getByLabel('Provider').selectOption('anthropic');
        await shot(panel, 'settings-add-api-key', { fullPage: true });
        await panel.getByLabel('Provider').selectOption('custom');
        await panel.getByLabel('Server URL').fill(model.base);
        await panel.getByRole('button', { name: 'Connect' }).click();
        await expect(panel.locator('.connections select option', { hasText: 'scripted' })).toHaveCount(1);
        await panel.locator('.connections select').first().selectOption('scripted');
        await panel.getByRole('button', { name: 'Add a connection' }).click();
        await panel.getByLabel('Provider').selectOption('ollama-local');
        await panel.getByRole('button', { name: 'Connect' }).click();
        await expect(panel.locator('.connections li')).toHaveCount(2);
        // The scripted model is the one in use; Ollama stays in the list for show.
        await panel.locator('.connections li:not(.active) .title').click();
        await expect(panel.locator('.connections li.active select')).toHaveValue('scripted');
        await shot(panel, 'settings-connections', { fullPage: true });
        await panel.getByRole('button', { name: 'Add a skill' }).click();
        await panel.locator('#skill-name').fill('Shop tips');
        await panel.locator('#skill-sites').fill(new URL(fixture.main).hostname);
        await panel.locator('#skill-text').fill('Use the search box, never the category links. Prices on this site include tax.');
        await shot(panel, 'settings-skill-form', { fullPage: true });
        await panel.locator('#skill-save').click();
        await panel.getByRole('button', { name: 'Add a skill' }).click();
        await panel.locator('#skill-name').fill('House style');
        await panel.locator('#skill-text').fill('Answer in one short paragraph.');
        await panel.locator('#skill-save').click();
        await expect(panel.locator('.skills li')).toHaveCount(2);
        await panel.getByLabel('House style on').uncheck().catch(() => undefined);
        await shot(panel, 'settings-skills', { fullPage: true });
        await panel.getByRole('button', { name: 'Back' }).click();
      });

      await scene('composer and menus', async () => {
        await shop.bringToFront();
        await panel.getByRole('button', { name: 'New conversation' }).click();
        await shot(panel, 'panel-empty');
        await panel.locator('#add').click();
        await shot(panel, 'menu-add');
        await panel.keyboard.press('Escape');
        await panel.locator('#where').click();
        await shot(panel, 'menu-where');
        await panel.keyboard.press('Escape');
        await panel.locator('#mode').click();
        await shot(panel, 'menu-approvals');
        await panel.keyboard.press('Escape');
        await panel.locator('#goal').pressSequentially('Compare prices @');
        await expect(panel.locator('#skill-menu')).toBeVisible();
        await shot(panel, 'menu-skills');
        await panel.locator('#skill-menu button').first().click();
        await shot(panel, 'composer-skill-chip');
        await panel.locator('.skill-chip button').click({ timeout: 3_000 }).catch(() => undefined);
        await panel.locator('#goal').fill('');
        await panel.locator('#learn').click();
        await panel.locator('#mode').click();
        await panel.locator('#mode-auto').click();
        await shot(panel, 'composer-learn-and-auto-on');
        await panel.locator('#learn').click();
        await panel.locator('#mode').click();
        await panel.locator('#mode-ask').click();
        await panel.locator('#file-input').setInputFiles([
          { name: 'mug.png', mimeType: 'image/png', buffer: PNG },
          { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Blue mug, under $15.') },
        ]);
        await expect(panel.locator('.pending')).toHaveCount(2);
        await panel.locator('#goal').fill('Buy the mug in this picture if it is under $15');
        await shot(panel, 'composer-attachments');
        while (await panel.locator('.pending .remove').count() > 0) await panel.locator('.pending .remove').first().click();
        await panel.locator('#goal').fill('');
      });

      await scene('a run: cards, working, a finished conversation', async () => {
        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        model.script([
          () => ({ text: 'The partner site lists mugs too; I will look there first.', call: { action: 'navigate', url: `${fixture.other}/widget` } }),
          async () => { await held; return { call: { action: 'navigate', url: `${fixture.main}/shop?t=shots` } }; },
          ({ observation }) => ({ call: { action: 'fill', observation: observation!.id, target: { ref: refOf(observation, /searchbox|textbox/, /Search/) }, value: 'blue mug' } }),
          ({ observation }) => ({ call: { action: 'press', observation: observation!.id, target: { ref: refOf(observation, /searchbox|textbox/, /Search/) }, key: 'Enter' } }),
          () => ({ call: { action: 'screenshot' } }),
          () => ({ tool: 'save_file', call: { filename: 'mug-comparison.md', content: DOCUMENT } }),
          () => ({ text: ANSWER }),
        ]);
        await fresh(panel, shop);
        await panel.locator('#goal').fill('Find the cheapest blue mug in this shop and compare it with the red one');
        await panel.getByRole('button', { name: 'Send' }).click();
        await expect(panel.locator('#card')).toBeVisible({ timeout: 30_000 });
        await shot(panel, 'card-site');
        await panel.getByRole('button', { name: 'Allow once' }).click();
        await expect(panel.locator('.status.working')).toBeVisible({ timeout: 30_000 });
        await shot(panel, 'working');
        release();
        await expect(panel.locator('#card-text')).toContainText('Submit this form', { timeout: 30_000 });
        await shot(panel, 'card-form');
        await panel.getByRole('button', { name: 'Allow once' }).click();
        await expect(panel.locator('.agent').last()).toContainText('blue mug', { timeout: 30_000 });
        await expect(panel.locator('.agent table')).toBeVisible();
        await shot(panel, 'conversation-done');
        await panel.locator('.agent').last().hover();
        await shot(panel, 'answer-hover-copy', { hover: true });
        await panel.locator('.activity > details > summary').first().click();
        await shot(panel, 'steps-unfolded');
        await panel.locator('#transcript').evaluate((list) => { list.scrollTop = 0; });
        await shot(panel, 'conversation-top');
        await panel.getByRole('button', { name: 'More' }).click();
        await shot(panel, 'menu-more');
        await panel.keyboard.press('Escape');
        await panel.setViewportSize({ width: PANEL.width, height: 1900 });
        await panel.locator('#transcript').evaluate((list) => { list.scrollTop = 0; });
        await shot(panel, 'conversation-tall');
        await panel.setViewportSize(PANEL);

        await scene('viewer', async () => {
          const [viewer] = await Promise.all([context.waitForEvent('page', { timeout: 10_000 }), panel.locator('.shot').first().click()]);
          await viewer.waitForLoadState();
          await viewer.setViewportSize({ width: 1100, height: 760 });
          await shot(viewer, 'viewer');
          await viewer.close();
        });
        await scene('lightbox', async () => {
          await panel.evaluate((src) => {
            (document.getElementById('lightbox-image') as HTMLImageElement).src = src;
            (document.getElementById('lightbox') as HTMLDialogElement).showModal();
          }, `data:image/png;base64,${PNG.toString('base64')}`);
          await shot(panel, 'lightbox-fallback');
          await panel.evaluate(() => (document.getElementById('lightbox') as HTMLDialogElement).close());
        });
      });

      await scene('learn', async () => {
        model.script([
          () => ({ text: 'Opening the shop.', call: { action: 'navigate', url: `${fixture.main}/shop?t=learn` } }),
          ({ observation }) => ({ text: 'The mug is a link; I will open it to read its price.', call: { action: 'click', observation: observation!.id, target: { ref: refOf(observation, /link/, /Blue mug/) } } }),
          () => ({ text: 'Opened the mug: $12.40.' }),
        ]);
        await fresh(panel, shop);
        await panel.locator('#learn').click();
        await panel.locator('#goal').fill('Open the blue mug and tell me its price');
        await panel.getByRole('button', { name: 'Send' }).click();
        await expect(panel.locator('#step')).toBeVisible({ timeout: 30_000 });
        await shot(panel, 'learn-first-step');
        await panel.getByRole('button', { name: 'Next step' }).click();
        await expect(panel.locator('#step-text')).toContainText('Blue mug', { timeout: 30_000 });
        await shot(panel, 'learn-step-with-reason');
        const learnPage = context.pages().find((page) => page.url().includes('t=learn'))!;
        await learnPage.setViewportSize(PAGE);
        await learnPage.bringToFront();
        await learnPage.waitForTimeout(600);
        await shot(learnPage, 'page-overlay-learn-bubble');
        await panel.getByRole('button', { name: 'Next step' }).click();
        await expect(panel.locator('.agent').last()).toContainText('12.40', { timeout: 30_000 });
        await panel.locator('#learn').click();
      });

      await scene('paused', async () => {
        model.script([
          () => ({ call: { action: 'navigate', url: `${fixture.main}/shop?t=pause` } }),
          () => ({ call: { action: 'click' } }),
          () => ({ call: { action: 'click' } }),
          () => ({ call: { action: 'click' } }),
        ]);
        await fresh(panel, shop);
        await panel.locator('#goal').fill('Click the first product');
        await panel.getByRole('button', { name: 'Send' }).click();
        await expect(panel.getByRole('button', { name: 'Resume' })).toBeVisible({ timeout: 30_000 });
        await shot(panel, 'paused');
        await panel.getByRole('button', { name: 'Stop' }).click();
      });

      await scene('page overlay while working', async () => {
        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        model.script([
          () => ({ call: { action: 'navigate', url: `${fixture.main}/shop?t=halo` } }),
          ({ observation }) => ({ call: { action: 'hover', observation: observation!.id, target: { ref: refOf(observation, /link/, /Blue mug/) } } }),
          async () => { await held; return { text: 'Done.' }; },
        ]);
        await fresh(panel, shop);
        await panel.locator('#goal').fill('Point at the blue mug');
        await panel.getByRole('button', { name: 'Send' }).click();
        await expect.poll(() => context.pages().some((page) => page.url().includes('t=halo')), { timeout: 30_000 }).toBe(true);
        const halo = context.pages().find((page) => page.url().includes('t=halo'))!;
        await halo.setViewportSize(PAGE);
        await expect(halo.locator('errand-overlay')).toHaveCount(1, { timeout: 30_000 });
        await halo.waitForTimeout(1500);
        await shot(halo, 'page-overlay-halo-cursor');
        release();
      });

      await scene('document', async () => {
        await panel.evaluate(async (content) => {
          await (globalThis as unknown as { chrome: { storage: { session: { set(items: Record<string, unknown>): Promise<void> } } } })
            .chrome.storage.session.set({ 'agent:media:shots-doc': { kind: 'file', name: 'mug-comparison.md', mimeType: 'text/markdown', content } });
        }, DOCUMENT);
        const doc = await context.newPage();
        await doc.setViewportSize({ width: 900, height: 1000 });
        await doc.goto(extension('document.html?id=shots-doc'));
        await shot(doc, 'document', { fullPage: true });
        await doc.close();
      });

      await scene('mic', async () => {
        const mic = await context.newPage();
        await mic.setViewportSize({ width: 900, height: 500 });
        await mic.goto(extension('mic.html'));
        await mic.waitForTimeout(800);
        await shot(mic, 'mic');
        await mic.close();
      });
    } finally {
      await context.close();
      await fixture.close();
      await model.close();
      await rm(profile, { recursive: true, force: true });
    }
    if (failed.length > 0) console.warn(`[${scheme}] scenes that failed:\n  ${failed.join('\n  ')}`);
    console.log(`[${scheme}] ${n} screenshots in ${dir}`);
  });
}
