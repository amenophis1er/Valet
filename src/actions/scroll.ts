import { INERT, type ActionSpec } from './spec.js';

/** Scroll the page up or down. */
export const scroll: ActionSpec = {
  name: 'scroll',
  acting: true,
  facts: INERT,
  fields: { required: ['direction'] },
  guide: 'scroll moves the page up or down.',
  step: (call, { verb }) => `${verb('Scrolled', 'Scroll')} ${String(call.direction ?? '')}`,
};
