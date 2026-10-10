import { INERT, type ActionSpec } from './spec.js';

/** An image of the visible part of the tab, frames from other sites painted over. */
export const screenshot: ActionSpec = {
  name: 'screenshot',
  acting: false,
  facts: INERT,
  fields: {},
  step: (_call, { verb }) => verb('Took a screenshot', 'Take a screenshot'),
};
