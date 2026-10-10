/**
 * The agent loop with a scripted model and the real run controller over a
 * fake executor: one call id → one result, batches, guards, Stop, amendments,
 * and a restart mid-run.
 */
import type { AIChatRequest, AIChatResult, AIMessage } from '@amenophis1er/byok/types';
import { describe, expect, it } from 'vitest';
import { RunController, type ExecutorLike, type ScopeGate } from '../controller/controller.js';
import type { ExecutorObservation } from '../executor/commands.js';
import { PreconditionError, type Command } from '../executor/protocol.js';
import { AgentLoop, DRAFT_CHARS, MAX_ACTIONS, MAX_RUN_MS, trimDraft, type Connection, type LoopDeps, type Persisted } from './agent.js';
import { MAX_SKILL_CHARS } from '../skills/skills.js';
import type { PanelState, TranscriptEntry } from './protocol.js';
import type { Skill } from '../skills/skills.js';

const CONNECTION: Connection = { id: 'c1', revision: 3, label: 'Test', model: 'test-model' };

function page(): ExecutorObservation {
  return { id: 'x', url: 'https://shop.test/', title: 'Shop', tree: '- button "Go" [ref=e1]', targets: [{ ref: 'e1', frame: 0, role: 'button', name: 'Go' }],
    tabs: [], capturedAt: '', frames: [] };
}

type Turn = (request: AIChatRequest, signal: AbortSignal) => Promise<AIChatResult> | AIChatResult;

function harness(turns: Turn[], options: { saved?: Persisted; connection?: Connection | null; failNext?: Error[]; /** A fill fails once dispatch has begun: its outcome is unknown. */ failDispatched?: Error; scoped?: boolean; mode?: 'ask' | 'auto'; blockedAfter?: string; captureOrigin?: string; skills?: Skill[]; learning?: boolean; now?: () => number; /** skills.get waits for this: a run held in starting. */ skillsHeld?: Promise<void> } = {}) {
  const ran: Command[] = [];
  const requests: AIChatRequest[] = [];
  const failNext = options.failNext ?? [];
  let tab = false;
  const executor: ExecutorLike = {
    async run(command, cancel) {
      ran.push(command);
      const fail = failNext.shift();
      if (fail) throw fail;
      if (options.failDispatched && command.name === 'fill') { cancel?.dispatch(); throw options.failDispatched; }
      if (options.blockedAfter && command.name === 'click') blockedNext = [options.blockedAfter];
      if (command.name === 'navigate') tab = true;
      return {};
    },
    async observe() { return page(); },
    async capture(_session, _cancel, allow) {
      const origin = options.captureOrigin ?? 'https://shop.test';
      if (allow && !allow(origin)) throw new PreconditionError(`The tab is on ${origin}, which is not allowed for this run, so no screenshot was taken.`);
      return { data: 'SU1H', mediaType: 'image/jpeg', width: 1280, height: 800, masked: 0, viewport: { width: 1280, height: 800 }, masks: [] };
    },
    hasTab: () => tab,
  };
  const media = new Map<string, unknown>();
  let mediaFails = false;
  /** The ids Chrome was asked to print; `pdfFails` makes it refuse. */
  const printed: string[] = [];
  let pdfFails = false;
  let saveFails = false;
  let blockedNext: string[] = [];
  let loop: AgentLoop;
  const gate: ScopeGate = {
    verdict: (origin) => loop.verdict(origin),
    ask: (origin, reason) => loop.ask(origin, reason),
    takeBlocked: () => { const taken = blockedNext; blockedNext = []; return taken; },
  };
  const controller = new RunController(executor, { session: 's', ...(options.scoped ? { gate } : {}) });
  let mode: 'ask' | 'auto' = options.mode ?? 'ask';
  const contained: string[][] = [];
  let saved = options.saved;
  const states: PanelState[] = [];
  const adopted: number[] = [];
  const previews: Array<Record<string, unknown>> = [];
  let learning = options.learning ?? false;
  const notes: Array<{ text: string; why?: string; waiting: boolean } | null> = [];
  let released = 0;
  const deps: LoopDeps = {
    async chat(request, { signal }) {
      requests.push(structuredClone(request));
      const turn = turns.shift();
      if (!turn) return { ok: true, text: 'Done.', stopReason: 'end' };
      return turn(request, signal);
    },
    controller,
    async adopt(tabId) { if (tabId === 999) throw new PreconditionError('Only http and https addresses can be opened in your browser.'); adopted.push(tabId); tab = true; },
    release() { released += 1; },
    async closeTabs() { tab = false; },
    async highlight() {},
    async tabInfo() { return { title: 'Shop', url: 'https://shop.test/' }; },
    async workspace() { return tab ? { title: 'Shop', url: 'https://shop.test/' } : null; },
    async activeConnection() { return options.connection === undefined ? CONNECTION : options.connection; },
    storage: { async get() { return saved; }, async set(value) { if (saveFails) throw new Error('QUOTA_BYTES quota exceeded'); saved = structuredClone(value); }, async remove() { saved = undefined; } },
    mode: { async get() { return mode; }, async set(next) { mode = next; } },
    containment: { async apply(origins) { contained.push([...origins]); }, async clear() { contained.push([]); } },
    media: { async set(id, value) { if (mediaFails) throw new Error('QUOTA_BYTES quota exceeded'); media.set(id, value); }, async remove(ids) { for (const id of ids) media.delete(id); } },
    pdf: { async render(id) { printed.push(id); if (pdfFails) throw new Error('Chrome would not attach.'); return btoa(`%PDF ${JSON.stringify(media.get(id))}`); } },
    skills: { async get() { await options.skillsHeld; return options.skills ?? []; } },
    learning: { get: () => learning, async set(on) { learning = on; } },
    async preview(args) { previews.push(args); },
    async note(note) { notes.push(note); },
    emit(state) { states.push(state); },
    retryDelaysMs: [0, 0],
    ...(options.now ? { now: options.now } : {}),
  };
  loop = new AgentLoop(deps);
  return { loop, ran, requests, controller, states, adopted, previews, notes, saved: () => saved, mode: () => mode, contained, media, released: () => released, tabOpen: () => tab, failMedia: (on: boolean) => { mediaFails = on; }, failSave: (on: boolean) => { saveFails = on; }, printed, failPdf: (on: boolean) => { pdfFails = on; } };
}

const callTurn = (...calls: Array<{ id: string; name?: string; args?: Record<string, unknown>; argsError?: { raw: string; message: string } }>): Turn =>
  () => ({ ok: true, toolCalls: calls.map((call) => ({ ...call, name: call.name ?? 'browser' })), stopReason: 'tool_use' });
const lastObservationId = (request: AIChatRequest) => {
  const tool = [...request.messages].reverse().find((message) => message.role === 'tool' && String(message.content).includes('"observation"'));
  return (JSON.parse(String((tool as { content: string }).content)) as { observation: { id: string } }).observation.id;
};
/** Every assistant tool call has exactly one tool result, in order, before the next turn. */
function wellFormed(messages: AIMessage[]): boolean {
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]!;
    if (message.role !== 'assistant' || !message.toolCalls) continue;
    const answers = messages.slice(i + 1, i + 1 + message.toolCalls.length);
    if (answers.length !== message.toolCalls.length) return false;
    if (!answers.every((answer, k) => answer.role === 'tool' && answer.toolCallId === message.toolCalls![k]!.id)) return false;
  }
  return true;
}

describe('a run', () => {
  it('works in the handed tab: observe, act, answer — and pins the connection', async () => {
    const h = harness([
      callTurn({ id: 't1', args: { action: 'observe' } }),
      (request) => callTurn({ id: 't2', args: { action: 'click', observation: lastObservationId(request), target: { ref: 'e1' } } })(request, new AbortController().signal),
      () => ({ ok: true, text: 'Clicked Go.', stopReason: 'end' }),
    ]);
    await h.loop.run('Click go', 42);
    expect(h.adopted).toEqual([42]);
    expect(h.ran.map((command) => command.name)).toEqual(['click']);
    expect(h.loop.state.status).toBe('idle');
    expect(h.loop.state.transcript.map((entry) => entry.kind)).toEqual(['owner', 'action', 'action', 'agent']);
    expect(h.loop.state.handedTab).toEqual({ title: 'Shop', url: 'https://shop.test/' });
    expect(h.requests[0]).toMatchObject({ connectionId: 'c1', connectionRevision: 3, model: 'test-model', tools: [{ name: 'browser' }, { name: 'save_file' }] });
    expect(String(h.requests[0]!.messages[0]!.content)).toContain('You are working in that tab: observe it first.');
    expect(wellFormed(h.saved()!.history)).toBe(true);
  });

  it('answers every call of a batch: after a refusal the rest are skipped, not dispatched', async () => {
    const h = harness([
      callTurn({ id: 'a', args: { action: 'navigate', url: 'https://shop.test/' } }),
      callTurn({ id: 'b', args: { action: 'click', observation: 'stale', target: { ref: 'e1' } } }, { id: 'c', args: { action: 'observe' } }),
    ]);
    await h.loop.run('go');
    const history = h.saved()!.history;
    expect(wellFormed(history)).toBe(true);
    const results = history.filter((message) => message.role === 'tool').map((message) => JSON.parse(String(message.content)) as Record<string, unknown>);
    expect(results[1]).toHaveProperty('refused');
    expect(results[2]).toHaveProperty('skipped');
    expect(h.ran.map((command) => command.name)).toEqual(['navigate']);
  });

  it('answers invalid arguments with an error result instead of running anything', async () => {
    const h = harness([callTurn({ id: 'a', argsError: { raw: '{"act', message: 'Unexpected end' } })]);
    await h.loop.run('go');
    const tool = h.saved()!.history.find((message) => message.role === 'tool')!;
    expect(tool).toMatchObject({ isError: true });
    expect(String(tool.content)).toContain('not valid JSON');
    expect(h.ran).toEqual([]);
  });

  it('asks for a connection when there is none', async () => {
    const h = harness([], { connection: null });
    await h.loop.run('go');
    expect(h.loop.state.transcript).toEqual([{ kind: 'notice', text: 'Add an AI connection in Settings first.' }]);
    expect(h.requests).toEqual([]);
  });

  it('uses its own tab when the current page cannot be handed over', async () => {
    const h = harness([]);
    await h.loop.run('go', 999);
    expect(h.loop.state.handedTab).toBeNull();
    expect(h.loop.state.transcript.slice(0, 2)).toMatchObject([{ kind: 'owner', text: 'go' }, { kind: 'notice', text: expect.stringMatching(/only http and https/) }]);
    expect(String(h.requests[0]!.messages[0]!.content)).toContain('No tab was handed over');
  });
});

describe('guards and the owner', () => {
  it('stops mid-request: the model call is aborted and nothing more is dispatched', async () => {
    let release: () => void = () => undefined;
    const h = harness([(_request, signal) => new Promise((resolve) => {
      release = () => resolve({ ok: false, error: 'Stopped.' });
      signal.addEventListener('abort', () => release());
    })]);
    const running = h.loop.run('go');
    await new Promise((resolve) => setTimeout(resolve, 5));
    await h.loop.stop();
    await running;
    expect(h.loop.state.status).toBe('idle');
    expect(h.loop.state.transcript.at(-1)).toEqual({ kind: 'notice', text: 'Stopped.' });
    expect(h.ran).toEqual([]);
  });

  it('feeds a message sent during a run to the next model turn', async () => {
    let loop!: AgentLoop;
    const h = harness([
      async (request) => { await loop.run('also check the price'); return callTurn({ id: 'a', args: { action: 'observe' } })(request, new AbortController().signal); },
      () => ({ ok: true, text: 'ok', stopReason: 'end' }),
    ]);
    loop = h.loop;
    await h.loop.run('find the mug');
    const second = h.requests[1]!.messages;
    expect(second.at(-1)).toEqual({ role: 'user', content: 'also check the price' });
    expect(wellFormed(second.slice(0, -1))).toBe(true);
  });

  it('stops after 20 minutes of one run', async () => {
    let clock = 1_000;
    const h = harness([
      (request, signal) => { clock += MAX_RUN_MS + 1; return callTurn({ id: 'n', args: { action: 'navigate', url: 'https://shop.test/' } })(request, signal); },
      () => ({ ok: true, text: 'never reached', stopReason: 'end' }),
    ], { now: () => clock });
    await h.loop.run('take your time');
    expect(h.loop.state.status).toBe('idle');
    expect(h.loop.state.transcript.at(-1)).toMatchObject({ kind: 'notice', text: expect.stringMatching(/20 minutes/) });
    expect(h.loop.state.transcript.some((entry) => entry.kind === 'agent')).toBe(false);
  });

  it(`stops at ${MAX_ACTIONS} actions even inside one batch`, async () => {
    const calls = Array.from({ length: MAX_ACTIONS + 5 }, (_, i) => ({ id: `o${i}`, args: { action: 'observe' } }));
    const h = harness([callTurn(...calls)]);
    await h.loop.run('do it all at once');
    expect(h.loop.state.actions).toBe(MAX_ACTIONS);
    expect(h.ran.filter((command) => command.name === 'observe').length).toBeLessThanOrEqual(MAX_ACTIONS);
    expect(h.loop.state.transcript.at(-1)).toMatchObject({ kind: 'notice', text: expect.stringMatching(/limit for one run/) });
    expect(wellFormed(h.saved()!.history)).toBe(true);
  });

  it('a message queued mid-run survives a worker restart', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const h = harness([async () => { await gate; return { ok: false, error: 'the worker died', retryable: false }; }]);
    const running = h.loop.run('go');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await h.loop.run('and this too');
    expect(h.saved()?.amendments).toEqual(['and this too']);
    release();
    await running;
    // A new loop over the same storage picks the message up and gives it to the model after Resume.
    const later = harness([({ messages }) => ({ ok: true, text: `Heard: ${String(messages.at(-1)!.content)}`, stopReason: 'end' })], { saved: { ...h.saved()!, status: 'running' } });
    await later.loop.restore();
    expect(later.loop.state.status).toBe('paused');
    await later.loop.resume();
    expect(later.loop.state.transcript.at(-1)).toMatchObject({ kind: 'agent', text: 'Heard: and this too' });
  });

  it(`stops at ${MAX_ACTIONS} actions`, async () => {
    const turns: Turn[] = Array.from({ length: MAX_ACTIONS + 5 }, (_, i) => callTurn({ id: `o${i}`, args: { action: 'observe' } }));
    const h = harness(turns);
    await h.loop.run('loop forever');
    expect(h.loop.state.actions).toBe(MAX_ACTIONS);
    expect(h.loop.state.transcript.at(-1)).toMatchObject({ kind: 'notice', text: expect.stringMatching(/limit for one run/) });
  });

  it('a step whose outcome is unknown pauses the run, and the owner is told which step and why in plain words', async () => {
    const h = harness([
      callTurn({ id: 'n', args: { action: 'navigate', url: 'https://shop.test/' } }),
      (request) => callTurn({ id: 'f', args: { action: 'fill', observation: lastObservationId(request), target: { ref: 'e1' }, value: 'Testing Test' } })(request, new AbortController().signal),
    ], { failDispatched: new Error('Chrome took the debugger away.') });
    await h.loop.run('search the customer');
    expect(h.loop.state.status).toBe('paused');
    expect(h.loop.state.transcript.at(-2)).toMatchObject({ kind: 'action', outcome: 'unknown' });
    expect(h.loop.state.pauseReason).toMatch(/^The step "Type into .*" was sent to the page, but whether it went through is not known \(Chrome took the debugger away\)\. Look at the page/);
    expect(h.loop.state.pauseReason).not.toMatch(/partially completed/);
  });

  it('Learning: a Next clicked while the step is still being shown is not lost, and Learning off ends the wait', async () => {
    const h = harness([
      callTurn({ id: 'n', args: { action: 'navigate', url: 'https://shop.test/' } }),
      () => ({ ok: true, text: 'Opened.', stopReason: 'end' }),
    ], { learning: true });
    const running = h.loop.run('open the shop');
    // The step is published (stepWait in the emitted state) before the preview and the bubble are awaited: Next now must count.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const shown = h.states.some((state) => state.stepWait?.text === 'Open https://shop.test/');
    expect(shown).toBe(true);
    h.loop.step();
    await running;
    expect(h.loop.state.status).toBe('idle');
    expect(h.loop.state.transcript.at(-1)).toMatchObject({ kind: 'agent', text: 'Opened.' });
  });

  it('a storage failure at the end of a run still ends it for the panel, with a word about it', async () => {
    const h = harness([() => { h.failSave(true); return { ok: true, text: 'Done.', stopReason: 'end' }; }]);
    await expect(h.loop.run('go')).resolves.toBeUndefined();
    expect(h.loop.state.status).toBe('idle');
    expect(h.states.at(-1)?.status).toBe('idle');
    expect(h.loop.state.transcript.at(-1)).toMatchObject({ kind: 'notice', text: expect.stringMatching(/could not be saved/) });
  });

  it('a message sent while paused resumes the run with it, instead of pausing again with the stale reason', async () => {
    const stale = (id: string) => callTurn({ id, args: { action: 'click', observation: 'stale', target: { ref: 'e1' } } });
    const h = harness([callTurn({ id: 'n', args: { action: 'navigate', url: 'https://shop.test/' } }), stale('1'), stale('2'), stale('3'),
      () => ({ ok: true, text: 'Took the other way.', stopReason: 'end' })]);
    await h.loop.run('go');
    expect(h.loop.state.status).toBe('paused');
    await h.loop.run('try the other link instead');
    expect(h.loop.state.status).toBe('idle');
    expect(h.loop.state.transcript.at(-1)).toMatchObject({ kind: 'agent', text: 'Took the other way.' });
    // The message reached the model as the latest word from the owner, and no second pause was reported after it.
    const last = h.requests.at(-1)!.messages;
    expect(last.at(-1)).toEqual({ role: 'user', content: 'try the other link instead' });
    const owner = h.loop.state.transcript.findIndex((entry) => entry.kind === 'owner' && entry.text === 'try the other link instead');
    expect(h.loop.state.transcript.slice(owner).some((entry) => entry.kind === 'notice' && /^Paused/.test(entry.text))).toBe(false);
  });

  it('two quick sends start one loop: the second joins the run as an amendment', async () => {
    // The model's first turn waits until the second send is in, so the test does not hang on timing.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const h = harness([
      async (request, signal) => { await gate; return callTurn({ id: 'n', args: { action: 'navigate', url: 'https://shop.test/' } })(request, signal); },
      () => ({ ok: true, text: 'Done both.', stopReason: 'end' }),
    ]);
    const first = h.loop.run('find the mug');
    await h.loop.run('and check the price');
    release();
    await first;
    expect(h.requests).toHaveLength(2);
    expect(h.loop.state.transcript.filter((entry) => entry.kind === 'owner').map((entry) => entry.text)).toEqual(['find the mug', 'and check the price']);
    // Sent to the model once, as its own turn from the owner.
    const users = h.requests.at(-1)!.messages.filter((message) => message.role === 'user').map((message) => String(message.content));
    expect(users.filter((content) => content === 'and check the price')).toHaveLength(1);
    expect(h.loop.state.status).toBe('idle');
  });

  it('a message sent while the model writes its final answer is heard before the run ends', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const h = harness([
      callTurn({ id: 'n', args: { action: 'navigate', url: 'https://shop.test/' } }),
      async () => { await gate; return { ok: true, text: 'All done.', stopReason: 'end' }; },
      ({ messages }) => ({ ok: true, text: `Heard: ${String(messages.at(-1)!.content)}`, stopReason: 'end' }),
    ]);
    const running = h.loop.run('go');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await h.loop.run('also the price');
    release();
    await running;
    expect(h.loop.state.transcript.at(-1)).toMatchObject({ kind: 'agent', text: 'Heard: also the price' });
    expect(h.loop.state.status).toBe('idle');
  });

  it('a new conversation after a controller pause starts fresh, not paused', async () => {
    const stale = (id: string) => callTurn({ id, args: { action: 'click', observation: 'stale', target: { ref: 'e1' } } });
    const h = harness([callTurn({ id: 'n', args: { action: 'navigate', url: 'https://shop.test/' } }), stale('1'), stale('2'), stale('3'),
      () => ({ ok: true, text: 'Fresh start.', stopReason: 'end' })]);
    await h.loop.run('go');
    expect(h.loop.state.status).toBe('paused');
    await h.loop.newConversation();
    await h.loop.run('again');
    expect(h.loop.state.status).toBe('idle');
    expect(h.loop.state.transcript.map((entry) => entry.kind)).toEqual(['owner', 'agent']);
  });

  it('pauses when the controller pauses, and resumes with the counters reset', async () => {
    const stale = (id: string) => callTurn({ id, args: { action: 'click', observation: 'stale', target: { ref: 'e1' } } });
    const h = harness([callTurn({ id: 'n', args: { action: 'navigate', url: 'https://shop.test/' } }), stale('1'), stale('2'), stale('3')]);
    await h.loop.run('go');
    expect(h.loop.state.status).toBe('paused');
    expect(h.loop.state.pauseReason).toMatch(/Repeated targeting failures/);
    await h.loop.resume();
    expect(h.controller.refusals).toBe(0);
    expect(h.loop.state.status).toBe('idle');
  });

  it('pauses after a restart mid-run and answers the call that was in flight as uncertain', async () => {
    const saved: Persisted = {
      history: [{ role: 'user', content: 'go' }, { role: 'assistant', toolCalls: [{ id: 'x1', name: 'browser', args: { action: 'click' } }] }],
      transcript: [{ kind: 'owner', text: 'go' }], status: 'running', actions: 1, startedAt: 0, connection: CONNECTION, handedTab: null, scope: { mode: 'ask', runOrigins: [], chatOrigins: [], deniedOrigins: [], chatSubmissions: [], deniedSubmissions: [] },
    };
    const h = harness([], { saved });
    await h.loop.restore();
    expect(h.loop.state.status).toBe('paused');
    const history = h.saved()!.history;
    expect(wellFormed(history)).toBe(true);
    expect(JSON.parse(String(history.at(-1)!.content))).toMatchObject({ completed: 'unknown' });
  });
});

describe('run scope and cards', () => {
  /** Answer the next card that appears. */
  function answerNextCard(h: ReturnType<typeof harness>, decision: 'once' | 'chat' | 'auto' | 'deny') {
    const timer = setInterval(() => {
      const approval = h.loop.state.approval;
      if (approval) { clearInterval(timer); void h.loop.decide(approval.id, decision); }
    }, 1);
  }

  it('asks before opening a new site, and dispatches nothing when denied', async () => {
    const h = harness([callTurn({ id: 'a', args: { action: 'navigate', url: 'https://attacker.test/?q=secret' } })], { scoped: true });
    answerNextCard(h, 'deny');
    await h.loop.run('go');
    expect(h.ran).toEqual([]);
    const result = JSON.parse(String(h.saved()!.history.find((message) => message.role === 'tool')!.content)) as { refused: string };
    expect(result.refused).toMatch(/did not allow https:\/\/attacker\.test/);
    expect(h.loop.state.approval).toBeUndefined();
  });

  it('dispatches after Allow once, and puts the origin in the containment rules', async () => {
    const h = harness([callTurn({ id: 'a', args: { action: 'navigate', url: 'https://shop.test/' } })], { scoped: true });
    answerNextCard(h, 'once');
    await h.loop.run('go');
    expect(h.ran.map((command) => command.name)).toEqual(['navigate']);
    expect(h.contained.some((origins) => origins.includes('https://shop.test'))).toBe(true);
    // Rules are cleared once the run is over.
    expect(h.contained.at(-1)).toEqual([]);
  });

  /** Whether a card appears while `run` runs. */
  async function asks(h: ReturnType<typeof harness>, goal: string, newTab = false): Promise<boolean> {
    const before = h.states.length;
    await h.loop.run(goal, undefined, newTab);
    return h.states.slice(before).some((state) => state.approval);
  }

  it('Allow once lasts one request; Allow in this chat, the conversation; New conversation forgets both', async () => {
    const navigate = (id: string, url: string) => callTurn({ id, args: { action: 'navigate', url } });
    const end = () => ({ ok: true, text: 'ok', stopReason: 'end' as const });
    // The fake page is always on shop.test, so every step is about that one site.
    const h = harness([navigate('a', 'https://shop.test/'), end, navigate('b', 'https://shop.test/2'), end,
      navigate('c', 'https://shop.test/3'), end, navigate('d', 'https://shop.test/4'), end, navigate('e', 'https://shop.test/5')], { scoped: true });
    answerNextCard(h, 'once');
    await h.loop.run('first');
    answerNextCard(h, 'once');
    // In a tab of its own (not continuing on the page it is on), Allow once does not carry over.
    expect(await asks(h, 'second: once does not carry over', true)).toBe(true);
    answerNextCard(h, 'chat');
    await h.loop.run('third', undefined, true);
    expect(await asks(h, 'fourth: the chat approval does', true)).toBe(false);
    await h.loop.newConversation();
    answerNextCard(h, 'deny');
    expect(await asks(h, 'a new conversation starts over')).toBe(true);
  });

  it('discard: the tab the conversation was opened on closed, so nothing of it is kept, but its tabs are not closed', async () => {
    const h = harness([() => ({ ok: true, text: 'Done.', stopReason: 'end' })]);
    await h.loop.run('first', 7);
    expect(h.saved()?.transcript.length).toBeGreaterThan(0);
    await h.loop.discard();
    expect(h.saved()).toBeUndefined();
    expect(h.loop.state.transcript).toEqual([]);
    expect(h.loop.state.status).toBe('idle');
    // closeTabs was not called: the tab is still there, the owner's.
    expect(h.tabOpen()).toBe(true);
    expect(h.states.at(-1)?.transcript).toEqual([]);
  });

  it('Auto approves every site without a card, turns containment off, and the next conversation starts in it', async () => {
    const h = harness([
      callTurn({ id: 'a', args: { action: 'navigate', url: 'https://shop.test/' } }),
      callTurn({ id: 'b', args: { action: 'navigate', url: 'https://news.test/' } }),
      () => ({ ok: true, text: 'ok', stopReason: 'end' }),
      callTurn({ id: 'c', args: { action: 'navigate', url: 'https://elsewhere.test/' } }),
    ], { scoped: true });
    answerNextCard(h, 'auto');
    await h.loop.run('first');
    expect(h.ran.map((command) => String(command.args['url']))).toEqual(['https://shop.test/', 'https://news.test/']);
    expect(h.loop.state.mode).toBe('auto');
    expect(h.mode()).toBe('auto');
    await h.loop.newConversation();
    expect(h.loop.state.mode).toBe('auto');
    expect(await asks(h, 'second')).toBe(false);
    expect(h.loop.state.transcript.some((entry) => entry.kind === 'notice' && /Auto is on, as in your last conversation/.test(entry.text))).toBe(true);
    await h.loop.setMode('ask');
    expect(h.mode()).toBe('ask');
    expect(h.loop.verdict('https://unseen.test')).toBe('ask');
  });

  it('continues a follow-up where the conversation already is: nothing released, nothing handed, no card for that page', async () => {
    const end = () => ({ ok: true, text: 'ok', stopReason: 'end' as const });
    const h = harness([end, callTurn({ id: 'b', args: { action: 'navigate', url: 'https://shop.test/next' } }), end], { scoped: true });
    await h.loop.run('first', 42);
    const releases = h.released();
    await h.loop.run('follow-up');
    expect(h.released()).toBe(releases);
    expect(h.adopted).toEqual([42]);
    expect(h.loop.state.handedTab).toEqual({ title: 'Shop', url: 'https://shop.test/' });
    expect(h.loop.state.workspace).toEqual({ title: 'Shop', url: 'https://shop.test/' });
    expect(h.ran.map((command) => command.name)).toEqual(['navigate']);
    expect(h.states.some((state) => state.approval)).toBe(false);
  });

  it('hands over another tab on a follow-up only when the owner picks it', async () => {
    const end = () => ({ ok: true, text: 'ok', stopReason: 'end' as const });
    const h = harness([end, end]);
    await h.loop.run('first', 42);
    await h.loop.run('now this one', 43);
    expect(h.adopted).toEqual([42, 43]);
  });

  it('never asks about the page the owner handed over', async () => {
    const h = harness([callTurn({ id: 'a', args: { action: 'navigate', url: 'https://shop.test/other' } })], { scoped: true });
    await h.loop.run('go', 42);
    expect(h.ran.map((command) => command.name)).toEqual(['navigate']);
  });

  it('answers the card with Deny when the owner presses Stop', async () => {
    const h = harness([callTurn({ id: 'a', args: { action: 'navigate', url: 'https://elsewhere.test/' } })], { scoped: true });
    const running = h.loop.run('go');
    while (!h.loop.state.approval) await new Promise((resolve) => setTimeout(resolve, 1));
    await h.loop.stop();
    await running;
    expect(h.ran).toEqual([]);
    expect(h.loop.state.status).toBe('idle');
  });

  it('reports a blocked navigation with the action\'s own status, asks, and never re-runs the action', async () => {
    const h = harness([
      (request) => callTurn({ id: 'o', args: { action: 'observe' } })(request, new AbortController().signal),
      (request) => callTurn({ id: 'c', args: { action: 'click', observation: lastObservationId(request), target: { ref: 'e1' } } })(request, new AbortController().signal),
      () => ({ ok: true, text: 'done', stopReason: 'end' }),
    ], { scoped: true, blockedAfter: 'https://attacker.test' });
    answerNextCard(h, 'deny');
    await h.loop.run('submit it', 42);
    expect(h.ran.map((command) => command.name)).toEqual(['click']);
    const results = h.saved()!.history.filter((message) => message.role === 'tool').map((message) => JSON.parse(String(message.content)) as Record<string, unknown>);
    expect(results[1]).toMatchObject({ completed: true, observed: false });
    expect(String(results[1]!['message'])).toMatch(/tried to go to https:\/\/attacker\.test.*nothing was sent there.*do not repeat it/);
  });
});


describe('model request failures', () => {
  it('sends the request again after a dropped connection, and the run goes on', async () => {
    const h = harness([
      () => ({ ok: false, error: 'The connection to Anthropic dropped (network error).', retryable: true }),
      () => ({ ok: true, text: 'Done after all.', stopReason: 'end' }),
    ]);
    await h.loop.run('go');
    expect(h.requests).toHaveLength(2);
    expect(h.loop.state.transcript.at(-1)).toEqual({ kind: 'agent', text: 'Done after all.' });
    expect(h.loop.state.transcript.some((entry) => entry.kind === 'notice' && /dropped .* Trying again/.test(entry.text))).toBe(true);
  });

  it('gives up after two more tries, and never retries a request the provider refused', async () => {
    const dropped = () => ({ ok: false, error: 'The connection dropped.', retryable: true });
    const h = harness([dropped, dropped, dropped, () => ({ ok: true, text: 'unused', stopReason: 'end' })]);
    await h.loop.run('go');
    expect(h.requests).toHaveLength(3);
    expect(h.loop.state.status).toBe('idle');
    expect(h.loop.state.transcript.at(-1)).toMatchObject({ kind: 'notice', text: expect.stringContaining('The model request failed: The connection dropped.') });
    const refused = harness([() => ({ ok: false, error: 'HTTP 400: bad request' }), () => ({ ok: true, text: 'unused', stopReason: 'end' })]);
    await refused.loop.run('go');
    expect(refused.requests).toHaveLength(1);
  });
});

describe('screenshots and files', () => {
  const shot = (id: string) => callTurn({ id, args: { action: 'screenshot' } });
  const images = (request: AIChatRequest) => request.messages.filter((message) => Array.isArray(message.content) && message.content.some((part) => part.type === 'image')).length;

  it('sends a screenshot to the model as part of the tool result, and keeps it for the owner', async () => {
    const h = harness([callTurn({ id: 'n', args: { action: 'navigate', url: 'https://shop.test/' } }), shot('s1')]);
    await h.loop.run('Look at it');
    expect(h.ran.map((command) => command.name)).toEqual(['navigate']);
    const tool = h.requests[2]!.messages.find((message) => message.role === 'tool' && message.toolCallId === 's1')!;
    expect(tool.content).toEqual([expect.objectContaining({ type: 'text' }), { type: 'image', mediaType: 'image/jpeg', data: 'SU1H' }]);
    const entry = h.loop.state.transcript.find((item) => item.kind === 'action' && item.image);
    expect(entry).toMatchObject({ text: 'Took a screenshot', outcome: 'ok', image: { width: 1280, height: 800 } });
    const id = (entry as { image: { id: string } }).image.id;
    expect(h.media.get(id)).toEqual({ kind: 'image', mediaType: 'image/jpeg', data: 'SU1H' });
    expect(wellFormed(h.saved()!.history)).toBe(true);
  });

  it('refuses a screenshot of a site outside the run, without counting it as a targeting refusal', async () => {
    const h = harness([shot('s1')], { scoped: true, captureOrigin: 'https://elsewhere.test' });
    await h.loop.run('Look', 42);
    const tool = h.requests[1]!.messages.find((message) => message.role === 'tool')!;
    expect(String(tool.content)).toContain('no screenshot was taken');
    expect(h.controller.refusals).toBe(0);
    expect(h.media.size).toBe(0);
  });

  it('shows the model only its newest screenshots, and the owner only the newest dozen', async () => {
    const turns = [callTurn({ id: 'n', args: { action: 'navigate', url: 'https://shop.test/' } })];
    for (let i = 0; i < 14; i += 1) turns.push(shot(`s${i}`));
    const h = harness(turns);
    await h.loop.run('Look a lot');
    expect(images(h.requests.at(-1)!)).toBe(2);
    const kept = h.loop.state.transcript.filter((item) => item.kind === 'action' && item.image && !item.image.expired);
    expect(kept).toHaveLength(12);
    expect(h.media.size).toBe(12);
  });

  it('goes on without images when the model rejects them, and says so once', async () => {
    const h = harness([
      callTurn({ id: 'n', args: { action: 'navigate', url: 'https://shop.test/' } }),
      shot('s1'),
      (request) => (images(request) > 0 ? { ok: false, error: 'image input is not supported' } : { ok: true, text: 'Looked.', stopReason: 'end' }),
      (request) => (images(request) > 0 ? { ok: false, error: 'image input is not supported' } : { ok: true, text: 'Looked.', stopReason: 'end' }),
    ]);
    await h.loop.run('Look');
    expect(h.loop.state.status).toBe('idle');
    expect(h.loop.state.transcript.at(-1)).toEqual({ kind: 'agent', text: 'Looked.' });
    expect(h.loop.state.transcript.filter((item) => item.kind === 'notice' && /could not take images/.test(item.text))).toHaveLength(1);
    expect(h.saved()!.noVision).toBe(true);
  });

  it('tells a model that cannot see images that it knows nothing about the screenshot', async () => {
    const h = harness([
      callTurn({ id: 'n', args: { action: 'navigate', url: 'https://shop.test/' } }),
      shot('s1'),
      // Once with the image (refused), once again without it, where it takes another screenshot.
      ...[1, 2].map((): Turn => (request) => (images(request) > 0 ? { ok: false, error: 'image input is not supported' } : callTurn({ id: 's2', args: { action: 'screenshot' } })(request, new AbortController().signal))),
    ]);
    await h.loop.run('Look');
    const told = h.requests.at(-1)!.messages.filter((message) => message.role === 'tool').map((message) => String(message.content));
    expect(told.some((text) => /You did not receive this image/.test(text))).toBe(true);
    expect(told.some((text) => /The screenshot was not sent to you/.test(text))).toBe(true);
  });

  it('does not blame images for a request that fails without them too', async () => {
    const h = harness([
      callTurn({ id: 'n', args: { action: 'navigate', url: 'https://shop.test/' } }),
      shot('s1'),
      () => ({ ok: false, error: 'rate limited' }),
      () => ({ ok: false, error: 'rate limited' }),
    ]);
    await h.loop.run('Look');
    expect(h.saved()!.noVision).toBeFalsy();
    expect(h.loop.state.transcript.at(-1)).toMatchObject({ kind: 'notice', text: expect.stringContaining('rate limited') });
  });

  it('keeps vision after a failure that says nothing about images, even when the next request succeeds', async () => {
    const h = harness([
      callTurn({ id: 'n', args: { action: 'navigate', url: 'https://shop.test/' } }),
      shot('s1'),
      () => ({ ok: false, error: 'HTTP 503: overloaded' }),
    ]);
    await h.loop.run('Look');
    await h.loop.run('Try again');
    expect(h.saved()!.noVision).toBeFalsy();
    expect(images(h.requests.at(-1)!)).toBe(1);
  });

  it('answers the call when storage refuses a screenshot or a file, so the next request is well formed', async () => {
    const h = harness([
      callTurn({ id: 'n', args: { action: 'navigate', url: 'https://shop.test/' } }),
      shot('s1'),
      callTurn({ id: 'f', name: 'save_file', args: { filename: 'a.txt', content: 'x' } }),
    ]);
    h.failMedia(true);
    await h.loop.run('Both');
    expect(wellFormed(h.saved()!.history)).toBe(true);
    expect(wellFormed(h.requests.at(-1)!.messages)).toBe(true);
    const answers = h.saved()!.history.filter((message) => message.role === 'tool' && (message.toolCallId === 's1' || message.toolCallId === 'f'));
    expect(answers.map((answer) => answer.role === 'tool' && answer.isError)).toEqual([true, true]);
    expect(h.media.size).toBe(0);
  });

  it('keeps files within their byte budget, newest first', async () => {
    const big = 'x'.repeat(150_000);
    const turns: Turn[] = [];
    for (let i = 0; i < 15; i += 1) turns.push(callTurn({ id: `f${i}`, name: 'save_file', args: { filename: `f${i}.txt`, content: big } }));
    const h = harness(turns);
    await h.loop.run('Many files');
    const files = h.loop.state.transcript.filter((item) => item.kind === 'file');
    const kept = files.filter((item) => item.kind === 'file' && !item.expired);
    expect(kept.length).toBe(13);
    expect(h.media.size).toBe(13);
    expect((files[0] as { expired?: boolean }).expired).toBe(true);
  });

  it('asks for a new conversation instead of outgrowing storage', async () => {
    const huge = 'y'.repeat(190_000);
    const turns: Turn[] = [];
    for (let i = 0; i < 30; i += 1) turns.push(callTurn({ id: `f${i}`, name: 'save_file', args: { filename: `f${i}.txt`, content: huge } }));
    const h = harness(turns);
    await h.loop.run('Too much');
    expect(h.loop.state.transcript.at(-1)).toMatchObject({ kind: 'notice', text: expect.stringContaining('Start a new conversation') });
    await h.loop.run('More');
    expect(h.loop.state.transcript.at(-1)).toMatchObject({ kind: 'notice', text: expect.stringContaining('Start a new conversation') });
    expect(h.loop.state.status).toBe('idle');
  });

  it('makes a file for the owner to download, and never counts it as a browser action', async () => {
    const h = harness([callTurn({ id: 'f', name: 'save_file', args: { filename: '../../lomé summary.html', content: 'Lomé is the capital.' } })]);
    await h.loop.run('Save it');
    const file = h.loop.state.transcript.find((item) => item.kind === 'file');
    expect(file).toMatchObject({ kind: 'file', name: 'lom- summary.html.txt', mimeType: 'text/plain', bytes: 21 });
    expect(h.media.get((file as { id: string }).id)).toEqual({ kind: 'file', name: 'lom- summary.html.txt', mimeType: 'text/plain', content: 'Lomé is the capital.' });
    expect(h.loop.state.actions).toBe(0);
    expect(h.requests[0]!.tools!.map((tool) => tool.name)).toEqual(['browser', 'save_file']);
    const tool = h.requests[1]!.messages.find((message) => message.role === 'tool')!;
    expect(String(tool.content)).toContain('do not say it was downloaded');
  });

  it('makes a PDF from Markdown: the source is stored for Chrome to print, then replaced by the PDF', async () => {
    const h = harness([callTurn({ id: 'f', name: 'save_file', args: { filename: 'report.pdf', content: '# Report\n\nAll good.' } })]);
    await h.loop.run('Make a report');
    const file = h.loop.state.transcript.find((item) => item.kind === 'file') as Extract<TranscriptEntry, { kind: 'file' }>;
    expect(file).toMatchObject({ kind: 'file', name: 'report.pdf', mimeType: 'application/pdf' });
    expect(h.printed).toEqual([file.id]);
    const stored = h.media.get(file.id) as { kind: string; name: string; data: string };
    expect(stored).toMatchObject({ kind: 'pdf', name: 'report.pdf' });
    // What Chrome printed was the Markdown stored under the same id.
    expect(atob(stored.data)).toContain('"kind":"file","name":"report.md","mimeType":"text/markdown","content":"# Report');
    expect(file.bytes).toBe(atob(stored.data).length);
    expect(h.loop.state.actions).toBe(0);
    const tool = h.requests[1]!.messages.find((message) => message.role === 'tool')!;
    expect(tool).not.toHaveProperty('isError', true);
    expect(String(tool.content)).toContain('report.pdf');
  });

  it('keeps the Markdown as a .md, and says so to the model, when Chrome cannot print', async () => {
    const h = harness([callTurn({ id: 'f', name: 'save_file', args: { filename: 'report.pdf', content: '# Report' } })]);
    h.failPdf(true);
    await h.loop.run('Make a report');
    const file = h.loop.state.transcript.find((item) => item.kind === 'file') as Extract<TranscriptEntry, { kind: 'file' }>;
    expect(file).toMatchObject({ kind: 'file', name: 'report.md', mimeType: 'text/markdown', bytes: 8 });
    expect(h.media.get(file.id)).toEqual({ kind: 'file', name: 'report.md', mimeType: 'text/markdown', content: '# Report' });
    const tool = h.requests[1]!.messages.find((message) => message.role === 'tool')!;
    expect(tool).not.toHaveProperty('isError', true);
    expect(String(tool.content)).toContain('The PDF could not be made (Chrome would not attach.)');
    expect(String(tool.content)).toContain('saved as Markdown instead');
  });

  it('answers a malformed save_file call with an error and makes nothing', async () => {
    const h = harness([callTurn({ id: 'f', name: 'save_file', args: { content: 'x' } })]);
    await h.loop.run('Save it');
    const tool = h.requests[1]!.messages.find((message) => message.role === 'tool')!;
    expect(tool).toMatchObject({ isError: true });
    expect(h.media.size).toBe(0);
  });

  it('forgets every stored screenshot and file with the conversation', async () => {
    const h = harness([
      callTurn({ id: 'n', args: { action: 'navigate', url: 'https://shop.test/' } }),
      shot('s1'),
      callTurn({ id: 'f', name: 'save_file', args: { filename: 'a.md', content: '# A' } }),
    ]);
    await h.loop.run('Both');
    expect(h.media.size).toBe(2);
    await h.loop.newConversation();
    expect(h.media.size).toBe(0);
  });
});

describe('attachments', () => {
  const image = { kind: 'image' as const, name: 'mug.jpg', mimeType: 'image/jpeg', bytes: 900, data: 'SU1H', width: 40, height: 30 };
  const pdf = { kind: 'pdf' as const, name: 'report.pdf', mimeType: 'application/pdf', bytes: 5, data: 'JVBERi0=' };

  it('sends the owner\'s files with their message, and shows images in it from storage', async () => {
    const h = harness([() => ({ ok: true, text: 'Seen.', stopReason: 'end' })]);
    await h.loop.run('What is this?', undefined, false, [image, pdf]);
    const first = h.requests[0]!.messages[0]!;
    expect(Array.isArray(first.content) && first.content.map((part) => part.type)).toEqual(['text', 'text', 'image', 'document']);
    const owner = h.loop.state.transcript[0]!;
    expect(owner).toMatchObject({ kind: 'owner', text: 'What is this?', attachments: [{ kind: 'image', name: 'mug.jpg', width: 40, height: 30 }, { kind: 'pdf', name: 'report.pdf' }] });
    const id = (owner as { attachments: Array<{ id?: string }> }).attachments[0]!.id!;
    expect(h.media.get(id)).toEqual({ kind: 'image', mediaType: 'image/jpeg', data: 'SU1H' });
    expect((owner as { attachments: Array<{ id?: string }> }).attachments[1]!.id).toBeUndefined();
  });

  it('starts a run from attachments alone', async () => {
    const h = harness([() => ({ ok: true, text: 'Seen.', stopReason: 'end' })]);
    await h.loop.run('', undefined, false, [image]);
    expect(h.requests).toHaveLength(1);
    expect(h.loop.state.transcript[0]).toMatchObject({ kind: 'owner', text: '' });
  });

  it('refuses attachments past the limits before anything is sent', async () => {
    const h = harness([]);
    await h.loop.run('Too many', undefined, false, Array.from({ length: 7 }, () => image));
    expect(h.requests).toHaveLength(0);
    expect(h.loop.state.transcript.at(-1)).toMatchObject({ kind: 'notice', text: expect.stringContaining('at most 6') });
    expect(h.media.size).toBe(0);
  });

  it('adds files sent while the agent works to its next turn', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const h = harness([
      async () => { await gate; return { ok: true, toolCalls: [{ id: 'o', name: 'browser', args: { action: 'observe' } }], stopReason: 'tool_use' }; },
      () => ({ ok: true, text: 'Got it.', stopReason: 'end' }),
    ]);
    const running = h.loop.run('Start', 42);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await h.loop.run('Also this', undefined, false, [pdf]);
    release();
    await running;
    const amendment = h.requests[1]!.messages.find((message) => message.role === 'user' && Array.isArray(message.content));
    expect(amendment && Array.isArray(amendment.content) && amendment.content.map((part) => part.type)).toEqual(['text', 'document']);
  });

  it('keeps what the owner attached when old screenshots age out, and drops it for a model that cannot read it', async () => {
    const turns = [callTurn({ id: 'n', args: { action: 'navigate', url: 'https://shop.test/' } })];
    for (let i = 0; i < 4; i += 1) turns.push(callTurn({ id: `s${i}`, args: { action: 'screenshot' } }));
    const h = harness(turns);
    await h.loop.run('Look', undefined, false, [image]);
    const last = h.requests.at(-1)!;
    const owner = last.messages[0]!;
    expect(Array.isArray(owner.content) && owner.content.some((part) => part.type === 'image')).toBe(true);
    const shots = last.messages.filter((message) => message.role === 'tool' && Array.isArray(message.content) && message.content.some((part) => part.type === 'image'));
    expect(shots).toHaveLength(2);
  });

  it('stores the panel\'s small copy of an attached image, not a second full one', async () => {
    const h = harness([() => ({ ok: true, text: 'Seen.', stopReason: 'end' })]);
    await h.loop.run('This', undefined, false, [{ ...image, data: 'F'.repeat(1000), thumb: 'T'.repeat(100) }]);
    expect([...h.media.values()]).toEqual([{ kind: 'image', mediaType: 'image/jpeg', data: 'T'.repeat(100) }]);
  });

  it('refuses attachments that would outgrow storage, counting amendments still queued', async () => {
    const big = { ...pdf, data: 'P'.repeat(2_700_000) };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const h = harness([async () => { await gate; return { ok: true, text: 'Done.', stopReason: 'end' }; }]);
    const running = h.loop.run('Start', undefined, false, [big]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await h.loop.run('And this', undefined, false, [big]);
    expect(h.loop.state.transcript.at(-1)).toMatchObject({ kind: 'notice', text: expect.stringContaining('too large to keep') });
    release();
    await running;
    expect(h.requests.every((request) => JSON.stringify(request).length < 4_000_000)).toBe(true);
  });

  it('does not strand a run as "running" when storage refuses to start it', async () => {
    const h = harness([]);
    h.failSave(true);
    await h.loop.run('Go', undefined, false, [image]).catch(() => undefined);
    h.failSave(false);
    expect(h.loop.state.status).toBe('idle');
    expect(h.requests).toHaveLength(0);
  });

  it('forgets attached images with the conversation', async () => {
    const h = harness([() => ({ ok: true, text: 'Seen.', stopReason: 'end' })]);
    await h.loop.run('This', undefined, false, [image]);
    expect(h.media.size).toBe(1);
    await h.loop.newConversation();
    expect(h.media.size).toBe(0);
  });
});

describe('skills', () => {
  const general: Skill = { id: 'g', name: 'House style', sites: [], text: 'Be brief.', enabled: true, updatedAt: 1 };
  const shop: Skill = { id: 's', name: 'Shop tips', sites: ['shop.test'], text: 'Use the search box.', enabled: true, updatedAt: 2 };
  const off: Skill = { id: 'o', name: 'Off', sites: [], text: 'Never seen.', enabled: false, updatedAt: 3 };
  const userText = (request: AIChatRequest, index: number) => String(request.messages.filter((message) => message.role === 'user')[index]?.content ?? '');
  const toolTexts = (request: AIChatRequest) => request.messages.filter((message) => message.role === 'tool').map((message) => String(message.content));

  it('puts the general skills and those for the handed page under the goal, once per conversation', async () => {
    const h = harness([() => ({ ok: true, text: 'One.', stopReason: 'end' }), () => ({ ok: true, text: 'Two.', stopReason: 'end' })], { skills: [general, shop, off] });
    await h.loop.run('Find mugs', 42);
    const first = userText(h.requests[0]!, 0);
    expect(first).toContain('Owner\'s notes for this task');
    expect(first).toContain('## House style\nBe brief.');
    expect(first).toContain('## Shop tips (shop.test)\nUse the search box.');
    expect(first).not.toContain('Never seen');
    expect(h.loop.state.transcript.map((entry) => entry.kind === 'notice' ? entry.text : entry.kind)).toEqual(['owner', 'Using skills: House style, Shop tips', 'agent']);
    // A follow-up on the same page: the notes are already in the history.
    await h.loop.run('And plates');
    expect(userText(h.requests[1]!, 1)).not.toContain('Owner\'s notes');
    expect(h.saved()!.usedSkillIds).toEqual(['g', 's']);
  });

  it('brings a site\'s skill along in the result of the action that lands there, and not again', async () => {
    const h = harness([
      callTurn({ id: 'a', args: { action: 'navigate', url: 'https://shop.test/' } }),
      callTurn({ id: 'b', args: { action: 'observe' } }),
      () => ({ ok: true, text: 'Done.', stopReason: 'end' }),
    ], { skills: [shop] });
    await h.loop.run('Go shopping', undefined, true);
    expect(userText(h.requests[0]!, 0)).not.toContain('Owner\'s notes');
    const [afterNavigate] = toolTexts(h.requests[1]!);
    expect(JSON.parse(afterNavigate!)).toMatchObject({ ownerNotes: expect.stringContaining('## Shop tips (shop.test)\nUse the search box.') });
    const [, afterObserve] = toolTexts(h.requests[2]!);
    expect(afterObserve).not.toContain('ownerNotes');
    expect(h.loop.state.transcript.filter((entry) => entry.kind === 'notice').map((entry) => (entry as { text: string }).text)).toEqual(['Using skill: Shop tips']);
  });

  it('uses a skill the owner names with the message, on any page, and with a message sent mid-run', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const h = harness([
      async () => { await held; return { ok: true, text: 'First.', stopReason: 'end' }; },
      () => ({ ok: true, text: 'Second.', stopReason: 'end' }),
    ], { skills: [shop] });
    const running = h.loop.run('Start', undefined, true, [], ['s']);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await h.loop.run('Also this', undefined, false, [], ['s']);
    release();
    await running;
    expect(userText(h.requests[0]!, 0)).toContain('## Shop tips');
    expect(h.loop.state.transcript.filter((entry) => entry.kind === 'notice')).toHaveLength(2);
  });

  it('drafts a skill from the conversation: the model\'s note, its name, and the sites visited', async () => {
    const h = harness([
      callTurn({ id: 'a', args: { action: 'navigate', url: 'https://shop.test/' } }),
      () => ({ ok: true, text: 'Done.', stopReason: 'end' }),
      (request) => ({ ok: true, text: String(request.messages.at(-1)!.content).includes('NAME:') ? 'Open the shop.\nSearch for the item.\nNAME: Shop search' : 'wrong', stopReason: 'end' }),
    ]);
    await h.loop.run('Find the blue mug', undefined, true);
    expect(await h.loop.draftSkill()).toEqual({ name: 'Shop search', sites: ['shop.test'], text: 'Open the shop.\nSearch for the item.' });
    expect(h.requests).toHaveLength(3);
  });

  it('a draft takes the owner\'s steer, and a rewrite carries the draft they have with what to change', async () => {
    const asks: string[] = [];
    const h = harness([
      callTurn({ id: 'a', args: { action: 'navigate', url: 'https://shop.test/' } }),
      () => ({ ok: true, text: 'Done.', stopReason: 'end' }),
      (request) => { asks.push(String(request.messages.at(-1)!.content)); return { ok: true, text: 'Search only.\nNAME: Search', stopReason: 'end' }; },
      (request) => { asks.push(String(request.messages.at(-1)!.content)); return { ok: true, text: 'Search.\nNAME: Short', stopReason: 'end' }; },
    ]);
    await h.loop.run('Find the blue mug', undefined, true);
    expect(await h.loop.draftSkill({ focus: 'only the search steps' })).toMatchObject({ name: 'Search', text: 'Search only.' });
    expect(asks[0]).toContain('be about this in particular: only the search steps');
    expect(asks[0]).not.toContain('as written before');
    expect(await h.loop.draftSkill({ focus: 'shorter', previous: 'Search only.' })).toMatchObject({ name: 'Short', text: 'Search.' });
    expect(asks[1]).toContain('The note as written before:\nSearch only.');
    expect(asks[1]).toContain('changed as the owner asks: shorter');
  });

  it('lets a draft be as long as a skill, and cuts an overrun at a line break, never mid-step', async () => {
    expect(DRAFT_CHARS).toBe(MAX_SKILL_CHARS);
    const step = (i: number) => `${i}. Scroll down one screen and take a screenshot of the article.`;
    const steps = Array.from({ length: 60 }, (_, i) => step(i + 1)).join('\n');
    const text = trimDraft(steps);
    expect(text.length).toBeLessThanOrEqual(MAX_SKILL_CHARS);
    expect(text.endsWith('article.')).toBe(true);
    expect(steps.startsWith(`${text}\n`)).toBe(true);
    expect(trimDraft('short')).toBe('short');
    // One endless line: cut at the limit rather than throw most of it away.
    expect(trimDraft('x'.repeat(50), 10)).toBe('x'.repeat(10));
  });

  it('refuses to draft while a run is going, or before any', async () => {
    const h = harness([]);
    expect(await h.loop.draftSkill()).toEqual({ error: expect.stringContaining('no conversation') });
  });
});

describe('Learning: one step at a time', () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('waits for Next before each action, previewing it in the page; reads never wait', async () => {
    const h = harness([
      () => ({ ok: true, text: 'I will open the shop and read it.', toolCalls: [{ id: 'a', name: 'browser', args: { action: 'navigate', url: 'https://shop.test/' } }, { id: 'b', name: 'browser', args: { action: 'observe' } }], stopReason: 'tool_use' }),
      (request) => callTurn({ id: 'c', args: { action: 'click', observation: lastObservationId(request), target: { ref: 'e1' } } })(request, new AbortController().signal),
      () => ({ ok: true, text: 'Done.', stopReason: 'end' }),
    ], { learning: true });
    const running = h.loop.run('Shop', undefined, true);
    await tick();
    expect(h.loop.state.stepWait).toEqual({ text: 'Open https://shop.test/', why: 'I will open the shop and read it.' });
    expect(h.ran).toEqual([]);
    expect(h.notes.at(-1)).toEqual({ text: 'Open https://shop.test/', why: 'I will open the shop and read it.', waiting: true });
    h.loop.step();
    await tick(); await tick();
    // The navigate ran; the observe did not wait; the click waits now, previewed where it will go.
    expect(h.ran.map((command) => command.name)).toEqual(['navigate']);
    expect(h.loop.state.stepWait).toEqual({ text: 'Click button "Go"' });
    expect(h.previews.at(-1)).toMatchObject({ action: 'click', target: { ref: 'e1' } });
    h.loop.step();
    await running;
    expect(h.ran.map((command) => command.name)).toEqual(['navigate', 'click']);
    expect(h.loop.state.status).toBe('idle');
    expect(h.loop.state.stepWait).toBeUndefined();
    expect(h.notes.at(-1)).toBeNull();
  });

  it('Learning turned off mid-run lets the step go and takes the bubble out of the page before the next action', async () => {
    let h: ReturnType<typeof harness>;
    h = harness([
      callTurn({ id: 'a', args: { action: 'navigate', url: 'https://shop.test/' } }),
      (request) => callTurn({ id: 'c', args: { action: 'click', observation: lastObservationId(request), target: { ref: 'e1' } } })(request, new AbortController().signal),
      // Asked after the click ran, before the run ends: is the page clean already?
      () => ({ ok: true, text: h.notes.at(-1) === null ? 'Clean.' : 'Bubble still there.', stopReason: 'end' }),
    ], { learning: true });
    const running = h.loop.run('Shop', undefined, true);
    await tick();
    expect(h.notes.at(-1)).toMatchObject({ waiting: true });
    await h.loop.setLearning(false);
    await running;
    expect(h.ran.map((command) => command.name)).toEqual(['navigate', 'click']);
    expect(h.notes.slice(0, 3)).toEqual([expect.objectContaining({ waiting: true }), expect.objectContaining({ waiting: false }), null]);
    expect(h.loop.state.transcript.at(-1)).toMatchObject({ kind: 'agent', text: 'Clean.' });
  });

  it('a Stop while waiting ends the run with nothing dispatched', async () => {
    const h = harness([callTurn({ id: 'a', args: { action: 'navigate', url: 'https://shop.test/' } })], { learning: true });
    const running = h.loop.run('Shop', undefined, true);
    await tick();
    expect(h.loop.state.stepWait).toBeDefined();
    await h.loop.stop();
    await running;
    expect(h.ran).toEqual([]);
    expect(h.loop.state.status).toBe('idle');
    expect(h.loop.state.stepWait).toBeUndefined();
  });

  it('turning Learn off while a step waits lets it go; off, nothing waits', async () => {
    const waiting = harness([callTurn({ id: 'a', args: { action: 'navigate', url: 'https://shop.test/' } })], { learning: true });
    const running = waiting.loop.run('Shop', undefined, true);
    await tick();
    expect(waiting.loop.state.stepWait).toBeDefined();
    await waiting.loop.setLearning(false);
    await running;
    expect(waiting.ran.map((command) => command.name)).toEqual(['navigate']);
    expect(waiting.loop.state.learning).toBe(false);
    const h = harness([callTurn({ id: 'a', args: { action: 'navigate', url: 'https://shop.test/' } })]);
    await h.loop.run('Shop', undefined, true);
    expect(h.ran.map((command) => command.name)).toEqual(['navigate']);
    expect(h.previews).toEqual([]);
  });
});

describe('the run lifecycle in the loop', () => {
  it('a Stop pressed while the run is still starting ends it at its first guard, with nothing dispatched', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const h = harness([callTurn({ id: 'a', args: { action: 'navigate', url: 'https://shop.test/' } })], { skillsHeld: held });
    const running = h.loop.run('Shop', undefined, true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await h.loop.stop();
    release();
    await running;
    expect(h.ran).toEqual([]);
    expect(h.requests).toEqual([]);
    expect(h.loop.state.status).toBe('idle');
    expect(h.loop.state.transcript.at(-1)).toEqual({ kind: 'notice', text: 'Stopped.' });
  });

  it('a second message while starting joins the run instead of starting another', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const h = harness([() => ({ ok: true, text: 'Done.', stopReason: 'end' })], { skillsHeld: held });
    const first = h.loop.run('First', undefined, true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = h.loop.run('Second', undefined, true);
    release();
    await Promise.all([first, second]);
    expect(h.requests).toHaveLength(1);
    expect(JSON.stringify(h.requests[0]!.messages)).toContain('Second');
  });
});

describe('the run trace in the loop', () => {
  function answerNextCard(h: ReturnType<typeof harness>, decision: 'once' | 'deny') {
    const timer = setInterval(() => {
      const approval = h.loop.state.approval;
      if (approval) { clearInterval(timer); void h.loop.decide(approval.id, decision); }
    }, 1);
  }

  it('records the run in order: start, state changes, each model turn, the card and its answer, each call with its result', async () => {
    const h = harness([
      // The fake page is on shop.test: the site the card allows is where the tab lands.
      callTurn({ id: 'a', args: { action: 'navigate', url: 'https://shop.test/' } }),
      () => ({ ok: true, text: 'Done.', stopReason: 'end' }),
    ], { scoped: true });
    answerNextCard(h, 'once');
    await h.loop.run('Go elsewhere');
    const trace = JSON.parse(h.loop.exportTrace()) as { valetTrace: number; events: Array<Record<string, unknown>> };
    expect(trace.valetTrace).toBe(1);
    const kinds = trace.events.map((event) => (event['kind'] === 'phase' ? `phase:${event['to']}` : event['kind']));
    expect(kinds).toEqual(expect.arrayContaining(['phase:starting', 'run', 'phase:running', 'model-request', 'model-response', 'card', 'answer', 'call', 'phase:idle']));
    const order = (kind: string) => kinds.indexOf(kind);
    expect(order('run')).toBeLessThan(order('model-request'));
    expect(order('card')).toBeLessThan(order('answer'));
    expect(order('answer')).toBeLessThan(order('call'));
    const call = trace.events.find((event) => event['kind'] === 'call')!;
    expect(call).toMatchObject({ name: 'browser', args: { action: 'navigate', url: 'https://shop.test/' }, outcome: 'ok', turn: 1 });
    expect(trace.events.find((event) => event['kind'] === 'answer')).toMatchObject({ card: 'site', decision: 'once' });
    expect(trace.events.find((event) => event['kind'] === 'model-response' && event['turn'] === 2)).toMatchObject({ ok: true, text: 'Done.' });
  });

  it('leaves images out of the export, and forgets the trace with the conversation', async () => {
    const h = harness([callTurn({ id: 's', args: { action: 'screenshot' } }), () => ({ ok: true, text: 'Seen.', stopReason: 'end' })], { scoped: false });
    await h.loop.run('Look', 42);
    const exported = h.loop.exportTrace();
    expect(exported).not.toContain('SU1H');
    expect(exported).toContain('"omitted": true');
    await h.loop.newConversation();
    expect((JSON.parse(h.loop.exportTrace()) as { events: unknown[] }).events).toEqual([]);
  });
});
