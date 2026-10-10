/*
 * Bounding an observation as serialized.
 *
 * The executor caps the tree at 32k chars, but not the targets (240 × a 300-char
 * name + a 2,048-char href), the tabs, the url or the title, and JSON escaping
 * can grow the tree itself. So the bound is on `JSON.stringify` length, applied
 * in steps until it fits, and never exceeded: past the last step the model gets
 * a minimal observation that says the page is too large.
 */

import type { Observation } from '../executor/protocol.js';

export const MAX_OBSERVATION_CHARS = 48_000;

const size = (value: unknown): number => JSON.stringify(value).length;
const cut = (text: string, limit: number): string => (text.length > limit ? text.slice(0, limit) : text);

export function boundObservation(observation: Observation, limit = MAX_OBSERVATION_CHARS): Observation {
  let bounded: Observation = { ...observation, url: cut(observation.url, 2048), title: cut(observation.title, 300) };
  if (size(bounded) <= limit) return bounded;

  bounded = {
    ...bounded,
    targets: bounded.targets?.map((target) => ({
      ...target, name: cut(target.name, 120), ...(target.href !== undefined ? { href: cut(target.href, 300) } : {}),
    })),
    tabs: bounded.tabs.slice(0, 20).map((tab) => ({ ...tab, title: cut(tab.title, 120), url: cut(tab.url, 300) })),
  };
  if (size(bounded) <= limit) return bounded;

  // Drop targets from the end, halving the count until the rest fits.
  const all = bounded.targets ?? [];
  let keep = all.length;
  while (keep > 0 && size({ ...bounded, targets: all.slice(0, keep) }) > limit) keep = Math.floor(keep / 2);
  const dropped = all.length - keep;
  if (dropped > 0) {
    bounded = { ...bounded, targets: all.slice(0, keep), tree: `${bounded.tree}\n\n${dropped} more targets not shown; scroll or narrow the page.` };
  }
  if (size(bounded) <= limit) return bounded;

  // Truncate the tree from the end until the whole object fits.
  let length = bounded.tree.length;
  while (length > 0 && size({ ...bounded, tree: bounded.tree.slice(0, length) }) > limit) length = Math.floor(length * 0.8);
  bounded = { ...bounded, tree: bounded.tree.slice(0, length) };
  if (size(bounded) <= limit) return bounded;

  return {
    id: observation.id, url: cut(observation.url, 2048), title: cut(observation.title, 300),
    tree: 'This page is too large to show. Navigate somewhere more specific, or scroll and observe again.',
    targets: [], tabs: [], capturedAt: observation.capturedAt,
  };
}
