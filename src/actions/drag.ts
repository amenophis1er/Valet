import { targetOrPoint } from './aim.js';
import type { ActionSpec } from './spec.js';

type End = { target?: { ref?: string; name?: string; role?: string }; point?: { x?: number; y?: number } } | undefined;

/** Press on an element or a point, move, and release on `to`: an element or a point. */
export const drag: ActionSpec = {
  name: 'drag',
  acting: true,
  fields: { optional: ['target', 'point', 'screenshot', 'to'] },
  rules(call, issue) {
    targetOrPoint(call, issue);
    const to = call.to as End;
    if (!to || (!to.target && !to.point)) issue(['to'], 'drag needs to: where it ends, a target or a point');
    else if (to.target && to.point) issue(['to', 'point'], 'Use a target or a point for to, not both');
  },
  step(call, { verb, where, name }) {
    const to = call.to as End;
    const end = to?.point ? `the point (${to.point.x}, ${to.point.y})` : name(to?.target, 'there');
    return `${verb('Dragged', 'Drag')} ${where} to ${end}`;
  },
};
