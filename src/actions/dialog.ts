import { INERT, type ActionSpec } from './spec.js';

/**
 * Answer an alert, confirm or prompt the page has opened. While one is open
 * the page waits for it and takes no other input, so the observation says so
 * and every other action on that page is refused until it is answered.
 */
export const dialog: ActionSpec = {
  name: 'dialog',
  acting: true,
  facts: INERT,
  fields: { required: ['response'], optional: ['value'] },
  guide: 'dialog answers an alert, confirm or prompt the page has opened (the observation says so; nothing else works on that page until it is answered): response "accept" (OK) or "dismiss" (Cancel), with value as the text for a prompt.',
  step: (call, { verb }) => call.response === 'dismiss' ? verb('Dismissed the page\'s dialog', 'Dismiss the page\'s dialog')
    : call.value !== undefined ? `${verb('Answered the page\'s dialog', 'Answer the page\'s dialog')} with "${String(call.value)}"`
    : verb('Accepted the page\'s dialog', 'Accept the page\'s dialog'),
};
