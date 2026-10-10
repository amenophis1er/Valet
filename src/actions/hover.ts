import { targetOrPoint } from './aim.js';
import { INERT, type ActionSpec } from './spec.js';

/** The mouse onto an element or a point, no button: what opens or shows on hover does. */
export const hover: ActionSpec = {
  name: 'hover',
  acting: true,
  facts: INERT,
  fields: { optional: ['target', 'point', 'screenshot'] },
  rules: targetOrPoint,
  step: (_call, { verb, where }) => `${verb('Pointed at', 'Point at')} ${where}`,
};
