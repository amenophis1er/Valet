import { clickRef } from '../page.js';
import { path } from './motion.js';
import type { InputAction } from '../driver.js';

/** A click — once, twice (count: 2) or with the right button — through the debugger, so the page gets trusted events. */
export const click: InputAction = async (driver, command, cancel) => {
  const { ref, tab } = await driver.aim(command, cancel);
  // A click by point goes exactly where the screenshot showed it, so the page is not scrolled first.
  const at = command.args['point'] as { x: number; y: number } | undefined;
  const located = await driver.locate(ref, { mark: true, still: !!at });
  const point = at ?? await driver.viewportPoint(ref, located.point);
  await driver.pointAt(command.session, ref.tabId, point);
  cancel.check();
  cancel.dispatch();
  const count = command.args['count'] === 2 ? 2 : 1;
  const button = command.args['button'] === 'right' ? 'right' : 'left';
  // A frame from another site has no place in the viewport the worker can read: the element clicks itself.
  if (!point) {
    await driver.script(ref, clickRef, [ref.local, count, button]);
    return {};
  }
  await driver.driven(() => driver.withDebugger(ref.tabId, async (send) => {
    const base = { x: point.x, y: point.y, button, clickCount: 1, buttons: button === 'right' ? 2 : 1 };
    if (driver.pace === 'natural') {
      // Along a gentle curve from where the mouse was, then a moment's hover.
      for (const step of path(driver, ref.tabId, point)) {
        await send('Input.dispatchMouseEvent', { x: step.x, y: step.y, type: 'mouseMoved', button: 'none', buttons: 0 });
        await driver.wait(12 + Math.round(14 * driver.random()));
      }
      await driver.wait(80 + Math.round(120 * driver.random()));
    }
    await send('Input.dispatchMouseEvent', { ...base, type: 'mouseMoved', buttons: 0 });
    driver.mouse.set(ref.tabId, point);
    // A Stop between the hover and the press stops the click.
    cancel.check();
    // A double-click is two presses, the second counted as such, so the page sees dblclick.
    for (let n = 1; n <= count; n += 1) {
      await send('Input.dispatchMouseEvent', { ...base, clickCount: n, type: 'mousePressed' });
      if (driver.pace === 'natural') await driver.wait(50 + Math.round(60 * driver.random()));
      // Once pressed, always released: a Stop must never leave the button held.
      await send('Input.dispatchMouseEvent', { ...base, clickCount: n, type: 'mouseReleased', buttons: 0 });
      if (n < count) await driver.wait(60);
    }
  }), () => driver.script(ref, clickRef, [ref.local, count, button]));
  await driver.settle(ref.tabId, tab);
  return {};
};
