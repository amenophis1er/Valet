import { describe, expect, it } from 'vitest';
import { IllegalTransition, Lifecycle, type Phase } from './lifecycle.js';
import { Waiter } from './waiter.js';

describe('the run lifecycle', () => {
  const ALL: Phase[] = ['idle', 'starting', 'running', 'paused'];
  const LEGAL = new Set(['idle>starting', 'starting>running', 'starting>idle', 'starting>paused', 'running>paused', 'running>idle', 'paused>starting', 'paused>idle']);

  it('allows exactly the transitions in its table, and refuses every other with the two states named', () => {
    for (const from of ALL) {
      for (const to of ALL) {
        const life = new Lifecycle(() => undefined);
        life.load(from === 'starting' ? 'idle' : from);
        if (from === 'starting') life.to('starting');
        if (LEGAL.has(`${from}>${to}`)) expect(() => life.to(to)).not.toThrow();
        else expect(() => life.to(to)).toThrow(IllegalTransition);
      }
    }
  });

  it('persists the statuses a run rests in, never the transient starting', () => {
    const stored: string[] = [];
    const life = new Lifecycle((status) => stored.push(status));
    life.to('starting'); life.to('running'); life.to('paused'); life.to('starting'); life.to('running'); life.to('idle');
    expect(stored).toEqual(['running', 'paused', 'running', 'idle']);
  });

  it('is busy while starting or running; a Stop pressed while starting carries into the run, and the next start clears it', () => {
    const life = new Lifecycle(() => undefined);
    expect(life.busy).toBe(false);
    life.to('starting');
    expect(life.busy).toBe(true);
    life.requestStop();
    life.to('running');
    expect(life.stopRequested).toBe(true);
    life.to('paused');
    expect(life.busy).toBe(false);
    life.to('starting');
    expect(life.stopRequested).toBe(false);
  });
});

describe('waiting on the owner', () => {
  it('delivers the answer; a superseded or released question gets the fallback; an answer with nothing open is dropped', async () => {
    const card = new Waiter<'once' | 'deny'>('deny');
    const first = card.ask();
    const second = card.ask();
    expect(await first).toBe('deny');
    card.answer('once');
    expect(await second).toBe('once');
    expect(card.open).toBe(false);
    card.answer('once');
    const third = card.ask();
    card.release();
    expect(await third).toBe('deny');
  });
});
