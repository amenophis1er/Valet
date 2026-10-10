/** What the model reads back of a conversation: old page evidence compacted, the outcomes kept. */
import type { AIMessage } from '@amenophis1er/byok/types';
import { describe, expect, it } from 'vitest';
import { historyView } from './prompt.js';

const tool = (id: string, result: unknown): AIMessage => ({ role: 'tool', toolCallId: id, name: 'browser', content: JSON.stringify(result) });
const observed = (id: string) => tool(id, { completed: true, observation: { id, url: 'https://example.test/', title: 'Example', tree: `tree ${id}` }, notice: 'n' });
const read = (id: string, part: number) => tool(id, { completed: true, read: { url: 'https://example.test/', title: 'Example', part, parts: 6, text: `text of part ${part}` }, notice: 'n' });
const parsed = (message: AIMessage) => JSON.parse(String(message.content)) as Record<string, Record<string, unknown>>;

describe('the history the model reads', () => {
  it('keeps the three newest observations in full, older ones as url and title', () => {
    const view = historyView(['a', 'b', 'c', 'd'].map(observed));
    expect(parsed(view[0]!)['observation']).toEqual({ url: 'https://example.test/', title: 'Example', compacted: true });
    for (const message of view.slice(1)) expect(parsed(message)['observation']!['tree']).toMatch(/^tree /);
  });

  it('keeps the four newest parts of page text in full, and says what an older part was', () => {
    const view = historyView([1, 2, 3, 4, 5, 6].map((part) => read(`r${part}`, part)));
    for (const message of view.slice(0, 2)) {
      expect(parsed(message)['read']).toMatchObject({ part: expect.any(Number), parts: 6, compacted: expect.stringMatching(/Read it again/) });
      expect(parsed(message)['read']).not.toHaveProperty('text');
    }
    for (const [i, message] of view.slice(2).entries()) expect(parsed(message)['read']!['text']).toBe(`text of part ${i + 3}`);
  });

  it('counts observations and reads apart: reading does not push an observation out', () => {
    const view = historyView([observed('o1'), read('r1', 1), read('r2', 2), read('r3', 3), read('r4', 4), read('r5', 5)]);
    expect(parsed(view[0]!)['observation']!['tree']).toBe('tree o1');
    expect(parsed(view[1]!)['read']).toHaveProperty('compacted');
  });
});
