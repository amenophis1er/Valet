/*
 * The AI models sheet: the list of connections, the form to add one (API
 * key, or a sign-in with a Claude, ChatGPT or Ollama account), and the model
 * picked on each row. Settings in the side panel and the welcome page show
 * the same sheet, from this one module: `connectionsMarkup()` is its HTML,
 * `setupConnections()` wires it.
 */

import type { AiClient } from '@amenophis1er/extension-ai-connect/client';
import type { ConnectionView } from '@amenophis1er/extension-ai-connect/types';
import { iconButton, TRASH } from './ui.js';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let ai: AiClient;
let onChange: () => void = () => undefined;

/** The sheet's own markup (constant, ours), for a `.sheet` container. */
function connectionsMarkup(): string {
  return `
        <ul id="connections" class="connections"></ul>
        <button id="add-toggle" class="add-toggle" aria-expanded="false" aria-controls="add-form">
          <span aria-hidden="true">+</span> Add a connection
        </button>
        <div id="add-form" class="add-form" hidden>
          <label>Provider
            <select id="provider">
              <optgroup label="Sign in with a subscription">
                <option value="claude-sub">Claude Pro/Max</option>
                <option value="chatgpt-sub">ChatGPT Plus/Pro</option>
                <option value="ollama-cloud">Ollama Cloud</option>
              </optgroup>
              <optgroup label="Use an API key">
                <option value="anthropic">Anthropic</option>
                <option value="openai">OpenAI</option>
                <option value="openrouter">OpenRouter</option>
              </optgroup>
              <optgroup label="Run it yourself">
                <option value="ollama-local">Ollama on this computer</option>
                <option value="custom">Other OpenAI-compatible server</option>
              </optgroup>
            </select>
          </label>
          <p id="claude-hint" class="muted hint" hidden>Opens claude.com to approve access with your Claude subscription. After you approve, it shows a code: paste it here.</p>
          <p id="chatgpt-hint" class="muted hint" hidden>Opens openai.com to connect your ChatGPT subscription. Enter the code shown here on that page.</p>
          <p id="ollama-hint" class="muted hint" hidden>Opens ollama.com to pair this browser with your account, like <code>ollama signin</code>. Click Connect there, then come back.</p>
          <label id="base-row" hidden>Server URL <input id="base" placeholder="http://localhost:1234"></label>
          <label id="key-row">API key <input id="key" type="password" autocomplete="off" placeholder="Stays encrypted in the extension"></label>
          <div id="claude-finish" class="row" hidden>
            <input id="claude-code" placeholder="Paste the code from claude.com" autocomplete="off" aria-label="Code from claude.com">
            <button id="claude-done" class="primary">Finish</button>
          </div>
          <p id="chatgpt-code" class="signin-code" hidden></p>
          <div class="row">
            <button id="connect" class="primary">Connect</button>
            <button id="add-cancel" class="ghost">Cancel</button>
          </div>
          <p id="settings-status" class="muted status-line" role="status"></p>
        </div>`;
}

/** Fill the sheet and wire it. `onChange` is told whenever the active connection or its model may have changed. */
export function setupConnections(options: { ai: AiClient; onChange?: () => void; container?: HTMLElement }): { render(): Promise<void>; openAddForm(open: boolean): void } {
  ai = options.ai;
  onChange = options.onChange ?? (() => undefined);
  const container = options.container ?? $('connections-sheet');
  container.innerHTML = connectionsMarkup();
  $('provider').onchange = renderProvider;
  $('add-toggle').onclick = () => openAddForm(true);
  $('add-cancel').onclick = () => openAddForm(false);
  $('connect').onclick = () => { void addConnection(); };
  renderProvider();
  return { render: renderConnections, openAddForm };
}

const PROVIDERS: Record<string, { kind: 'anthropic' | 'openai-compatible'; base?: string; key: boolean; label: string }> = {
  anthropic: { kind: 'anthropic', key: true, label: 'Anthropic' },
  openai: { kind: 'openai-compatible', base: 'https://api.openai.com', key: true, label: 'OpenAI' },
  openrouter: { kind: 'openai-compatible', base: 'https://openrouter.ai/api', key: true, label: 'OpenRouter' },
  'ollama-local': { kind: 'openai-compatible', base: 'http://localhost:11434', key: false, label: 'Ollama (local)' },
  custom: { kind: 'openai-compatible', key: true, label: '' },
};

async function renderConnections(): Promise<void> {
  const view = await ai.get();
  const list = $('connections');
  list.textContent = '';
  if (view.connections.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty-row';
    empty.textContent = 'No connection yet. Add one to start.';
    list.append(empty);
    openAddForm(true);
  }
  for (const connection of view.connections) list.append(connectionRow(connection, connection.id === view.activeId));
}

function connectionRow(connection: ConnectionView, active: boolean): HTMLLIElement {
  const row = document.createElement('li');
  row.className = active ? 'active' : '';
  row.setAttribute('aria-current', String(active));
  const dot = document.createElement('span');
  dot.className = 'dot';
  dot.setAttribute('aria-hidden', 'true');

  const name = document.createElement('div');
  name.className = 'name';
  const title = document.createElement('div');
  title.className = 'title';
  const label = document.createElement('span');
  label.textContent = connection.label;
  title.append(label);
  if (active) { const pill = document.createElement('span'); pill.className = 'pill'; pill.textContent = 'In use'; title.append(pill); }
  const detail = document.createElement('small');
  detail.textContent = `${connection.baseUrl || connection.kind}${connection.keyHint ? ` · ${connection.keyHint}` : ''}`;

  const models = document.createElement('select');
  models.setAttribute('aria-label', `Model for ${connection.label}`);
  models.append(new Option(connection.model || 'Loading models…', connection.model));
  void ai.listModels({ kind: connection.kind, baseUrl: connection.baseUrl, apiKey: '', id: connection.id }).then((res) => {
    models.textContent = '';
    if (!res.ok || !res.data) { models.append(new Option(connection.model || `Models unavailable: ${res.error ?? ''}`, connection.model)); return; }
    if (!connection.model) models.append(new Option('Pick a model', ''));
    for (const model of res.data) models.append(new Option(model.name, model.id, false, model.id === connection.model));
  });
  models.onclick = (event) => event.stopPropagation();
  models.onchange = async () => {
    await ai.saveConnection({ id: connection.id, kind: connection.kind, label: connection.label, baseUrl: connection.baseUrl, model: models.value, apiKeyMode: 'keep' });
    await renderConnections();
    onChange();
  };
  name.append(title, models, detail);

  const remove = iconButton(TRASH, `Remove ${connection.label}`, async () => { await ai.deleteConnection(connection.id); await renderConnections(); onChange(); }, 'danger');
  row.append(dot, name, remove);
  if (!active) {
    row.title = 'Use this one';
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-label', `Use ${connection.label}`);
    const use = async () => { await ai.setActive(connection.id); await renderConnections(); onChange(); };
    row.onclick = use;
    row.onkeydown = (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void use(); } };
  }
  return row;
}

function openAddForm(open: boolean): void {
  $('add-form').hidden = !open;
  $('add-toggle').hidden = open;
  $('add-toggle').setAttribute('aria-expanded', String(open));
  if (open) renderProvider();
}

const SIGN_IN: Record<string, string> = { 'claude-sub': 'Sign in with Claude', 'chatgpt-sub': 'Sign in with ChatGPT', 'ollama-cloud': 'Sign in with Ollama' };

function renderProvider(): void {
  const provider = $<HTMLSelectElement>('provider').value;
  const spec = PROVIDERS[provider];
  $('key-row').hidden = provider in SIGN_IN || spec?.key === false;
  $('base-row').hidden = provider !== 'custom';
  $('ollama-hint').hidden = provider !== 'ollama-cloud';
  $('claude-hint').hidden = provider !== 'claude-sub';
  $('chatgpt-hint').hidden = provider !== 'chatgpt-sub';
  $('claude-finish').hidden = true;
  $('chatgpt-code').hidden = true;
  $('settings-status').textContent = '';
  $('connect').textContent = SIGN_IN[provider] ?? 'Connect';
}

/** Claude Pro/Max: approve on claude.com (the library opens it), then paste the code it shows. */
async function signInClaude(): Promise<void> {
  const status = $('settings-status');
  const start = await ai.anthropicLoginStart();
  if (!start.ok) { status.textContent = start.error ?? 'Could not start the sign-in.'; return; }
  status.textContent = 'Approve on claude.com, then paste the code here.';
  $('claude-finish').hidden = false;
  $<HTMLInputElement>('claude-code').value = '';
  $('claude-code').focus();
  $('claude-done').onclick = async () => {
    const pasted = $<HTMLInputElement>('claude-code').value.trim();
    if (!pasted) { status.textContent = 'Paste the code from claude.com first.'; return; }
    status.textContent = 'Finishing…';
    const done = await ai.anthropicLoginComplete({ pasted, label: 'Claude (Pro/Max)' });
    if (!done.ok) { status.textContent = done.error ?? 'Sign-in failed.'; return; }
    $('claude-finish').hidden = true;
    status.textContent = ''; openAddForm(false); flash('Connected. Pick its model in the list.');
    await renderConnections();
  };
}

/** ChatGPT Plus/Pro: a code the owner enters on openai.com (the library opens it), then wait. */
async function signInChatgpt(): Promise<void> {
  const status = $('settings-status');
  const start = await ai.chatgptLoginStart();
  if (!start.ok || !start.data) { status.textContent = start.error ?? 'Could not start the sign-in.'; return; }
  const code = $('chatgpt-code');
  code.textContent = start.data.userCode;
  code.hidden = false;
  status.textContent = 'Enter this code on the openai.com page that just opened. Waiting…';
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    const poll = await ai.chatgptLoginPoll('ChatGPT (Plus/Pro)');
    if (!poll.ok) { status.textContent = poll.error ?? 'Sign-in failed.'; code.hidden = true; return; }
    if (poll.data?.status === 'created') {
      code.hidden = true;
      status.textContent = ''; openAddForm(false); flash('Connected. Pick its model in the list.');
      await renderConnections();
      return;
    }
  }
  code.hidden = true;
  status.textContent = 'The code expired. Start the sign-in again.';
}

async function addConnection(): Promise<void> {
  const status = $('settings-status');
  const provider = $<HTMLSelectElement>('provider').value;
  if (provider === 'claude-sub') return signInClaude();
  if (provider === 'chatgpt-sub') return signInChatgpt();
  if (provider === 'ollama-cloud') {
    status.textContent = 'Waiting for you to click Connect on ollama.com…';
    const start = await ai.ollamaLoginStart('Valet (Chrome)');
    if (!start.ok || !start.data) { status.textContent = start.error ?? 'Could not start the sign-in.'; return; }
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, start.data!.pollMs));
      const poll = await ai.ollamaLoginPoll('');
      if (!poll.ok) { status.textContent = poll.error ?? 'Sign-in failed.'; return; }
      if (poll.data?.status === 'created') break;
    }
    status.textContent = ''; openAddForm(false); flash('Connected. Pick its model in the list.');
    await renderConnections();
    return;
  }
  const spec = PROVIDERS[provider]!;
  const base = provider === 'custom' ? $<HTMLInputElement>('base').value.trim() : spec.base ?? '';
  const key = $<HTMLInputElement>('key').value.trim();
  if (spec.key && provider !== 'custom' && !key) { status.textContent = 'Enter the API key.'; return; }
  const saved = await ai.saveConnection({ kind: spec.kind, label: spec.label, baseUrl: base, model: '', apiKeyMode: key ? 'set' : 'keep', apiKey: key, makeActive: true });
  $<HTMLInputElement>('key').value = '';
  if (saved.ok) { openAddForm(false); flash('Connected. Pick its model in the list.'); } else status.textContent = saved.error ?? 'Could not save.';
  await renderConnections();
}

/** A one-line confirmation under the models list, gone after a few seconds. */
function flash(text: string): void {
  const status = $('settings-status');
  $('add-form').hidden = true;
  const note = document.getElementById('models-note') ?? Object.assign(document.createElement('p'), { id: 'models-note', className: 'muted status-line' });
  $('add-toggle').after(note);
  note.textContent = text;
  status.textContent = text;
  setTimeout(() => { if (note.textContent === text) note.textContent = ''; }, 5000);
  // A new connection is the active one: whoever shows it should know.
  onChange();
}

