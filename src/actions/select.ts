import { INERT, type ActionSpec } from './spec.js';

/** Pick an option of a select by its label, text or value. */
export const select: ActionSpec = {
  name: 'select',
  acting: true,
  facts: INERT,
  fields: { required: ['target', 'value'] },
  guide: 'select picks an option by its label, text or value.',
  step: (call, { verb, what }) => `${verb('Chose', 'Choose')} "${String(call.value ?? '')}" in ${what}`,
};
