import { PreconditionError } from '../protocol.js';
import { chooseRef } from '../page.js';
import { arg, type InputAction } from '../driver.js';

/** A native select is the one control where setting the value is the honest action. */
export const select: InputAction = async (driver, command, cancel) => {
  const { ref } = await driver.aim(command, cancel);
  const value = arg(command, 'value') ?? '';
  cancel.dispatch();
  const result = await driver.script<[string, string], { ok: boolean; reason?: string }>(ref, chooseRef, [ref.local, value]);
  if (!result?.ok) throw new PreconditionError(result?.reason ?? 'That option is not in the list.');
  return {};
};
