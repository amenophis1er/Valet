import { INERT, type ActionSpec } from './spec.js';

/** Work in another of the conversation's tabs. */
export const tab: ActionSpec = {
  name: 'tab',
  acting: false,
  facts: INERT,
  fields: { required: ['tabId'] },
  guide: 'tab switches to a tabId from observation.tabs. A link that opens a new tab opens one of yours: observe then reads it.',
  step: (_call, { verb }) => verb('Switched tab', 'Switch tab'),
};
