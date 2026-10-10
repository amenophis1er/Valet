import { INERT, type ActionSpec } from './spec.js';

/** Read the page: the accessibility tree, with a ref for every element the model may act on. */
export const observe: ActionSpec = {
  name: 'observe',
  acting: false,
  facts: INERT,
  fields: {},
  step: (_call, { verb }) => verb('Read the page', 'Read the page'),
};
