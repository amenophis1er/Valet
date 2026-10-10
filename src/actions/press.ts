import type { ActionSpec } from './spec.js';

/** One key on an element: Enter, Tab, Escape, Space, Backspace or an arrow. */
export const press: ActionSpec = {
  name: 'press',
  acting: true,
  fields: { required: ['key', 'target'] },
  facts: { goesTo: null, followsLink: false, submits: (call) => (call.key === 'Enter' ? 'enter' : call.key === 'Space' ? 'space' : undefined) },
  guide: 'press sends a listed key to a target.',
  step: (call, { verb, what }) => `${verb('Pressed', 'Press')} ${String(call.key ?? '')} on ${what}`,
};
