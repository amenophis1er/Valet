/*
 * welcome.html: opened once, on install. Three steps — open the side panel,
 * connect a model (the same sheet Settings shows), a first task — and it
 * gets out of the way.
 */

import { createAiClient } from '@amenophis1er/extension-ai-connect/client';
import { setupConnections } from './connections-ui.js';
import { AI_PREFIX } from './loop/protocol.js';

declare const chrome: {
  sidePanel?: { open(options: { tabId: number }): Promise<void> };
  tabs: { getCurrent(): Promise<{ id?: number } | undefined>; remove(tabId: number): Promise<void> };
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const ai = createAiClient({ prefix: AI_PREFIX });

/** Whether a task can start now: a connection in use with a model picked. */
async function renderReady(): Promise<void> {
  const view = await ai.get();
  const active = view.connections.find((connection) => connection.id === view.activeId);
  const ready = $('ready');
  if (active?.model) {
    ready.textContent = `Ready: ${active.label} · ${active.model}. On to step 3.`;
    ready.classList.add('ok');
  } else {
    ready.textContent = active ? 'Connected. Now pick a model on its row.' : 'Once connected, pick a model on its row.';
    ready.classList.remove('ok');
  }
}

const connections = setupConnections({ ai, onChange: () => { void renderReady(); } });
void connections.render().then(renderReady);

$('open-panel').onclick = async () => {
  const status = $('open-status');
  try {
    // Allowed here because it answers the owner's click. The panel is per tab: this one's.
    const tab = await chrome.tabs.getCurrent();
    if (!chrome.sidePanel || tab?.id === undefined) throw new Error('no side panel');
    await chrome.sidePanel.open({ tabId: tab.id });
    status.textContent = 'Opened — it is on the right.';
  } catch {
    status.textContent = 'Click the Valet icon in the toolbar to open it.';
  }
};

$('done').onclick = async () => {
  const tab = await chrome.tabs.getCurrent().catch(() => undefined);
  if (tab?.id !== undefined) await chrome.tabs.remove(tab.id).catch(() => undefined);
  else window.close();
};
