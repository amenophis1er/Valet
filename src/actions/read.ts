import { INERT, type ActionSpec } from './spec.js';

/** The page's text — its article, headings, lists and tables — in parts, without the menus or refs. */
export const read: ActionSpec = {
  name: 'read',
  acting: false,
  facts: INERT,
  fields: { optional: ['part'] },
  guide: 'read gives you the text of the current page — its main content, headings, lists and tables, without menus or refs — in parts of a few thousand words. '
    + 'Use it whenever the content is the task (summarize, answer from, quote or extract a page): an observation is cut to fit and is for acting, not reading. '
    + 'A result says which part it is and how many there are; read the next part until you have what the task needs before you answer. '
    + 'On a very long page the oldest parts drop out of view: note the key facts in a line as you go, and do not read a part twice.',
  step: (call, { verb }) => {
    const part = typeof call.part === 'number' && call.part > 1 ? ` (part ${call.part})` : '';
    return verb(`Read the text${part}`, `Read the text${part}`);
  },
};
