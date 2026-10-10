/** The executor's stop switch and error wording, with no Chrome. */
import { describe, expect, it } from 'vitest';
import { Cancellation, CancelledError, sentence } from './protocol.js';

describe('Cancellation', () => {
  it('starts neither cancelled nor dispatched', () => {
    const cancel = new Cancellation();
    expect(cancel.cancelled).toBe(false);
    expect(cancel.dispatched).toBe(false);
    expect(() => cancel.check()).not.toThrow();
  });

  it('throws on the next check once cancelled', () => {
    const cancel = new Cancellation();
    cancel.cancel();
    expect(() => cancel.check()).toThrow(CancelledError);
  });

  it('remembers that a step changing the browser had started, even after a cancel', () => {
    const cancel = new Cancellation();
    cancel.dispatch();
    cancel.cancel();
    expect(cancel.dispatched).toBe(true);
    expect(cancel.cancelled).toBe(true);
  });
});

describe('sentence', () => {
  it('ends a message the owner will read', () => {
    expect(sentence(new Error('nothing there'))).toBe('nothing there.');
    expect(sentence(new Error('Nothing there!'))).toBe('Nothing there!');
    expect(sentence(new Error('  '))).toBe('The browser extension could not run that command.');
  });
});
