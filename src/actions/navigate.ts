import type { ActionSpec } from './spec.js';

/** Go to a URL in the tab the conversation works in, or in a new tab of its own. */
export const navigate: ActionSpec = {
  name: 'navigate',
  acting: false,
  fields: { required: ['url'], optional: ['newTab'] },
  // The page it opens is a site like any other: scope-checked before the tab moves.
  facts: { goesTo: (call) => (typeof call.url === 'string' ? call.url : undefined), followsLink: false, submits: null },
  guide: 'Start with {action:"navigate",url:"https://..."}: it goes there in the tab you are working in. With newTab:true it opens the url in a new tab of this conversation instead and works there from then on; use it to keep the page you are on, or when the owner asks for another tab. Every result carries a fresh observation: id, url, title, an aria-style tree, targets with refs like e12, and the tabs of this conversation.',
  step: (call, { verb }) => `${verb('Opened', 'Open')} ${String(call.url ?? '')}${call.newTab === true ? ' in a new tab' : ''}`,
};
