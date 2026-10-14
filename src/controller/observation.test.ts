/** The serialized observation never exceeds its bound. */
import { describe, expect, it } from 'vitest';
import type { Observation } from '../executor/protocol.js';
import { MAX_OBSERVATION_CHARS, boundObservation, targetInTree } from './observation.js';

const base = (overrides: Partial<Observation> = {}): Observation => ({
  id: 'o1', url: 'https://example.test/', title: 'Example', tree: '- main', targets: [], tabs: [],
  capturedAt: '2026-09-26T12:00:00.000Z', ...overrides,
});
const size = (value: unknown) => JSON.stringify(value).length;

describe('boundObservation', () => {
  it('leaves an observation that fits untouched', () => {
    const observation = base();
    expect(boundObservation(observation)).toEqual(observation);
  });

  it('fits 240 long-named targets with long hrefs under the bound', () => {
    const targets = Array.from({ length: 240 }, (_, i) => ({
      ref: `e${i + 1}`, frame: 0, role: 'link', name: `Row ${i} ${'n'.repeat(290)}`, href: `https://example.test/${'p'.repeat(2000)}`,
    }));
    const bounded = boundObservation(base({ tree: 't'.repeat(32_000), targets }));
    expect(size(bounded)).toBeLessThanOrEqual(MAX_OBSERVATION_CHARS);
    expect(bounded.targets!.length).toBeGreaterThan(0);
    expect(bounded.targets![0]!.name.length).toBeLessThanOrEqual(120);
    expect(bounded.targets![0]!.href!.length).toBeLessThanOrEqual(300);
  });

  it('says how many targets it dropped', () => {
    const targets = Array.from({ length: 240 }, (_, i) => ({ ref: `e${i + 1}`, frame: 0, role: 'link', name: 'n'.repeat(120) }));
    const bounded = boundObservation(base({ tree: 't'.repeat(31_000), targets }));
    expect(size(bounded)).toBeLessThanOrEqual(MAX_OBSERVATION_CHARS);
    expect(bounded.tree).toMatch(/\d+ more targets not shown/);
  });

  it('bounds a tree that JSON escaping grows past the limit', () => {
    const bounded = boundObservation(base({ tree: '\\'.repeat(32_000) }));
    expect(size(bounded)).toBeLessThanOrEqual(MAX_OBSERVATION_CHARS);
  });

  it('trims the tabs, the url and the title', () => {
    const tabs = Array.from({ length: 100 }, (_, i) => ({ id: `tab-${i}`, url: `https://example.test/${'u'.repeat(2000)}`, title: 't'.repeat(500) }));
    const bounded = boundObservation(base({ url: `https://example.test/${'u'.repeat(3000)}`, title: 't'.repeat(1000), tabs }));
    expect(size(bounded)).toBeLessThanOrEqual(MAX_OBSERVATION_CHARS);
    expect(bounded.url.length).toBeLessThanOrEqual(2048);
    expect(bounded.title.length).toBeLessThanOrEqual(300);
  });

  it('falls back to a minimal observation rather than exceed a tiny bound', () => {
    const bounded = boundObservation(base({ tree: 't'.repeat(5_000) }), 400);
    expect(size(bounded)).toBeLessThanOrEqual(400);
  });
});

describe('targetInTree', () => {
  const tree = ['- main', '  - link "Blue mug" [ref=e84]', '  - link "Blue mug set" [ref=e8]', '  - button [ref=e9]', '  - textbox "Search" value=\'mugs\' [ref=e12]'].join('\n');

  it('reads a ref\'s role and name back from its line, never from a ref that only starts the same', () => {
    expect(targetInTree(tree, 'e84')).toEqual({ ref: 'e84', role: 'link', name: 'Blue mug' });
    expect(targetInTree(tree, 'e8')).toEqual({ ref: 'e8', role: 'link', name: 'Blue mug set' });
    expect(targetInTree(tree, 'e12')).toEqual({ ref: 'e12', role: 'textbox', name: 'Search' });
  });

  it('gives an unnamed element its role, and nothing for a ref not in the tree', () => {
    expect(targetInTree(tree, 'e9')).toEqual({ ref: 'e9', role: 'button', name: '' });
    expect(targetInTree(tree, 'e99')).toBeUndefined();
  });
});
