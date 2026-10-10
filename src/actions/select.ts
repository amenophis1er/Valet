import type { ActionSpec } from './spec.js';

/** Pick an option of a select by its label, text or value. */
export const select: ActionSpec = {
  name: 'select',
  acting: true,
  fields: { required: ['target', 'value'] },
  step: (call, { verb, what }) => `${verb('Chose', 'Choose')} "${String(call.value ?? '')}" in ${what}`,
};
