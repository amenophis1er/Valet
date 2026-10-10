import { targetOrPoint } from './aim.js';
import type { ActionSpec } from './spec.js';

/** A click on an element or a point: once, twice (count: 2), or with the right button (a context menu). */
export const click: ActionSpec = {
  name: 'click',
  acting: true,
  fields: { optional: ['target', 'point', 'screenshot', 'count', 'button'] },
  rules(call, issue) {
    if (call.count === 2 && call.button === 'right') issue(['count'], 'A double-click is with the left button');
    targetOrPoint(call, issue);
  },
  facts: {
    followsLink: true,
    // A right click opens a menu; it never activates a button or submits a form.
    submits: (call) => (call.button === 'right' ? undefined : 'click'),
  },
  step(call, { verb, where }) {
    const how = call.button === 'right' ? verb('Right-clicked', 'Right-click') : call.count === 2 ? verb('Double-clicked', 'Double-click') : verb('Clicked', 'Click');
    return `${how} ${where}`;
  },
};
