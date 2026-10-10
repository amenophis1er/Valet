/*
 * Which panel each tab shows. A tab the panel was opened on shows its own
 * conversation; a tab the agent opened shows the conversation it belongs to,
 * so switching over to watch the agent keeps that conversation in view. Read
 * from the executor's tab snapshot, so a restarted worker assigns the same
 * panels as before and never reloads an open one into an empty conversation.
 */
import { panelPath, tabOfConversation } from './loop/protocol.js';

/** The executor's snapshot, as much of it as the panels need. */
type Snapshot = { sessions?: Array<[string, { tabs?: Array<[string, number]> }]> } | undefined;

/** The agent's tabs, each with the panel of the conversation it belongs to. */
export function agentPanelPaths(snapshot: unknown): Map<number, string> {
  const paths = new Map<number, string>();
  for (const [id, session] of (snapshot as Snapshot)?.sessions ?? []) {
    const origin = tabOfConversation(id);
    if (origin === undefined) continue;
    for (const [, tabId] of session.tabs ?? []) if (tabId !== origin) paths.set(tabId, panelPath(origin));
  }
  return paths;
}

/** Every open tab's panel: the agent's tabs as above, every other tab its own. */
export function panelAssignments(tabIds: readonly number[], snapshot: unknown): Map<number, string> {
  const paths = agentPanelPaths(snapshot);
  for (const tabId of tabIds) if (!paths.has(tabId)) paths.set(tabId, panelPath(tabId));
  return paths;
}
