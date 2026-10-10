import type { ActionSpec } from './spec.js';

/** Work in another of the conversation's tabs. */
export const tab: ActionSpec = {
  name: 'tab',
  acting: false,
  fields: { required: ['tabId'] },
  step: (_call, { verb }) => verb('Switched tab', 'Switch tab'),
};
