/*
 * The browser tool, built from its actions.
 *
 * Each action is one spec (spec.ts) in its own file; the fields they share are
 * in fields.ts. From those this module builds everything else: the validator
 * every call passes before anything happens, the JSON Schema and description
 * the model is given, the set of actions that act on the page, and the
 * wording of a step in the owner's transcript. golden.test.ts keeps all four
 * as checked-in files, so a change to any of them is a visible diff.
 */

import { z } from 'zod';
import { FIELDS, FIELD_NAMES, KEYS, type FieldName } from './fields.js';
import { GUIDE, UNTRUSTED } from './guide.js';
import { ACTION_NAMES, type ActionName, type ActionSpec, type Call, type Issue, type Words } from './spec.js';
import { navigate } from './navigate.js';
import { observe } from './observe.js';
import { screenshot } from './screenshot.js';
import { click } from './click.js';
import { hover } from './hover.js';
import { drag } from './drag.js';
import { fill } from './fill.js';
import { select } from './select.js';
import { press } from './press.js';
import { scroll } from './scroll.js';
import { tab } from './tab.js';
import { close } from './close.js';

/** Every action's spec, by name: the type makes a missing or extra one a compile error. */
export const SPECS: { readonly [N in ActionName]: ActionSpec & { name: N } } = {
  navigate, observe, screenshot, click, hover, drag, fill, select, press, scroll, tab, close,
} as never;

export const ACTIONS = ACTION_NAMES;
/** The actions that act on the page: they need the latest observation, and are followed by a new one. */
export const ACTING = ACTION_NAMES.filter((name) => SPECS[name].acting);
export { KEYS, UNTRUSTED };
export type { ActionName, ActionSpec, SubmitVia } from './spec.js';

export function specOf(name: ActionName): ActionSpec {
  return SPECS[name];
}

/* ---- the validator ---- */

const takes = (spec: ActionSpec, field: FieldName) => !!spec.fields.required?.includes(field) || !!spec.fields.optional?.includes(field);

/** "click", "click and drag", "click, hover and drag". */
const listOf = (names: readonly string[]) => names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

/** Exclusive fields: which actions take each, for "Only … take(s) …". */
const OWNERS = Object.fromEntries(FIELD_NAMES.map((field) => [field, ACTION_NAMES.filter((name) => takes(SPECS[name], field))])) as Record<FieldName, ActionName[]>;

type Shape = { [K in FieldName]: (typeof FIELDS)[K]['zod'] };
const shape = Object.fromEntries(FIELD_NAMES.map((field) => [field, FIELDS[field].zod])) as Shape;

/**
 * The rules, in a fixed order so a refusal names the same first problem every
 * time: the action's required fields, its own rules, fields it does not take,
 * then what every aiming or acting call needs.
 */
function check(call: Call, issue: Issue): void {
  const spec = SPECS[call.action];
  for (const field of spec.fields.required ?? []) if (call[field] === undefined) issue([field], `Required for ${call.action}`);
  spec.rules?.(call, issue);
  for (const field of FIELD_NAMES) {
    const def = FIELDS[field] as { exclusive?: boolean; noun?: string };
    if (!def.exclusive || call[field] === undefined || takes(spec, field)) continue;
    const owners = OWNERS[field];
    issue([field], `Only ${listOf(owners)} ${owners.length === 1 ? 'takes' : 'take'} ${def.noun ?? field}`);
  }
  const to = call.to as { point?: unknown } | undefined;
  if ((call.point || to?.point) && call.screenshot === undefined) issue(['screenshot'], `Required for ${call.action}`);
  if (spec.acting && call.observation === undefined) issue(['observation'], `Required for ${call.action}`);
  const target = call.target as { ref?: string; name?: string; by?: string; role?: string } | undefined;
  if (target && !target.ref) {
    if (!target.name) issue(['target', 'name'], 'Use target.ref from observation.targets, or provide an exact name');
    if (target.by === 'role' && !target.role) issue(['target', 'role'], 'Use target.ref, or by:"role" with role:"link" / "button" etc.');
  }
}

/** Every call passes this before anything happens. */
export const commandSchema = z.object({ action: z.enum(ACTION_NAMES), ...shape }).strict().superRefine((input, ctx) => {
  check(input as unknown as Call, (path, message) => ctx.addIssue({ code: 'custom', path, message }));
});

export type BrowserCommand = z.infer<typeof commandSchema>;

/* ---- what the model is given ---- */

/** The JSON Schema the model sees: types, enums and limits; the cross-field rules live in the validator. */
export const WIRE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: { type: 'string', enum: [...ACTION_NAMES] },
    ...(Object.fromEntries(FIELD_NAMES.map((field) => [field, FIELDS[field].wire])) as { [K in FieldName]: (typeof FIELDS)[K]['wire'] }),
  },
} as const;

export const TOOL_DESCRIPTION = GUIDE.join(' ');

export const BROWSER_TOOL = { name: 'browser', description: TOOL_DESCRIPTION, inputSchema: WIRE_SCHEMA } as const;

/* ---- what the owner reads ---- */

type Named = { ref?: string; name?: string; role?: string } | undefined;

/**
 * A step in the owner's words, capitalized: past tense once it happened
 * ("Clicked link "Lomé""), the plain verb when it did not ("Click link "Lomé"",
 * shown with its outcome). Elements are named as the observation the model
 * saw named them, never by ref when a name is known.
 */
export function describeStep(args: Record<string, unknown> | undefined, targets: ReadonlyArray<{ ref: string; role: string; name: string }>, done: boolean): string {
  if (!args || !(ACTION_NAMES as readonly unknown[]).includes(args['action'])) return 'Invalid command';
  const call = args as Call;
  const nameOf = (target: Named, fallback: string, spaced: boolean) => {
    const known = target?.ref ? targets.find((candidate) => candidate.ref === target.ref) : undefined;
    const name = known?.name.trim() || target?.name;
    const role = known?.role ?? target?.role;
    if (!name) return target?.ref ?? fallback;
    return spaced ? `${role ? `${role} ` : ''}"${name}"` : `${role ?? ''} "${name}"`.trim();
  };
  const what = nameOf(call.target as Named, 'the page', true);
  const point = call.point as { x?: number; y?: number } | undefined;
  const words: Words = {
    done,
    verb: (past, plain) => (done ? past : plain),
    what,
    where: point ? `the point (${point.x}, ${point.y}) on the screenshot` : what,
    name: (target, fallback) => nameOf(target, fallback, false),
  };
  return SPECS[call.action].step(call, words);
}
