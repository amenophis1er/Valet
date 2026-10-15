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
  cancel.dispatch();
  await driver.answerDialog(tabId, accept, text);
  return {};
};
