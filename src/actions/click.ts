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
    goesTo: null,
    followsLink: true,
    // A right click opens a menu; it never activates a button or submits a form.
    submits: (call) => (call.button === 'right' ? undefined : 'click'),
  },
  guide: 'Prefer {action:"click",observation:"COPY_LATEST_ID",target:{ref:"e12"}}; copy actual refs, never invent them. Semantic links use by:"role",role:"link",name:"...". click takes count:2 for a double-click — the way many apps open an item in a list (files in Drive, rows in a table) — and button:"right" for a context menu. A menu item that opens a submenu: hover it, observe, then click the item in the submenu. When a screenshot shows something the observation cannot name (a canvas, a map, a chart, a custom control), click it by point: {action:"click",observation:"COPY_LATEST_ID",screenshot:"COPY_SCREENSHOT_ID",point:{x,y}} in the image\'s pixels. Refs are exact; points are for what has no ref. A grey area cannot be clicked.',
  step(call, { verb, where }) {
    const how = call.button === 'right' ? verb('Right-clicked', 'Right-click') : call.count === 2 ? verb('Double-clicked', 'Double-click') : verb('Clicked', 'Click');
    return `${how} ${where}`;
  },
};
