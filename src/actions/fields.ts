/*
 * The fields a browser call can carry, each with its validator and the JSON
 * Schema the model sees. Which actions take which field is declared by the
 * actions (spec.ts); a field here only knows its own shape and meaning.
 */

import { z } from 'zod';

export const ROLES = ['button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'option', 'tab', 'menuitem', 'switch', 'searchbox', 'spinbutton'] as const;
export const BY = ['role', 'label', 'placeholder', 'text', 'link'] as const;
export const KEYS = ['Enter', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Space', 'Backspace'] as const;

/** An element: a ref from the latest observation (preferred), or a role and an exact name. */
const target = z.object({
  ref: z.string().min(1).max(40).optional(),
  role: z.enum(ROLES).optional(),
  name: z.string().min(1).max(300).optional(),
  by: z.enum(BY).default('role'),
  frame: z.number().int().min(0).max(10).default(0),
}).strict().superRefine((value, ctx) => {
  if (value.by === 'link' && value.role && value.role !== 'link') ctx.addIssue({ code: 'custom', path: ['role'], message: 'by:"link" cannot target a different role' });
}).transform((value) => value.by === 'link' ? { ...value, by: 'role' as const, role: 'link' as const } : value);

/** A point on the latest screenshot, in its pixels. */
const point = z.object({ x: z.number().int().min(0).max(10_000), y: z.number().int().min(0).max(10_000) }).strict();

const wireTarget = { type: 'object', additionalProperties: false, properties: { ref: { type: 'string', minLength: 1, maxLength: 40 }, role: { type: 'string', enum: [...ROLES] }, name: { type: 'string', minLength: 1, maxLength: 300 }, by: { type: 'string', enum: [...BY], default: 'role' }, frame: { type: 'integer', minimum: 0, maximum: 10, default: 0 } } } as const;
const wirePoint = { type: 'object', additionalProperties: false, required: ['x', 'y'], properties: { x: { type: 'integer', minimum: 0, maximum: 10_000 }, y: { type: 'integer', minimum: 0, maximum: 10_000 } } } as const;

/**
 * Which actions use a field, for a description that names them from the
 * registry instead of by hand: `requiring` must send it, `taking` may,
 * `acting` are the actions that act on the page.
 */
export interface Usage { requiring: string[]; taking: string[]; acting: string[]; list(names: readonly string[]): string }

/**
 * Every field, in the order the model sees them. `exclusive`: the validator
 * refuses the field on an action that does not take it (others are ignored
 * when sent where they mean nothing). `noun`: how a refusal names it.
 */
export const FIELDS = {
  url: {
    zod: z.string().max(2048).optional(),
    wire: { type: 'string', maxLength: 2048, description: 'Required for navigate. http or https only.' },
  },
  newTab: {
    exclusive: true,
    zod: z.boolean().optional(),
    wire: { type: 'boolean', description: 'navigate only: open the url in a new tab of this conversation and work there, leaving the current tab as it is.' },
  },
  target: {
    describe: (usage: Usage) => `Required for ${usage.list(usage.requiring)}; ${usage.list(usage.taking)} take a target or a point. Prefer a ref copied from the latest observation.targets.`,
    zod: target.optional(),
    wire: {
      type: 'object',
      additionalProperties: false,
      description: '',
      properties: {
        ref: { type: 'string', minLength: 1, maxLength: 40, description: 'Preferred: copy a ref from the latest observation.targets. Identifies one exact element, including repeated links.' },
        role: { type: 'string', enum: [...ROLES] },
        name: { type: 'string', minLength: 1, maxLength: 300, description: 'Exact accessible name, when there is no ref.' },
        by: { type: 'string', enum: [...BY], default: 'role', description: 'Locator method. Prefer ref. For a semantic link use by:"role", role:"link".' },
        frame: { type: 'integer', minimum: 0, maximum: 10, default: 0 },
      },
    },
  },
  point: {
    exclusive: true,
    noun: 'a point',
    zod: point.optional(),
    wire: { type: 'object', additionalProperties: false, required: ['x', 'y'], description: 'click, hover and drag, instead of a target: a point on the latest screenshot, in that image\'s pixels (x from the left, y from the top). For what the observation cannot name — a canvas, a map, a chart, a custom control. Needs screenshot.', properties: wirePoint.properties },
  },
  count: {
    exclusive: true,
    zod: z.number().int().min(1).max(2).optional(),
    wire: { type: 'integer', minimum: 1, maximum: 2, description: 'click only: 2 for a double-click (open a file in a list, select a word). Default 1.' },
  },
  button: {
    exclusive: true,
    zod: z.enum(['left', 'right']).optional(),
    wire: { type: 'string', enum: ['left', 'right'], description: 'click only: "right" opens the context menu (then click an item in it). Default left.' },
  },
  to: {
    exclusive: true,
    zod: z.object({ target: target.optional(), point: point.optional() }).strict().optional(),
    wire: {
      type: 'object',
      additionalProperties: false,
      description: 'Required for drag: where the drag ends — a target (a ref) or a point on the latest screenshot.',
      properties: { target: wireTarget, point: wirePoint },
    },
  },
  screenshot: {
    zod: z.string().max(80).optional(),
    wire: { type: 'string', maxLength: 80, description: 'Required with point: copy screenshot.id from the latest screenshot result. A screenshot taken before any action is stale.' },
  },
  value: {
    zod: z.string().max(10_000).optional(),
    wire: { type: 'string', maxLength: 10_000, description: 'Required for fill (the text) and select (an option label, text or value); dialog takes it as the text to answer a prompt with.' },
  },
  response: {
    exclusive: true,
    zod: z.enum(['accept', 'dismiss']).optional(),
    wire: { type: 'string', enum: ['accept', 'dismiss'], description: 'Required for dialog: "accept" presses OK on the page\'s open alert, confirm or prompt, "dismiss" presses Cancel.' },
  },
  key: {
    zod: z.enum(KEYS).optional(),
    wire: { type: 'string', enum: [...KEYS], description: 'Required for press, with a target.' },
  },
  direction: {
    zod: z.enum(['up', 'down']).optional(),
    wire: { type: 'string', enum: ['up', 'down'], description: 'Required for scroll.' },
  },
  part: {
    exclusive: true,
    zod: z.number().int().min(1).max(500).optional(),
    wire: { type: 'integer', minimum: 1, maximum: 500, description: 'read only: which part of a long page\'s text, from 1. Default 1; a result says how many parts there are.' },
  },
  tabId: {
    zod: z.string().max(40).optional(),
    wire: { type: 'string', maxLength: 40, description: 'Required for tab: an id from observation.tabs.' },
  },
  observation: {
    describe: (usage: Usage) => `REQUIRED for ${usage.list(usage.acting)}. Copy observation.id from the most recent result, including recovery results. Never reuse after a dispatched action.`,
    zod: z.string().max(80).optional(),
    wire: { type: 'string', maxLength: 80, description: '' },
  },
} as const;

export type FieldName = keyof typeof FIELDS;
export const FIELD_NAMES = Object.keys(FIELDS) as FieldName[];
