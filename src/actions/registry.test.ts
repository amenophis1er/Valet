/**
 * The registry is coherent: one spec per action, every field an action names
 * exists, and the facts the controller relies on are where they should be.
 */
import { describe, expect, it } from 'vitest';
import { FIELDS, FIELD_NAMES } from './fields.js';
import { ACTING, ACTIONS, SPECS } from './index.js';

describe('the action registry', () => {
  it('has exactly one spec per action, under its own name', () => {
    expect(Object.keys(SPECS)).toEqual([...ACTIONS]);
    for (const name of ACTIONS) expect(SPECS[name].name).toBe(name);
  });

  it('names only fields that exist, and every exclusive field has an action that takes it', () => {
    for (const spec of Object.values(SPECS)) {
      for (const field of [...(spec.fields.required ?? []), ...(spec.fields.optional ?? [])]) expect(FIELD_NAMES).toContain(field);
    }
    for (const field of FIELD_NAMES) {
      if (!(FIELDS[field] as { exclusive?: boolean }).exclusive) continue;
      expect(Object.values(SPECS).some((spec) => spec.fields.required?.includes(field) || spec.fields.optional?.includes(field))).toBe(true);
    }
  });

  it('marks as acting exactly the actions that change the page through an element or the viewport', () => {
    expect(ACTING).toEqual(['click', 'hover', 'drag', 'fill', 'select', 'press', 'scroll', 'dialog']);
  });

  it('declares the facts the controller enforces: where a call goes, links followed, and submissions', () => {
    expect(SPECS.navigate.facts.goesTo?.({ action: 'navigate', url: 'https://a.test/' })).toBe('https://a.test/');
    expect(SPECS.click.facts.followsLink).toBe(true);
    expect(SPECS.click.facts.submits?.({ action: 'click' })).toBe('click');
    expect(SPECS.click.facts.submits?.({ action: 'click', button: 'right' })).toBeUndefined();
    expect(SPECS.press.facts.submits?.({ action: 'press', key: 'Enter' })).toBe('enter');
    expect(SPECS.press.facts.submits?.({ action: 'press', key: 'Space' })).toBe('space');
    expect(SPECS.press.facts.submits?.({ action: 'press', key: 'Tab' })).toBeUndefined();
    // Nothing else can submit, follow a link or go anywhere.
    for (const name of ACTIONS.filter((n) => !['click', 'press'].includes(n))) expect(SPECS[name].facts.submits).toBeNull();
    for (const name of ACTIONS.filter((n) => n !== 'click')) expect(SPECS[name].facts.followsLink).toBe(false);
    for (const name of ACTIONS.filter((n) => n !== 'navigate')) expect(SPECS[name].facts.goesTo).toBeNull();
  });
});
