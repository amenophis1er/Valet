import { describe, expect, it } from 'vitest';
import { Containment, RULE_BASE, containmentRules, type DnrRule } from './containment.js';

describe('containmentRules', () => {
  it('blocks top-level loads in the agent tabs, and allows each approved origin by its own scheme, host and port', () => {
    const rules = containmentRules([{ tabIds: [12, 7, 12], origins: ['https://shop.test', 'http://localhost:5173'] }]);
    expect(rules).toEqual([
      { id: RULE_BASE, priority: 1, action: { type: 'block' }, condition: { tabIds: [7, 12], resourceTypes: ['main_frame'] } },
      { id: RULE_BASE + 1, priority: 2, action: { type: 'allow' }, condition: { tabIds: [7, 12], resourceTypes: ['main_frame'], urlFilter: '|http://localhost:5173/' } },
      { id: RULE_BASE + 2, priority: 2, action: { type: 'allow' }, condition: { tabIds: [7, 12], resourceTypes: ['main_frame'], urlFilter: '|https://shop.test/' } },
    ]);
  });

  it('has no rules without agent tabs', () => {
    expect(containmentRules([{ tabIds: [], origins: ['https://shop.test'] }])).toEqual([]);
    expect(containmentRules([])).toEqual([]);
  });

  it('keeps two conversations apart: each group\'s rules name only its own tabs', () => {
    const rules = containmentRules([{ tabIds: [1], origins: ['https://a.test'] }, { tabIds: [2, 3], origins: [] }]);
    expect(rules).toEqual([
      { id: RULE_BASE, priority: 1, action: { type: 'block' }, condition: { tabIds: [1], resourceTypes: ['main_frame'] } },
      { id: RULE_BASE + 1, priority: 2, action: { type: 'allow' }, condition: { tabIds: [1], resourceTypes: ['main_frame'], urlFilter: '|https://a.test/' } },
      { id: RULE_BASE + 2, priority: 1, action: { type: 'block' }, condition: { tabIds: [2, 3], resourceTypes: ['main_frame'] } },
    ]);
  });
});

describe('Containment', () => {
  it('replaces only its own rules, and never interleaves two updates', async () => {
    let rules: Array<{ id: number }> = [{ id: 9002 }];
    const calls: string[] = [];
    const dnr = {
      async getSessionRules() { return rules; },
      async updateSessionRules({ removeRuleIds = [], addRules = [] }: { removeRuleIds?: number[]; addRules?: DnrRule[] }) {
        calls.push(`remove ${removeRuleIds.join(',') || '-'} add ${addRules.length}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        rules = [...rules.filter((rule) => !removeRuleIds.includes(rule.id)), ...addRules];
      },
    };
    const containment = new Containment(dnr);
    await Promise.all([containment.apply('x', [1], ['https://a.test']), containment.apply('x', [1], ['https://a.test', 'https://b.test'])]);
    expect(calls).toEqual(['remove - add 2', `remove ${RULE_BASE},${RULE_BASE + 1} add 3`]);
    expect(rules.map((rule) => rule.id)).toEqual([9002, RULE_BASE, RULE_BASE + 1, RULE_BASE + 2]);
    await containment.clear('x');
    expect(rules.map((rule) => rule.id)).toEqual([9002]);
  });

  it('clearing one conversation leaves the other\'s rules in place', async () => {
    let rules: Array<{ id: number }> = [];
    const dnr = {
      async getSessionRules() { return rules; },
      async updateSessionRules({ removeRuleIds = [], addRules = [] }: { removeRuleIds?: number[]; addRules?: DnrRule[] }) {
        rules = [...rules.filter((rule) => !removeRuleIds.includes(rule.id)), ...addRules];
      },
    };
    const containment = new Containment(dnr);
    await containment.apply('a', [1], ['https://a.test']);
    await containment.apply('b', [2], ['https://b.test']);
    expect((rules as DnrRule[]).map((rule) => rule.condition.tabIds)).toEqual([[1], [1], [2], [2]]);
    await containment.clear('a');
    expect((rules as DnrRule[]).map((rule) => [rule.condition.tabIds, rule.condition.urlFilter])).toEqual([[[2], undefined], [[2], '|https://b.test/']]);
  });
});
