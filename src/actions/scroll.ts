import { INERT, type ActionSpec } from './spec.js';

/** Scroll the page up or down. */
export const scroll: ActionSpec = {
  name: 'scroll',
  acting: true,
  facts: INERT,
  fields: { required: ['direction'] },
  step: (call, { verb }) => `${verb('Scrolled', 'Scroll')} ${String(call.direction ?? '')}`,
};
