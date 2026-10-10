/*
 * The executor's input actions: every action that acts on the page through an
 * element or the viewport (the registry's acting actions), one file each.
 * A test holds this list and the registry's ACTING to the same names.
 */

import type { InputAction } from '../driver.js';
import { click } from './click.js';
import { drag } from './drag.js';
import { fill } from './fill.js';
import { hover } from './hover.js';
import { press } from './press.js';
import { scroll } from './scroll.js';
import { select } from './select.js';

export const INPUT = { click, hover, drag, fill, select, press, scroll } satisfies Record<string, InputAction>;
export type InputName = keyof typeof INPUT;
