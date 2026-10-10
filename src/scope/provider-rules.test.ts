import { describe, expect, it } from 'vitest';
import { installProviderRules, providerRules } from './provider-rules.js';
import { RULE_BASE } from './containment.js';

describe('provider rules', () => {
  it('apply only to this extension\'s own requests, never to pages', () => {
    const rules = providerRules('abcdefghijklmnop');
    expect(rules.map((rule) => rule.id)).toEqual([9001, 9002, 9003, 9010]);
    for (const rule of rules) {
      expect(rule.condition).toMatchObject({ tabIds: [-1], initiatorDomains: ['abcdefghijklmnop'] });
      expect(rule.condition).not.toHaveProperty('excludedInitiatorDomains');
      expect(rule.id < RULE_BASE).toBe(true);
    }
    expect(rules[0]!.condition).toMatchObject({ urlFilter: '||platform.claude.com/' });
    expect(rules[2]!.condition).toMatchObject({ requestDomains: ['auth.openai.com', 'chatgpt.com'] });
    // Local model servers get our requests without an Origin, and only ours.
    expect(rules[3]).toMatchObject({ action: { type: 'modifyHeaders', requestHeaders: [{ header: 'origin', operation: 'remove' }] },
      condition: { requestDomains: ['localhost', '127.0.0.1'], tabIds: [-1], initiatorDomains: ['abcdefghijklmnop'] } });
  });

  it('replace an earlier copy when the worker starts again', async () => {
    const calls: Array<{ removeRuleIds?: number[]; addRules?: Array<{ id: number }> }> = [];
    await installProviderRules({ getSessionRules: async () => [], updateSessionRules: async (options) => { calls.push(options); } }, 'ext');
    expect(calls).toEqual([{ removeRuleIds: [9001, 9002, 9003, 9010], addRules: expect.arrayContaining([expect.objectContaining({ id: 9001 })]) }]);
  });
});
