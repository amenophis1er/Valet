import { PreconditionError } from '../protocol.js';
import { pressRef } from '../page.js';
import { arg, type InputAction } from '../driver.js';

/** The keys press knows, as the debugger names them. */
const KEYS: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9, text: '\t' },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
};

/** One key on a focused element. */
export const press: InputAction = async (driver, command, cancel) => {
  const key = arg(command, 'key') ?? '';
  const descriptor = KEYS[key];
  if (!descriptor) throw new PreconditionError(`This browser cannot press ${key}.`);
  const { ref, tab } = await driver.aim(command, cancel);
  cancel.dispatch();
  const { point } = await driver.locate(ref, { focus: true });
  if (ref.frameId === 0) await driver.pointAt(command.session, ref.tabId, point);
  cancel.check();
  if (ref.frameId !== 0) {
    await driver.script(ref, pressRef, [ref.local, descriptor.key, descriptor.code, descriptor.keyCode]);
    return {};
  }
  await driver.driven(() => driver.withDebugger(ref.tabId, async (send) => {
    const common = { key: descriptor.key, code: descriptor.code, windowsVirtualKeyCode: descriptor.keyCode, nativeVirtualKeyCode: descriptor.keyCode };
    await send('Input.dispatchKeyEvent', { ...common, type: descriptor.text ? 'keyDown' : 'rawKeyDown', ...(descriptor.text ? { text: descriptor.text } : {}) });
    await send('Input.dispatchKeyEvent', { ...common, type: 'keyUp' });
  }), () => driver.script(ref, pressRef, [ref.local, descriptor.key, descriptor.code, descriptor.keyCode]));
  await driver.settle(ref.tabId, tab);
  return {};
};
