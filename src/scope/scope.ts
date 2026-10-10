/*
 * Which origins the agent may act on, and which form submissions it may send.
 *
 * The unit is an origin — scheme, host and port — compared exactly: approving
 * https://mail.example.com does not approve https://example.com. Nothing here
 * is saved: every approval lasts for one request or one conversation.
 *
 * Sites: "Allow once" covers the current request (one run), "Allow in this
 * chat" the whole conversation, and Auto every site for the conversation.
 * A Deny covers the current request, beats everything else, and takes back
 * an earlier "Allow in this chat" for that site.
 *
 * Forms: "Allow once" sends this submission, "Allow in this chat" every
 * submission to that destination in the conversation. Auto covers a form that
 * only reads (method GET: a search, a filter), never one that sends data
 * (POST), which can save, pay, delete or message on the owner's behalf.
 */

/** The origin of an http(s) URL, or null for anything else (about:blank, data:, chrome://…). */
export function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null;
  } catch {
    return null;
  }
}

/** An answer to a card. `auto` is only offered for sites. */
export type Decision = 'once' | 'chat' | 'auto' | 'deny';
export type Verdict = 'allowed' | 'denied' | 'ask';
/** Ask before each new site, or approve every site without a card (a form that sends data still asks). */
export type Mode = 'ask' | 'auto';

/** What a form approval or denial is about: the exact destination, not the values. */
export interface SubmitTarget { pageOrigin: string; action: string; method: string }

export interface Scope {
  mode: Mode;
  /** Allowed for the current request; cleared when the next one starts. */
  runOrigins: string[];
  /** Allowed for the whole conversation. */
  chatOrigins: string[];
  /** Denied in the current request. */
  deniedOrigins: string[];
  chatSubmissions: SubmitTarget[];
  deniedSubmissions: SubmitTarget[];
}

function sameTarget(a: SubmitTarget, b: SubmitTarget): boolean {
  return a.pageOrigin === b.pageOrigin && a.action === b.action && a.method === b.method;
}

export function newScope(mode: Mode = 'ask'): Scope {
  return { mode, runOrigins: [], chatOrigins: [], deniedOrigins: [], chatSubmissions: [], deniedSubmissions: [] };
}

/** A new request in the same conversation: its one-request approvals and denials start over. */
export function nextRun(scope: Scope): Scope {
  return { ...scope, runOrigins: [], deniedOrigins: [], deniedSubmissions: [] };
}

export function verdict(origin: string, scope: Scope): Verdict {
  if (scope.deniedOrigins.includes(origin)) return 'denied';
  if (scope.mode === 'auto' || scope.runOrigins.includes(origin) || scope.chatOrigins.includes(origin)) return 'allowed';
  return 'ask';
}

export function submitVerdict(target: SubmitTarget, scope: Scope): Verdict {
  if (scope.deniedSubmissions.some((denied) => sameTarget(denied, target))) return 'denied';
  if (scope.chatSubmissions.some((allowed) => sameTarget(allowed, target))) return 'allowed';
  // In Auto, a submission that only reads goes through like a navigation; one that sends data is still the owner's call.
  if (scope.mode === 'auto' && target.method.toLowerCase() === 'get') return 'allowed';
  return 'ask';
}

/** Record an answer about a site. */
export function decide(scope: Scope, origin: string, decision: Decision): Scope {
  const without = (list: string[]) => list.filter((entry) => entry !== origin);
  const base = { ...scope, deniedOrigins: without(scope.deniedOrigins) };
  if (decision === 'deny') return { ...scope, runOrigins: without(scope.runOrigins), chatOrigins: without(scope.chatOrigins), deniedOrigins: [...without(scope.deniedOrigins), origin] };
  if (decision === 'once') return { ...base, runOrigins: [...without(scope.runOrigins), origin] };
  if (decision === 'chat') return { ...base, chatOrigins: [...without(scope.chatOrigins), origin] };
  return { ...base, mode: 'auto' };
}

/** Record an answer about a form submission. "Allow once" leaves nothing behind. */
export function decideSubmission(scope: Scope, target: SubmitTarget, decision: Decision): Scope {
  const without = (list: SubmitTarget[]) => list.filter((entry) => !sameTarget(entry, target));
  if (decision === 'deny') return { ...scope, chatSubmissions: without(scope.chatSubmissions), deniedSubmissions: [...without(scope.deniedSubmissions), target] };
  if (decision === 'chat') return { ...scope, chatSubmissions: [...without(scope.chatSubmissions), target], deniedSubmissions: without(scope.deniedSubmissions) };
  return { ...scope, deniedSubmissions: without(scope.deniedSubmissions) };
}

/** The origins navigation may reach now, for containment; null in Auto (no site is blocked). */
export function reachable(scope: Scope): string[] | null {
  if (scope.mode === 'auto') return null;
  return [...new Set([...scope.runOrigins, ...scope.chatOrigins])].filter((origin) => !scope.deniedOrigins.includes(origin));
}
