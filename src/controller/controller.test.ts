/**
 * The run controller against a scripted executor: every failure class, and
 * the counters and flags.
 */
import { describe, expect, it } from 'vitest';
import type { ExecutorObservation } from '../executor/commands.js';
import { Cancellation, CancelledError, PreconditionError, type Command } from '../executor/protocol.js';
import { RunController, type ExecutorLike, type ToolResult } from './controller.js';

type Step = (command: Command, cancel: Cancellation) => Promise<void> | void;

function page(id = 'executor-id'): ExecutorObservation {
  return {
    id, url: 'https://example.test/', title: 'Example', tree: '- button "Go" [ref=e1]',
    targets: [{ ref: 'e1', frame: 0, role: 'button', name: 'Go' }], tabs: [{ id: 'tab-1', url: 'https://example.test/', title: 'Example' }],
    capturedAt: '2026-01-01T00:00:00.000Z',
    frames: [{ index: 0, frameId: 0, documentId: 'doc-0', origin: 'https://example.test', url: 'https://example.test/' }],
  };
}

function fake() {
  const ran: Command[] = [];
  const state = {
    tab: false,
    /** What the next dispatches do, in order; default: succeed. */
    steps: [] as Step[],
    /** What the next observations do, in order; default: succeed. */
    observations: [] as Array<() => ExecutorObservation>,
  };
  const executor: ExecutorLike = {
    async run(command, cancel = new Cancellation()) {
      ran.push(command);
      const step = state.steps.shift();
      if (step) await step(command, cancel);
      if (command.name === 'navigate') state.tab = true;
      if (command.name === 'close') state.tab = false;
      return {};
    },
    async observe() {
      const next = state.observations.shift();
      return next ? next() : page();
    },
    hasTab: () => state.tab,
  };
  let n = 0;
  const controller = new RunController(executor, { session: 's1', uuid: () => `id-${(n += 1)}`, now: () => new Date('2026-09-26T12:00:00Z') });
  return { controller, ran, state };
}

const observationOf = (result: ToolResult) => ('observation' in result ? result.observation : undefined);

async function navigated() {
  const f = fake();
  const result = await f.controller.run({ action: 'navigate', url: 'https://example.test/' });
  return { ...f, id: observationOf(result)!.id };
}

const failWith = (error: Error, dispatched = false): Step => (_command, cancel) => {
  if (dispatched) cancel.dispatch();
  throw error;
};
const failObservation = (message: string) => () => { throw new PreconditionError(message); };

describe('evidence', () => {
  it('re-stamps the observation it returns and keeps the frame metadata to itself', async () => {
    const { controller } = fake();
    const result = await controller.run({ action: 'navigate', url: 'https://example.test/' });
    const observation = observationOf(result)!;
    expect(observation.id).not.toBe('executor-id');
    expect(observation.capturedAt).toBe('2026-09-26T12:00:00.000Z');
    expect(observation).not.toHaveProperty('frames');
    expect(controller.latestFrames).toHaveLength(1);
    expect(controller.latestId).toBe(observation.id);
  });

  it('dispatches an acting command that carries the latest observation id, and observes after it', async () => {
    const { controller, ran, id } = await navigated();
    const result = await controller.run({ action: 'click', observation: id, target: { ref: 'e1' } });
    expect(ran.map((command) => command.name)).toEqual(['navigate', 'click']);
    expect(ran[1]!.args).toEqual({ target: { ref: 'e1', by: 'role', frame: 0 } });
    expect(observationOf(result)!.id).not.toBe(id);
  });

  it('refuses a stale observation id without dispatching, and recovers fresh evidence', async () => {
    const { controller, ran } = await navigated();
    const result = await controller.run({ action: 'click', observation: 'not-the-latest', target: { ref: 'e1' } });
    expect(result).toMatchObject({ refused: expect.stringMatching(/Stale page observation/) });
    expect(observationOf(result)).toBeDefined();
    expect(ran.map((command) => command.name)).toEqual(['navigate']);
  });

  it('never accepts an id again once a command was dispatched with it', async () => {
    const { controller, id } = await navigated();
    await controller.run({ action: 'click', observation: id, target: { ref: 'e1' } });
    const again = await controller.run({ action: 'click', observation: id, target: { ref: 'e1' } });
    expect(again).toMatchObject({ refused: expect.stringMatching(/Stale/) });
  });

  it('refuses an invalid command before anything is dispatched, and shows the shape to copy', async () => {
    const { controller, ran, id } = await navigated();
    const result = await controller.run({ action: 'click', target: { ref: 'e1' } });
    expect(result).toMatchObject({ refused: expect.stringMatching(/observation: Required for click/) });
    expect((result as { refused: string }).refused).toContain(`"observation":"${id}"`);
    expect((result as { refused: string }).refused).toContain(`The latest observation is still ${id}.`);
    expect(ran).toHaveLength(1);
    // The page did not change: the latest observation still works.
    expect(await controller.run({ action: 'click', observation: id, target: { ref: 'e1' } })).toMatchObject({ completed: true });
  });

  it('pauses after three malformed commands in a row with a message about the model, not targeting', async () => {
    const { controller } = await navigated();
    // What gemma4 sent through Ollama: the whole command inside the action field.
    const garbled = { action: 'click",observation:"30a2574f",target:{ref:"e4"}' };
    await controller.run(garbled);
    await controller.run(garbled);
    expect(controller.state).toBe('running');
    const third = await controller.run(garbled);
    expect(controller.state).toBe('paused');
    expect(controller.pauseReason).toMatch(/malformed browser commands.*stronger model/);
    expect((third as { refused: string }).refused).not.toMatch(/targeting/);
    expect(controller.refusals).toBe(0);
  });

  it('resets the malformed count on any valid command', async () => {
    const { controller } = await navigated();
    await controller.run({ action: 'bogus' });
    await controller.run({ action: 'bogus' });
    await controller.run({ action: 'observe' });
    expect(controller.invalidCommands).toBe(0);
  });

  it('refuses without an observation when there is no tab to observe yet', async () => {
    const { controller } = fake();
    const result = await controller.run({ action: 'click', observation: 'x', target: { ref: 'e1' } });
    expect(result).toEqual({ refused: expect.stringMatching(/Stale/), notice: expect.any(String) });
  });
});

describe('failure classification (by dispatch phase)', () => {
  it('calls a precondition refusal before dispatch a refusal, and pauses on the third in a row', async () => {
    const { controller, state, id } = await navigated();
    let latest = id;
    for (let i = 1; i <= 3; i += 1) {
      state.steps.push(failWith(new PreconditionError('This page has changed since that observation. Observe again.')));
      const result = await controller.run({ action: 'click', observation: latest, target: { ref: 'e1' } });
      expect(result).toMatchObject({ refused: expect.stringMatching(/has changed/) });
      latest = observationOf(result)!.id;
    }
    expect(controller.state).toBe('paused');
    expect(controller.pauseReason).toMatch(/Repeated targeting failures/);
  });

  it('keeps the third-refusal pause even when its recovery observation fails', async () => {
    const { controller, state, id } = await navigated();
    controller.refusals = 2;
    state.steps.push(failWith(new PreconditionError('No button named Go in the last observation.')));
    state.observations.push(failObservation('The page has not answered after three tries. Wait a few seconds and observe again.'));
    const result = await controller.run({ action: 'click', observation: id, target: { ref: 'e1' } });
    expect(result).toMatchObject({ refused: expect.stringMatching(/Repeated targeting failures/), observed: false });
    expect(controller.state).toBe('paused');
    expect(controller.pauseReason).toMatch(/Repeated targeting failures/);
  });

  it('calls any failure after dispatch began "outcome unknown", even a precondition error, and pauses', async () => {
    // A fill clears the field before the debugger attaches: an attach failure is not "nothing happened".
    const { controller, state, id } = await navigated();
    state.steps.push(failWith(new PreconditionError('Chrome would not let the agent drive that tab. Close DevTools on it and observe again.'), true));
    const result = await controller.run({ action: 'fill', observation: id, target: { ref: 'e1' }, value: 'x' });
    expect(result).toMatchObject({ completed: 'unknown', notice: expect.stringMatching(/do not repeat a submission/) });
    expect(controller.state).toBe('paused');
  });

  it('calls a Stop after dispatch began "outcome unknown"', async () => {
    const { controller, state, id } = await navigated();
    state.steps.push(failWith(new CancelledError('cancelled'), true));
    const result = await controller.run({ action: 'click', observation: id, target: { ref: 'e1' } });
    expect(result).toMatchObject({ completed: 'unknown' });
  });

  it('ends the turn on a Stop before dispatch, without counting it as a refusal', async () => {
    const { controller, state, id } = await navigated();
    state.steps.push(failWith(new CancelledError('cancelled')));
    const result = await controller.run({ action: 'click', observation: id, target: { ref: 'e1' } });
    expect(result).toEqual({ skipped: expect.any(String), terminal: 'stopped' });
    expect(controller.refusals).toBe(0);
  });

  it('pauses on an unexpected error before dispatch and says nothing was dispatched', async () => {
    const { controller, state, id } = await navigated();
    state.steps.push(failWith(new Error('boom')));
    const result = await controller.run({ action: 'click', observation: id, target: { ref: 'e1' } });
    expect(result).toEqual({ error: 'boom.', notice: 'Nothing was dispatched.' });
    expect(controller.state).toBe('paused');
  });
});

describe('guards', () => {
  it('skips every call while paused, and a call whose Stop was already pressed', async () => {
    const { controller, ran } = await navigated();
    const stopped = new Cancellation();
    stopped.cancel();
    expect(await controller.run({ action: 'observe' }, stopped)).toMatchObject({ terminal: 'stopped' });
    controller.state = 'paused';
    expect(await controller.run({ action: 'observe' })).toMatchObject({ terminal: 'paused' });
    expect(ran).toHaveLength(1);
  });
});

describe('observation failures', () => {
  it('does not pause on a failed observation after an action, and forbids repeating the action', async () => {
    const { controller, state, id } = await navigated();
    state.observations.push(failObservation('The page has not answered after three tries. Wait a few seconds and observe again.'));
    const result = await controller.run({ action: 'click', observation: id, target: { ref: 'e1' } });
    expect(result).toMatchObject({ completed: true, observed: false });
    const message = (result as { message: string }).message;
    expect(message).toContain('Action completed, but observation failed');
    expect(message).toContain('Do not repeat the action');
    // The executor's sentence already says to wait; it is not said twice.
    expect(message.match(/observe again/gi)).toHaveLength(1);
    expect(controller.state).toBe('running');
    expect(controller.needsObservation).toBe(true);
  });

  it('refuses acting commands until an observation succeeds, but lets navigate recover', async () => {
    const { controller, state, ran, id } = await navigated();
    state.observations.push(failObservation('That tab is gone. Observe again to continue in a new one.'));
    await controller.run({ action: 'observe' });
    expect(await controller.run({ action: 'click', observation: id, target: { ref: 'e1' } }))
      .toMatchObject({ refused: expect.stringMatching(/A fresh observation is required/) });
    const recovered = await controller.run({ action: 'navigate', url: 'https://example.test/again' });
    expect(observationOf(recovered)).toBeDefined();
    expect(controller.needsObservation).toBe(false);
    expect(ran.map((command) => command.name)).toEqual(['navigate', 'navigate']);
  });

  it('pauses on the third consecutive observation failure', async () => {
    const { controller, state } = await navigated();
    for (let i = 0; i < 3; i += 1) state.observations.push(failObservation('The page has not answered after three tries. Wait a few seconds and observe again.'));
    await controller.run({ action: 'observe' });
    await controller.run({ action: 'observe' });
    expect(controller.state).toBe('running');
    const third = await controller.run({ action: 'observe' });
    expect(controller.state).toBe('paused');
    expect((third as { message: string }).message).toMatch(/three times in a row/);
  });

  it('clears needsObservation after a successful recovery observation', async () => {
    const { controller, state } = await navigated();
    state.observations.push(failObservation('The page has not answered after three tries. Wait a few seconds and observe again.'));
    await controller.run({ action: 'observe' });
    expect(controller.needsObservation).toBe(true);
    // A navigate the executor refuses before dispatch; its recovery observation succeeds.
    state.steps.push(failWith(new PreconditionError('Only http and https addresses can be opened in your browser.')));
    const result = await controller.run({ action: 'navigate', url: 'ftp://example.test/' });
    expect(result).toMatchObject({ refused: expect.stringMatching(/Only http and https/) });
    expect(observationOf(result)).toBeDefined();
    expect(controller.needsObservation).toBe(false);
  });
});

describe('counters and flags', () => {
  it('resets refusals when a non-observe command completes, but not on an observe', async () => {
    const { controller, state, id } = await navigated();
    state.steps.push(failWith(new PreconditionError('No button named Go in the last observation.')));
    const refused = await controller.run({ action: 'click', observation: id, target: { ref: 'e1' } });
    expect(controller.refusals).toBe(1);
    await controller.run({ action: 'observe' });
    expect(controller.refusals).toBe(1);
    await controller.run({ action: 'click', observation: controller.latestId, target: { ref: 'e1' } });
    expect(controller.refusals).toBe(0);
    void refused;
  });

  it('resets everything on close', async () => {
    const { controller } = await navigated();
    controller.refusals = 2;
    controller.observationFailures = 2;
    controller.needsObservation = true;
    expect(await controller.run({ action: 'close' })).toMatchObject({ closed: true });
    expect([controller.refusals, controller.observationFailures, controller.needsObservation]).toEqual([0, 0, false]);
  });

  it('resets the counters on the owner\'s Resume and asks for an observation first', async () => {
    const { controller } = await navigated();
    controller.state = 'paused';
    controller.refusals = 3;
    controller.observationFailures = 2;
    controller.resume();
    expect([controller.state, controller.refusals, controller.observationFailures, controller.needsObservation]).toEqual(['running', 0, 0, true]);
  });

  it('a new run starts unpaused, with refusals reset and the observation state kept', async () => {
    const { controller } = await navigated();
    controller.refusals = 2;
    controller.observationFailures = 1;
    controller.needsObservation = true;
    controller.state = 'paused';
    controller.pauseReason = 'Repeated targeting failures';
    controller.startRun();
    expect([controller.state, controller.pauseReason, controller.refusals, controller.observationFailures, controller.needsObservation]).toEqual(['running', undefined, 0, 1, true]);
  });
});

describe('form submissions', () => {
  const fingerprint = (fields: Array<{ name: string; value: string }> = [{ name: 'name', value: 'Amen' }]) => ({
    frameOrigin: 'https://example.test', form: { index: 0, id: '', name: '' }, action: 'https://example.test/pay', method: 'POST',
    submitter: { role: 'button', name: 'Pay', index: 1 }, fields,
  });

  function withSubmit(options: { facts: Array<ReturnType<typeof fingerprint> | null>; decisions: Array<'once' | 'chat' | 'deny'>; verdict?: 'ask' | 'allowed' | 'denied' }) {
    const f = fake();
    const reads = [...options.facts];
    const asked: unknown[] = [];
    const executor = {
      run: async (command: Command) => { f.ran.push(command); if (command.name === 'navigate') f.state.tab = true; return {}; },
      observe: async () => page(),
      hasTab: () => f.state.tab,
      submitFacts: async () => { const next = reads.length > 1 ? reads.shift()! : reads[0]!; return next ? { submits: true, fingerprint: next } : { submits: false }; },
    };
    const gate = {
      verdict: () => 'allowed' as const,
      ask: async () => 'once' as const,
      takeBlocked: () => [],
      submitVerdict: () => options.verdict ?? 'ask' as const,
      askSubmit: async (fp: unknown) => { asked.push(fp); return options.decisions.shift() ?? 'deny'; },
    };
    const controller = new RunController(executor, { session: 's', gate });
    return { controller, ran: f.ran, asked };
  }

  it('asks before a submitting click, and Deny dispatches nothing', async () => {
    const h = withSubmit({ facts: [fingerprint()], decisions: ['deny'] });
    const nav = await h.controller.run({ action: 'navigate', url: 'https://example.test/' });
    const result = await h.controller.run({ action: 'click', observation: observationOf(nav)!.id, target: { ref: 'e1' } });
    expect(h.asked).toHaveLength(1);
    expect(result).toMatchObject({ refused: expect.stringMatching(/did not allow this form submission/) });
    expect(h.ran.map((command) => command.name)).toEqual(['navigate']);
  });

  it('dispatches after Allow once when the form still sends exactly what was approved', async () => {
    const h = withSubmit({ facts: [fingerprint()], decisions: ['once'] });
    const nav = await h.controller.run({ action: 'navigate', url: 'https://example.test/' });
    await h.controller.run({ action: 'press', observation: observationOf(nav)!.id, target: { ref: 'e1' }, key: 'Enter' });
    expect(h.ran.map((command) => command.name)).toEqual(['navigate', 'press']);
  });

  it('asks again when a value changed after approval', async () => {
    const h = withSubmit({ facts: [fingerprint(), fingerprint([{ name: 'name', value: 'Mallory' }]), fingerprint([{ name: 'name', value: 'Mallory' }])], decisions: ['once', 'deny'] });
    const nav = await h.controller.run({ action: 'navigate', url: 'https://example.test/' });
    const result = await h.controller.run({ action: 'click', observation: observationOf(nav)!.id, target: { ref: 'e1' } });
    expect(h.asked).toHaveLength(2);
    expect((h.asked[1] as { fields: unknown[] }).fields).toEqual([{ name: 'name', value: 'Mallory' }]);
    expect(result).toHaveProperty('refused');
    expect(h.ran.map((command) => command.name)).toEqual(['navigate']);
  });

  it('skips the card for a destination allowed in this chat and refuses one denied in this request', async () => {
    const allowed = withSubmit({ facts: [fingerprint()], decisions: [], verdict: 'allowed' });
    const nav = await allowed.controller.run({ action: 'navigate', url: 'https://example.test/' });
    await allowed.controller.run({ action: 'click', observation: observationOf(nav)!.id, target: { ref: 'e1' } });
    expect(allowed.asked).toEqual([]);
    expect(allowed.ran.map((command) => command.name)).toEqual(['navigate', 'click']);
    const denied = withSubmit({ facts: [fingerprint()], decisions: [], verdict: 'denied' });
    const nav2 = await denied.controller.run({ action: 'navigate', url: 'https://example.test/' });
    expect(await denied.controller.run({ action: 'click', observation: observationOf(nav2)!.id, target: { ref: 'e1' } })).toMatchObject({ refused: expect.stringMatching(/denied this form submission/) });
  });

  it('does not ask for a click that submits nothing', async () => {
    const h = withSubmit({ facts: [null], decisions: [] });
    const nav = await h.controller.run({ action: 'navigate', url: 'https://example.test/' });
    await h.controller.run({ action: 'click', observation: observationOf(nav)!.id, target: { ref: 'e1' } });
    expect(h.asked).toEqual([]);
  });
});

describe('form submissions fail closed', () => {
  it('refuses when the form facts cannot be read, and dispatches nothing', async () => {
    const f = fake();
    const executor = {
      run: async (command: Command) => { f.ran.push(command); if (command.name === 'navigate') f.state.tab = true; return {}; },
      observe: async () => page(),
      hasTab: () => f.state.tab,
      submitFacts: async () => { throw new Error('Frame with ID 0 was removed.'); },
    };
    const gate = { verdict: () => 'allowed' as const, ask: async () => 'once' as const, takeBlocked: () => [], submitVerdict: () => 'ask' as const, askSubmit: async () => 'once' as const };
    const controller = new RunController(executor, { session: 's', gate });
    const nav = await controller.run({ action: 'navigate', url: 'https://example.test/' });
    const result = await controller.run({ action: 'click', observation: observationOf(nav)!.id, target: { ref: 'e1' } });
    expect(result).toMatchObject({ refused: expect.stringMatching(/Could not check whether this action submits a form/) });
    expect(f.ran.map((command) => command.name)).toEqual(['navigate']);
  });

  it('refuses when the facts cannot be read again after the owner approved, and dispatches nothing', async () => {
    const f = fake();
    let reads = 0;
    const fingerprint = { action: 'https://example.test/pay', method: 'POST', frameOrigin: 'https://example.test', form: { index: 0, id: '', name: '' }, submitter: { role: 'button', name: 'Pay', index: 0 }, fields: [] };
    const executor = {
      run: async (command: Command) => { f.ran.push(command); if (command.name === 'navigate') f.state.tab = true; return {}; },
      observe: async () => page(),
      hasTab: () => f.state.tab,
      submitFacts: async () => { reads += 1; if (reads > 1) throw new Error('Frame with ID 0 was removed.'); return { submits: true as const, fingerprint }; },
    };
    const gate = { verdict: () => 'allowed' as const, ask: async () => 'once' as const, takeBlocked: () => [], submitVerdict: () => 'ask' as const, askSubmit: async () => 'once' as const };
    const controller = new RunController(executor, { session: 's', gate });
    const nav = await controller.run({ action: 'navigate', url: 'https://example.test/' });
    const result = await controller.run({ action: 'click', observation: observationOf(nav)!.id, target: { ref: 'e1' } });
    expect(result).toMatchObject({ refused: expect.stringMatching(/still sends what was approved/) });
    expect(f.ran.map((command) => command.name)).toEqual(['navigate']);
  });
});


describe('clicks by point', () => {
  const shot = { data: 'SU1H', mediaType: 'image/jpeg' as const, width: 640, height: 400, masked: 1, viewport: { width: 1280, height: 800 }, masks: [{ x: 0, y: 700, w: 1280, h: 100 }] };
  function withPoints(options: { found?: { ref: string; role: string; name: string; href?: string }; verdict?: 'ask' | 'allowed' | 'denied' } = {}) {
    const f = fake();
    const aimed: Array<{ x: number; y: number }> = [];
    const asked: string[] = [];
    const executor: ExecutorLike = {
      run: async (command: Command) => { f.ran.push(command); if (command.name === 'navigate') f.state.tab = true; return {}; },
      observe: async () => page(),
      hasTab: () => f.state.tab,
      capture: async () => shot,
      refAt: async (_session, point) => {
        aimed.push(point);
        if (point.x > 1200) throw new PreconditionError('That point is inside a frame, which a point cannot reach. Use a ref from observation.targets.');
        return options.found ?? { ref: 'p1', role: 'button', name: 'Zoom in' };
      },
    };
    const gate = { verdict: (origin: string) => (origin === 'https://example.test' ? 'allowed' as const : options.verdict ?? 'ask' as const), ask: async (origin: string) => { asked.push(origin); return 'deny' as const; }, takeBlocked: () => [] };
    const controller = new RunController(executor, { session: 's', gate, uuid: () => `id-${aimed.length}-${asked.length}-${f.ran.length}` });
    return { controller, ran: f.ran, aimed, asked };
  }

  async function ready(h: ReturnType<typeof withPoints>) {
    const observed = observationOf(await h.controller.run({ action: 'navigate', url: 'https://example.test/' }))!.id;
    const taken = await h.controller.run({ action: 'screenshot' });
    const shotId = 'screenshot' in taken ? taken.screenshot.id : '';
    return { observed, shotId };
  }

  it('maps the point to the viewport, resolves the element there, and clicks exactly that point', async () => {
    const h = withPoints();
    const { observed, shotId } = await ready(h);
    const result = await h.controller.run({ action: 'click', observation: observed, screenshot: shotId, point: { x: 320, y: 100 } });
    expect(result).toMatchObject({ completed: true });
    expect(h.aimed).toEqual([{ x: 640, y: 200 }]);
    expect(h.ran.at(-1)).toMatchObject({ name: 'click', args: { target: { ref: 'p1' }, point: { x: 640, y: 200 } } });
    expect(h.ran.at(-1)!.args).not.toHaveProperty('screenshot');
  });

  it('refuses a stale or missing screenshot id, a point outside the image, and one on a painted-over frame — dispatching nothing', async () => {
    const h = withPoints();
    const { observed, shotId } = await ready(h);
    const stale = await h.controller.run({ action: 'click', observation: observed, screenshot: 'old', point: { x: 1, y: 1 } });
    expect(stale).toMatchObject({ refused: expect.stringMatching(/Stale screenshot/) });
    const fresh = observationOf(stale)!.id;
    const outside = await h.controller.run({ action: 'click', observation: fresh, screenshot: shotId, point: { x: 640, y: 10 } });
    expect(outside).toMatchObject({ refused: expect.stringMatching(/outside the screenshot, which is 640 by 400/) });
    const grey = await h.controller.run({ action: 'click', observation: observationOf(outside)!.id, screenshot: shotId, point: { x: 10, y: 380 } });
    expect(grey).toMatchObject({ refused: expect.stringMatching(/painted grey/) });
    expect(h.aimed).toEqual([]);
    expect(h.ran.map((command) => command.name)).toEqual(['navigate']);
  });

  it('refuses what the page cannot resolve (a frame), as a targeting refusal', async () => {
    const h = withPoints();
    const { observed, shotId } = await ready(h);
    const result = await h.controller.run({ action: 'click', observation: observed, screenshot: shotId, point: { x: 620, y: 10 } });
    expect(result).toMatchObject({ refused: expect.stringMatching(/inside a frame/) });
    expect(h.ran.map((command) => command.name)).toEqual(['navigate']);
  });

  it('checks the link under the point against the run scope like any link', async () => {
    const h = withPoints({ found: { ref: 'p1', role: 'link', name: 'Partner', href: 'https://partner.test/deal' } });
    const { observed, shotId } = await ready(h);
    const result = await h.controller.run({ action: 'click', observation: observed, screenshot: shotId, point: { x: 100, y: 100 } });
    expect(h.asked).toEqual(['https://partner.test']);
    expect(result).toMatchObject({ refused: expect.stringMatching(/did not allow https:\/\/partner.test/) });
    expect(h.ran.map((command) => command.name)).toEqual(['navigate']);
  });

  it('a screenshot is stale once anything was dispatched', async () => {
    const h = withPoints();
    const { observed, shotId } = await ready(h);
    const scrolled = await h.controller.run({ action: 'scroll', observation: observed, direction: 'down' });
    const result = await h.controller.run({ action: 'click', observation: observationOf(scrolled)!.id, screenshot: shotId, point: { x: 1, y: 1 } });
    expect(result).toMatchObject({ refused: expect.stringMatching(/Stale screenshot/) });
  });
});

describe('hover and drag', () => {
  const shot = { data: 'SU1H', mediaType: 'image/jpeg' as const, width: 640, height: 400, masked: 0, viewport: { width: 1280, height: 800 }, masks: [] };
  function withMouse() {
    const f = fake();
    const executor: ExecutorLike = {
      run: async (command: Command) => { f.ran.push(command); if (command.name === 'navigate') f.state.tab = true; return {}; },
      observe: async () => page(),
      hasTab: () => f.state.tab,
      capture: async () => shot,
      refAt: async () => ({ ref: 'p1', role: 'generic', name: '' }),
    };
    const controller = new RunController(executor, { session: 's', uuid: () => `id-${f.ran.length}` });
    return { controller, ran: f.ran };
  }

  it('drags from a ref to a point of the screenshot, both ends mapped to the viewport, and observes after', async () => {
    const h = withMouse();
    const observed = observationOf(await h.controller.run({ action: 'navigate', url: 'https://example.test/' }))!.id;
    const taken = await h.controller.run({ action: 'screenshot' });
    const shotId = 'screenshot' in taken ? taken.screenshot.id : '';
    const result = await h.controller.run({ action: 'drag', observation: observed, screenshot: shotId, target: { ref: 'e1' }, to: { point: { x: 320, y: 100 } } });
    expect(result).toMatchObject({ completed: true, observation: expect.anything() });
    expect(h.ran.at(-1)).toMatchObject({ name: 'drag', args: { target: { ref: 'e1' }, to: { point: { x: 640, y: 200 } } } });
    expect(h.ran.at(-1)!.args).not.toHaveProperty('point');
    expect(h.ran.at(-1)!.args).not.toHaveProperty('screenshot');
  });

  it('drags between two refs without a screenshot, and hovers by point through the element there', async () => {
    const h = withMouse();
    let observed = observationOf(await h.controller.run({ action: 'navigate', url: 'https://example.test/' }))!.id;
    const dragged = await h.controller.run({ action: 'drag', observation: observed, target: { ref: 'e1' }, to: { target: { ref: 'e1' } } });
    expect(h.ran.at(-1)).toMatchObject({ name: 'drag', args: { target: { ref: 'e1' }, to: { target: { ref: 'e1' } } } });
    observed = observationOf(dragged)!.id;
    const taken = await h.controller.run({ action: 'screenshot' });
    const shotId = 'screenshot' in taken ? taken.screenshot.id : '';
    await h.controller.run({ action: 'hover', observation: observed, screenshot: shotId, point: { x: 10, y: 10 } });
    expect(h.ran.at(-1)).toMatchObject({ name: 'hover', args: { target: { ref: 'p1' }, point: { x: 20, y: 20 } } });
  });

  it('refuses a drag whose end is on a stale screenshot, dispatching nothing', async () => {
    const h = withMouse();
    const observed = observationOf(await h.controller.run({ action: 'navigate', url: 'https://example.test/' }))!.id;
    const result = await h.controller.run({ action: 'drag', observation: observed, screenshot: 'old', target: { ref: 'e1' }, to: { point: { x: 1, y: 1 } } });
    expect(result).toMatchObject({ refused: expect.stringMatching(/Stale screenshot/) });
    expect(h.ran.map((command) => command.name)).toEqual(['navigate']);
  });
});

describe('preview', () => {
  it('maps a point through the latest screenshot and passes a target through; a stale point or bad input previews nothing', async () => {
    const f = fake();
    const previews: unknown[] = [];
    const shot = { data: 'SU1H', mediaType: 'image/jpeg' as const, width: 640, height: 400, masked: 0, viewport: { width: 1280, height: 800 }, masks: [] };
    const executor: ExecutorLike = { ...f, run: async (command: Command) => { f.ran.push(command); if (command.name === 'navigate') f.state.tab = true; return {}; }, observe: async () => page(), hasTab: () => f.state.tab, capture: async () => shot, preview: async (_session, aim) => { previews.push(aim); } };
    const controller = new RunController(executor, { session: 's', uuid: () => 'shot' });
    const observed = observationOf(await controller.run({ action: 'navigate', url: 'https://example.test/' }))!.id;
    await controller.run({ action: 'screenshot' });
    await controller.preview({ action: 'click', observation: observed, screenshot: 'shot', point: { x: 320, y: 100 } });
    await controller.preview({ action: 'click', observation: observed, target: { ref: 'e1' } });
    await controller.preview({ action: 'click', observation: observed, screenshot: 'old', point: { x: 1, y: 1 } });
    await controller.preview({ action: 'nonsense' });
    await controller.preview({ action: 'scroll', observation: observed, direction: 'down' });
    expect(previews).toEqual([{ point: { x: 640, y: 200 } }, { target: { ref: 'e1', by: 'role', frame: 0 } }]);
    expect(f.ran.map((command) => command.name)).toEqual(['navigate']);
  });
});
