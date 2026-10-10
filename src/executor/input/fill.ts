import { PreconditionError } from '../protocol.js';
import { typeRef } from '../page.js';
import { arg, type InputAction } from '../driver.js';
import { typeKey } from './motion.js';

/** At natural pace, typed key by key up to this many characters; the rest is inserted at once. */
const MAX_KEYED = 400;

/** Replace a text field's value: inserted at once, or typed key by key where the page reacts to each key. */
export const fill: InputAction = async (driver, command, cancel) => {
  const { ref } = await driver.aim(command, cancel);
  const value = arg(command, 'value') ?? '';
  // A line break typed into a one-line field is an Enter, which can submit the form without the
  // approval a press gets: refused before anything is touched. (A textarea takes line breaks.)
  if (/[\r\n]/.test(value)) {
    const { multiline } = await driver.locate(ref, { still: true });
    if (!multiline) throw new PreconditionError('That field takes one line; a line break in the value would press Enter. Fill it without the line break, then use press with key Enter if you mean to submit.');
  }
  // Focusing and clearing the field is already a change to the page.
  cancel.dispatch();
  const { setByValue, keyByKey, point } = await driver.locate(ref, { focus: true, clear: true });
  if (ref.frameId === 0) await driver.pointAt(command.session, ref.tabId, point);
  cancel.check();
  // Subframes, and pickers (time, date, color…) that ignore inserted text, get the value set directly.
  if (ref.frameId !== 0 || setByValue) {
    await driver.script(ref, typeRef, [ref.local, value]);
    return {};
  }
  const byPage = () => driver.script(ref, typeRef, [ref.local, value]);
  // Natural pace, or a field that reacts to each key (suggestions, search-as-you-type): key by key.
  if (driver.pace === 'natural' || keyByKey) {
    const natural = driver.pace === 'natural';
    const characters = [...value];
    const keyed = natural ? characters.slice(0, MAX_KEYED) : characters;
    await driver.driven(() => driver.withDebugger(ref.tabId, async (send) => {
      for (const character of keyed) {
        await typeKey(send, character);
        await driver.wait(natural ? 40 + Math.round(100 * driver.random()) : 12 + Math.round(20 * driver.random()));
        // A Stop mid-word leaves the field half typed: dispatch had begun, so the outcome is unknown.
        cancel.check();
      }
      if (keyed.length < characters.length) await send('Input.insertText', { text: characters.slice(keyed.length).join('') });
    }), byPage, true);
    return {};
  }
  await driver.driven(() => driver.withDebugger(ref.tabId, (send) => send('Input.insertText', { text: value })), byPage, true);
  return {};
};
