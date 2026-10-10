import { PreconditionError } from '../protocol.js';
import { hoverRef } from '../page.js';
import type { InputAction } from '../driver.js';
import { OTHER_SITE_FRAME, glide } from './motion.js';

/** The mouse onto a target or a point, no button: what opens or shows on hover does. */
export const hover: InputAction = async (driver, command, cancel) => {
  const { ref, tab } = await driver.aim(command, cancel);
  const at = command.args['point'] as { x: number; y: number } | undefined;
  const point = at ?? await driver.viewportPoint(ref, (await driver.locate(ref, { still: !!at })).point);
  if (!point) throw new PreconditionError(OTHER_SITE_FRAME);
  await driver.pointAt(command.session, ref.tabId, point);
  cancel.check();
  cancel.dispatch();
  await driver.driven(() => driver.withDebugger(ref.tabId, async (send) => {
    await glide(driver, send, ref.tabId, point, 0);
    await send('Input.dispatchMouseEvent', { x: point.x, y: point.y, type: 'mouseMoved', button: 'none', buttons: 0 });
    driver.mouse.set(ref.tabId, point);
  }), () => driver.script(ref, hoverRef, [ref.local]));
  await driver.settle(ref.tabId, tab);
  return {};
};
