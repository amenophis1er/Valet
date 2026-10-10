import type { ActionSpec } from './spec.js';

/** Close the conversation's own tabs; a tab the owner handed over is given back, never closed. */
export const close: ActionSpec = {
  name: 'close',
  acting: false,
  fields: {},
  step: (_call, { verb }) => verb('Closed its tabs', 'Close its tabs'),
};
