import { describe, expect, it } from 'vitest';
import { EVERY_MS, KeepAlive, type Timers } from './keepalive.js';

function fakeTimers() {
  const intervals = new Map<number, { callback: () => void; ms: number }>();
  let next = 1;
  const timers: Timers = {
    set: (callback, ms) => { intervals.set(next, { callback, ms }); return next++; },
    clear: (handle) => { intervals.delete(handle as number); },
  };
  return { timers, intervals, tick: () => { for (const { callback } of intervals.values()) callback(); } };
}

describe('the worker keeps itself alive while a run is going', () => {
  it('pings every 20 seconds from the first running conversation to the last', () => {
    const { timers, intervals, tick } = fakeTimers();
    let pings = 0;
    const keep = new KeepAlive(() => { pings++; }, timers);
    expect(keep.active).toBe(false);

    keep.want('tab:1', true);
    expect(keep.active).toBe(true);
    expect([...intervals.values()][0]?.ms).toBe(EVERY_MS);
    tick();
    expect(pings).toBe(1);

    keep.want('tab:2', true);
    expect(intervals.size).toBe(1); // one interval, however many runs
    keep.want('tab:1', false);
    expect(keep.active).toBe(true); // tab:2 is still running
    tick();
    expect(pings).toBe(2);

    keep.want('tab:2', false);
    expect(keep.active).toBe(false);
    expect(intervals.size).toBe(0);
    tick();
    expect(pings).toBe(2);
  });

  it('is unmoved by a conversation that was never running going idle', () => {
    const { timers, intervals } = fakeTimers();
    const keep = new KeepAlive(() => {}, timers);
    keep.want('tab:1', false);
    keep.want('tab:1', false);
    expect(keep.active).toBe(false);
    expect(intervals.size).toBe(0);
  });
});
