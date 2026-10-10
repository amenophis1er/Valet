import { INERT, type ActionSpec } from './spec.js';

/** Replace a text field's value (never a password field: the owner types those). */
export const fill: ActionSpec = {
  name: 'fill',
  acting: true,
  facts: INERT,
  fields: { required: ['target', 'value'] },
  guide: 'fill replaces the value of a non-password text field.',
  step: (_call, { verb, what }) => `${verb('Typed into', 'Type into')} ${what}`,
};
