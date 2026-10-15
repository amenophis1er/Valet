import { PreconditionError } from '../protocol.js';
import { arg, type InputAction } from '../driver.js';

/**
 * Answer the dialog the page has open. It names no element, so what it
 * checks, like scroll, is the observation: the one that reported the dialog,
 * on the tab that still shows that page.
 */
export const dialog: InputAction = async (driver, command, cancel) => {
  const tabId = await driver.observedTab(command.session);
  const accept = command.args['response'] !== 'dismiss';
  const text = accept ? arg(command, 'value') : undefined;
  cancel.check();
  // None known open: a plain refusal, nothing sent, so a model that guessed one was there just reads the page again.
  if (!driver.dialog(tabId)) throw new PreconditionError('No dialog is open on this page.');
  cancel.dispatch();
  await driver.answerDialog(tabId, accept, text);
  return {};
};
