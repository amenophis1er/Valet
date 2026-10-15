/** What the model reads back of a conversation: old page evidence compacted, the outcomes kept. */
import type { AIMessage } from '@amenophis1er/byok/types';
import { describe, expect, it } from 'vitest';
import { historyView } from './prompt.js';

const tool = (id: string, result: unknown): AIMessage => ({ role: 'tool', toolCallId: id, name: 'browser', content: JSON.stringify(result) });
const observed = (id: string) => tool(id, { completed: true, observation: { id, url: 'https://example.test/', title: 'Example', tree: `tree ${id}` }, notice: 'n' });
const read = (id: string, part: number) => tool(id, { completed: true, read: { url: 'https://example.test/', title: 'Example', part, parts: 6, text: `text of part ${part}` }, notice: 'n' });
const parsed = (message: AIMessage) => JSON.parse(String(message.content)) as Record<string, Record<string, unknown>>;

describe('the history the model reads', () => {
  it('keeps the three newest big observations in full, older ones as url and title', () => {
    const big = (id: string) => tool(id, { completed: true, observation: { id, url: 'https://example.test/', title: 'Example', tree: `tree ${id} ${'x'.repeat(30_000)}` }, notice: 'n' });
    const view = historyView(['a', 'b', 'c', 'd'].map(big));
    expect(parsed(view[0]!)['observation']).toEqual({ url: 'https://example.test/', title: 'Example', compacted: expect.stringMatching(/no longer shown.*Work from your notepad/) });
    for (const message of view.slice(1)) expect(parsed(message)['observation']!['tree']).toMatch(/^tree /);
  });

  it('keeps small observations in full past the newest three, while they fit the budget: a result line is not cut from under the model', () => {
    // A dialog answered on a small page, three times over: six small observations, all still readable.
    const view = historyView(['a', 'b', 'c', 'd', 'e', 'f'].map(observed));
    for (const message of view) expect(parsed(message)['observation']!['tree']).toMatch(/^tree /);
    // Big pages still fall to url and title past the newest three.
    const big = (id: string) => tool(id, { completed: true, observation: { id, url: 'https://example.test/', title: 'Example', tree: `tree ${id} ${'x'.repeat(30_000)}` }, notice: 'n' });
    const mixed = historyView([observed('s1'), big('b1'), big('b2'), big('b3'), big('b4')]);
    expect(parsed(mixed[0]!)['observation']!['compacted']).toBeDefined();
    expect(parsed(mixed[1]!)['observation']!['compacted']).toBeDefined();
    for (const message of mixed.slice(2)) expect(parsed(message)['observation']!['tree']).toMatch(/^tree /);
  });

  it('keeps page text in full up to its budget, newest first, and says what an older part was', () => {
    const big = (id: string, part: number) => tool(id, { completed: true, read: { url: 'https://example.test/', title: 'Example', part, parts: 14, text: `${part}:${'x'.repeat(12_000)}` }, notice: 'n' });
    const view = historyView(Array.from({ length: 14 }, (_, i) => big(`r${i + 1}`, i + 1)));
    const kept = view.filter((message) => 'text' in parsed(message)['read']!);
    expect(kept.length).toBeGreaterThanOrEqual(9);
    expect(kept.length).toBeLessThan(14);
    // The newest parts are the ones kept; the oldest say they were read and not to read them again.
    expect(parsed(view.at(-1)!)['read']!['part']).toBe(14);
    expect('text' in parsed(view.at(-1)!)['read']!).toBe(true);
    expect(parsed(view[0]!)['read']).toMatchObject({ part: 1, parts: 14, compacted: expect.stringMatching(/Do not read it again just to have it/) });
  });

  it('keeps a whole shorter article in full', () => {
    const view = historyView([1, 2, 3, 4, 5, 6].map((part) => read(`r${part}`, part)));
    for (const [i, message] of view.entries()) expect(parsed(message)['read']!['text']).toBe(`text of part ${i + 1}`);
  });

  it('counts observations and reads apart: reading does not push an observation out', () => {
    const view = historyView([observed('o1'), read('r1', 1), read('r2', 2), read('r3', 3), read('r4', 4), read('r5', 5)]);
    expect(parsed(view[0]!)['observation']!['tree']).toBe('tree o1');
    expect(parsed(view[1]!)['read']!['text']).toBe('text of part 1');
  });

  describe('a page opened again and again', () => {
    const call = (id: string, args: Record<string, unknown>): AIMessage => ({ role: 'assistant', content: '', toolCalls: [{ id, name: 'browser', args }] });
    const visit = (id: string, url: string): AIMessage[] => [call(id, { action: 'navigate', url }), tool(id, { completed: true, observation: { id, url, title: 'Book', tree: `tree ${id}` } })];
    const books = ['a', 'b', 'c', 'd', 'e'].map((book) => `https://books.test/${book}/index.html`);
    const revisited = (message: AIMessage) => parsed(message)['revisited'] as unknown as string | undefined;

    it('says so from the third time: the model is told to work from its notes', () => {
      const history = [...books, ...books, ...books].flatMap((url, i) => visit(`n${i}`, url));
      const view = historyView(history);
      const results = view.filter((message) => message.role === 'tool');
      expect(results.slice(0, 10).map(revisited)).toEqual(Array(10).fill(undefined));
      expect(revisited(results[10]!)).toMatch(/opened this page 3 times.*notepad/);
      expect(results.slice(10).every((message) => revisited(message) !== undefined)).toBe(true);
    });

    it('counts the same page with a #fragment or a trailing slash as one, and never an observe of the page it is on', () => {
      const observe = (id: string): AIMessage[] => [call(id, { action: 'observe' }), tool(id, { completed: true, observation: { id, url: 'https://books.test/a', title: 'Book', tree: 't' } })];
      const view = historyView([...visit('n1', 'https://books.test/a'), ...observe('o1'), ...observe('o2'), ...visit('n2', 'https://books.test/a/'), ...visit('n3', 'https://books.test/a#reviews')]);
      expect(view.filter((message) => message.role === 'tool').map(revisited).map(Boolean)).toEqual([false, false, false, false, true]);
    });

    it('leaves what came before as it was when the conversation grows, so the provider\'s cache still holds it', () => {
      const history = [...books, ...books, ...books].flatMap((url, i) => visit(`n${i}`, url));
      const before = historyView(history.slice(0, 24));
      const after = historyView(history);
      // Past the newest few pages, which are compacted as newer ones arrive.
      expect(after.slice(0, 18)).toEqual(before.slice(0, 18));
    });
  });
});
