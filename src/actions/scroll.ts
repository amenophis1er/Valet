import type { ActionSpec } from './spec.js';

/** Scroll the page up or down. */
export const scroll: ActionSpec = {
  name: 'scroll',
  acting: true,
  fields: { required: ['direction'] },
  step: (call, { verb }) => `${verb('Scrolled', 'Scroll')} ${String(call.direction ?? '')}`,
};
