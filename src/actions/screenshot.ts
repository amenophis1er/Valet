import { INERT, type ActionSpec } from './spec.js';

/** An image of the visible part of the tab, frames from other sites painted over. */
export const screenshot: ActionSpec = {
  name: 'screenshot',
  acting: false,
  facts: INERT,
  fields: {},
  guide: 'screenshot shows you the visible part of the current tab as an image, and shows it to the owner too; use it when layout, images or charts matter, not instead of observe. Parts of the page from sites outside this run are painted grey.',
  step: (_call, { verb }) => verb('Took a screenshot', 'Take a screenshot'),
};
