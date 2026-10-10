/*
 * The network rules subscription sign-ins need (extension-ai-connect): on
 * Anthropic's and OpenAI's endpoints, requests must not look like they come
 * from a web page, so these strip Origin and Sec-Fetch-* and set the
 * user-agent those backends expect.
 *
 * One more is this extension's own: a model server on this computer (Ollama,
 * LM Studio…) refuses requests whose Origin it does not know, and Ollama does
 * not know chrome-extension:// by default. Our requests to localhost go
 * without an Origin, so they work with no setup.
 *
 * All are installed as session rules limited to this extension's own
 * requests — no tab (`tabIds: [-1]`), initiated by this extension — so the
 * owner's own visits to claude.com or chatgpt.com are never touched, and no
 * web page ever reaches a local server without its Origin. Their ids
 * (9001–9003, 9010) sit outside containment's range.
 */

import rules from '@amenophis1er/extension-ai-connect/dnr-rules.json' with { type: 'json' };
import type { DnrLike, SessionRule } from './containment.js';

type LibraryRule = { id: number; priority: number; action: object; condition: Record<string, unknown> };

/** Local model servers: our requests reach them without an Origin header. */
const LOCAL_SERVERS: LibraryRule = {
  id: 9010, priority: 1,
  action: { type: 'modifyHeaders', requestHeaders: [{ header: 'origin', operation: 'remove' }] },
  condition: { requestDomains: ['localhost', '127.0.0.1'], resourceTypes: ['xmlhttprequest'] },
};

export function providerRules(extensionId: string): SessionRule[] {
  return [...(rules as LibraryRule[]), LOCAL_SERVERS].map((rule) => {
    const { excludedInitiatorDomains: _pages, ...condition } = rule.condition;
    return { ...rule, condition: { ...condition, tabIds: [-1], initiatorDomains: [extensionId] } };
  });
}

/** Replace any earlier copy: the worker installs them each time it starts. */
export async function installProviderRules(dnr: DnrLike, extensionId: string): Promise<void> {
  const fresh = providerRules(extensionId);
  await dnr.updateSessionRules({ removeRuleIds: fresh.map((rule) => rule.id), addRules: fresh });
}
