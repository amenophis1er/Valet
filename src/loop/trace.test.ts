import { describe, expect, it } from 'vitest';
import { MAX_EVENTS, MAX_TRACE_CHARS, Trace, clip, type TraceEvent } from './trace.js';

describe('the run trace', () => {
  it('cuts long strings and says how much was cut, at any depth', () => {
    const cut = clip({ a: 'x'.repeat(5_000), b: ['y'.repeat(4_100)], c: 3 }) as { a: string; b: string[]; c: number };
    expect(cut.a).toMatch(/^x{4000}… \[1000 more characters\]$/);
    expect(cut.b[0]).toMatch(/\[100 more characters\]$/);
    expect(cut.c).toBe(3);
  });

  it('keeps the newest events within its count and size budget', () => {
    let now = 0;
    const trace = new Trace(() => (now += 1));
    for (let i = 0; i < MAX_EVENTS + 50; i += 1) trace.record({ kind: 'note', text: `n${i}` });
    expect(trace.events).toHaveLength(MAX_EVENTS);
    expect((trace.events.at(-1) as Extract<TraceEvent, { kind: 'note' }>).text).toBe(`n${MAX_EVENTS + 49}`);
    const big = new Trace(() => 0);
    for (let i = 0; i < 500; i += 1) big.record({ kind: 'note', text: 'z'.repeat(3_900) });
    expect(JSON.stringify(big.events).length).toBeLessThanOrEqual(MAX_TRACE_CHARS);
  });

  it('persists to its store, restores from it, and clears it', async () => {
    let stored: unknown;
    const store = { get: async () => stored, set: async (events: TraceEvent[]) => { stored = structuredClone(events); }, remove: async () => { stored = undefined; } };
    const trace = new Trace(() => 7, store);
    trace.record({ kind: 'note', text: 'kept' });
    trace.persist();
    const again = new Trace(() => 8, store);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await again.restore();
    expect(again.events).toEqual([{ at: 7, kind: 'note', text: 'kept' }]);
    await again.clear();
    expect(stored).toBeUndefined();
  });
});
