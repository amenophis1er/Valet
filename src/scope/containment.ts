/*
 * Navigation containment: declarativeNetRequest session rules
 * that block the agent's tabs from loading a top-level page on an origin the
 * run has not approved — before the request leaves the browser. A pre-dispatch
 * check cannot see where a form post, a redirect or a script navigation will
 * go; these rules can.
 *
 * One block rule for `main_frame` requests from the agent's tabs, and one
 * higher-priority allow rule per approved origin, its urlFilter anchored to
 * that origin's own scheme, host and port. Rebuilt whenever the tab set or the
 * scope changes; cleared when no run is active, so the owner's own browsing in
 * a handed tab is never blocked.
 */

export interface DnrRule {
  id: number;
  priority: number;
  action: { type: 'block' | 'allow' };
  condition: { tabIds: number[]; resourceTypes: ['main_frame']; urlFilter?: string };
}

/** Any session rule: containment's, or the provider rules (provider-rules.ts). */
export interface SessionRule { id: number; priority: number; action: object; condition: object }

export interface DnrLike {
  getSessionRules(): Promise<Array<{ id: number }>>;
  updateSessionRules(options: { removeRuleIds?: number[]; addRules?: SessionRule[] }): Promise<void>;
}

/** Our rule ids live in one range so other session rules (the library's) are untouched. */
export const RULE_BASE = 50_000;
const RULE_LIMIT = 1_000;

/** One conversation's containment: its tabs, and the origins its run has approved. */
export interface ContainmentGroup { tabIds: readonly number[]; origins: readonly string[] }

/**
 * The rules for every conversation at once, ids running on from RULE_BASE.
 * Each group's rules name only its own tabs, so conversations never see each
 * other's approvals.
 */
export function containmentRules(groups: readonly ContainmentGroup[]): DnrRule[] {
  const rules: DnrRule[] = [];
  for (const group of groups) {
    if (group.tabIds.length === 0) continue;
    const ids = [...new Set(group.tabIds)].sort((a, b) => a - b);
    if (rules.length >= RULE_LIMIT) break;
    rules.push({ id: RULE_BASE + rules.length, priority: 1, action: { type: 'block' }, condition: { tabIds: ids, resourceTypes: ['main_frame'] } });
    for (const origin of [...new Set(group.origins)].sort()) {
      if (rules.length >= RULE_LIMIT) break;
      rules.push({ id: RULE_BASE + rules.length, priority: 2, action: { type: 'allow' },
        condition: { tabIds: ids, resourceTypes: ['main_frame'], urlFilter: `|${origin}/` } });
    }
  }
  return rules;
}

export class Containment {
  #dnr: DnrLike;
  #chain: Promise<void> = Promise.resolve();
  /** What each conversation has asked for, by its id; the rules are rebuilt from all of them. */
  #groups = new Map<string, ContainmentGroup>();

  constructor(dnr: DnrLike) {
    this.#dnr = dnr;
  }

  /** Set one conversation's containment and replace our rules; serialized so two updates never interleave. Resolves once Chrome has them. */
  apply(key: string, tabIds: readonly number[], origins: readonly string[]): Promise<void> {
    if (tabIds.length === 0) this.#groups.delete(key);
    else this.#groups.set(key, { tabIds: [...tabIds], origins: [...origins] });
    const groups = [...this.#groups.values()];
    const run = this.#chain.then(async () => {
      const ours = (await this.#dnr.getSessionRules()).map((rule) => rule.id).filter((id) => id >= RULE_BASE && id < RULE_BASE + RULE_LIMIT);
      await this.#dnr.updateSessionRules({ removeRuleIds: ours, addRules: containmentRules(groups) });
    });
    this.#chain = run.catch(() => undefined);
    return run;
  }

  /** No containment for this conversation (no run is active in it); the others' rules stay. */
  clear(key: string): Promise<void> {
    return this.apply(key, [], []);
  }
}
