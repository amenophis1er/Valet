import { scrollPage, scrollStep } from '../page.js';
import { arg, type InputAction } from '../driver.js';

/**
 * Scroll names no element, so what it checks instead is the observation: the
 * page the model is reading has to be the page still in the tab.
 */
export const scroll: InputAction = async (driver, command, cancel) => {
  const tabId = await driver.observedTab(command.session);
  const direction = arg(command, 'direction') === 'up' ? 'up' : 'down';
  cancel.check();
  await driver.ready(tabId);
  cancel.check();
  cancel.dispatch();
  if (driver.pace === 'natural') {
    // The same distance in a few smooth steps.
    for (let step = 0; step < 4; step += 1) {
      await driver.inTab(tabId, scrollStep, [direction === 'up' ? -150 : 150]);
      await driver.wait(60 + Math.round(60 * driver.random()));
    }
    return {};
  }
  await driver.inTab(tabId, scrollPage, [direction]);
  return {};
};
