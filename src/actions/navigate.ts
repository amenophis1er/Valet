import type { ActionSpec } from './spec.js';

/** Go to a URL in the tab the conversation works in, or in a new tab of its own. */
export const navigate: ActionSpec = {
  name: 'navigate',
  acting: false,
  fields: { required: ['url'], optional: ['newTab'] },
  // The page it opens is a site like any other: scope-checked before the tab moves.
  facts: { goesTo: (call) => (typeof call.url === 'string' ? call.url : undefined) },
  step: (call, { verb }) => `${verb('Opened', 'Open')} ${String(call.url ?? '')}${call.newTab === true ? ' in a new tab' : ''}`,
};
