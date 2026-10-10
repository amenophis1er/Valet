import { PreconditionError } from '../protocol.js';
import { DEBUGGER_KEPT_OUT, type InputAction } from '../driver.js';
import { OTHER_SITE_FRAME, glide } from './motion.js';

/**
 * Press on a target or a point, move to `to` (a target or a point) and
 * release there. The move is always in steps: a page notices a drag by the
 * motion, not by the two ends. Once pressed, always released.
 */
export const drag: InputAction = async (driver, command, cancel) => {
  const { ref, tab } = await driver.aim(command, cancel);
  const fromAt = command.args['point'] as { x: number; y: number } | undefined;
  const end = command.args['to'] as { target?: unknown; point?: { x: number; y: number } } | undefined;
  if (!end || (!end.target && !end.point)) throw new PreconditionError('drag needs to: where it ends.');
  // The end first, so scrolling it into view cannot move the start after it was read.
  let to = end.point;
  if (!to) {
    const endRef = await driver.refFor(command.session, end.target);
    to = await driver.viewportPoint(endRef, (await driver.locate(endRef, { still: !!fromAt })).point);
  }
  const from = fromAt ?? await driver.viewportPoint(ref, (await driver.locate(ref, { mark: true, still: true })).point);
  if (!from || !to) throw new PreconditionError(OTHER_SITE_FRAME);
  await driver.pointAt(command.session, ref.tabId, from);
  cancel.check();
  // A drag has no page-side stand-in: kept out of the debugger before the press, it is refused with nothing dispatched.
  await driver.driven(() => driver.withDebugger(ref.tabId, async (send) => {
    cancel.dispatch();
    await glide(driver, send, ref.tabId, from, 0);
    await send('Input.dispatchMouseEvent', { x: from.x, y: from.y, type: 'mouseMoved', button: 'none', buttons: 0 });
    driver.mouse.set(ref.tabId, from);
    cancel.check();
    await send('Input.dispatchMouseEvent', { x: from.x, y: from.y, type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1 });
    try {
      if (driver.pace === 'natural') await driver.wait(80 + Math.round(120 * driver.random()));
      await glide(driver, send, ref.tabId, to, 1);
      await send('Input.dispatchMouseEvent', { x: to.x, y: to.y, type: 'mouseMoved', button: 'left', buttons: 1 });
      driver.mouse.set(ref.tabId, to);
      await driver.pointAt(command.session, ref.tabId, to);
      if (driver.pace === 'natural') await driver.wait(60 + Math.round(80 * driver.random()));
    } finally {
      await send('Input.dispatchMouseEvent', { x: to.x, y: to.y, type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1 });
    }
  }), () => { throw new PreconditionError(`${DEBUGGER_KEPT_OUT} A drag needs it; nothing was dispatched. Try a click, or ask the owner.`); });
  await driver.settle(ref.tabId, tab);
  return {};
};
