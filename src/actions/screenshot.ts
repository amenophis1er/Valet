import type { ActionSpec } from './spec.js';

/** An image of the visible part of the tab, frames from other sites painted over. */
export const screenshot: ActionSpec = {
  name: 'screenshot',
  acting: false,
  fields: {},
  step: (_call, { verb }) => verb('Took a screenshot', 'Take a screenshot'),
};
