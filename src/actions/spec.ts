/*
 * What an action is, declared once.
 *
 * Every action of the browser tool is one `ActionSpec`: the fields it takes,
 * the rules those fields must follow, the facts the run controller enforces
 * about it, what the model is told about it, and how a step of it reads in
 * the owner's transcript. The validator, the JSON Schema the model sees, the
 * tool description and the step wording are all built from these specs
 * (index.ts), so they cannot drift apart.
 *
 * A spec describes; it never decides. Whether a step may run — a fresh
 * observation, the owner's approval for a site or a form — is the
 * controller's to enforce, from the facts declared here. A new action cannot
 * opt out of a check by leaving something out.
 */

import type { FieldName } from './fields.js';

/** Every action of the browser tool, in the order the model sees them. */
export const ACTION_NAMES = ['navigate', 'observe', 'read', 'screenshot', 'click', 'hover', 'drag', 'fill', 'select', 'press', 'scroll', 'dialog', 'tab', 'close'] as const;
export type ActionName = (typeof ACTION_NAMES)[number];

/** A call as the validator sees it before it is accepted: plain fields. */
export type Call = Partial<Record<FieldName, unknown>> & { action: ActionName };

/** Report a rule broken: where, and what to do instead. */
export type Issue = (path: string[], message: string) => void;

/** The submission a step may make, for the form check: by a click, or by Enter or Space on a field. */
export type SubmitVia = 'click' | 'enter' | 'space';

export interface ActionSpec {
  name: ActionName;
  /**
   * Acts on the page. The controller then requires the latest observation id,
   * invalidates it before dispatch, and observes again after.
   */
  acting: boolean;
  /** The fields this action takes. `required` ones are checked in the order given. */
  fields: { required?: readonly FieldName[]; optional?: readonly FieldName[] };
  /** Rules beyond which fields are present, checked after the required ones. */
  rules?(call: Call, issue: Issue): void;
  /**
   * Facts the controller enforces. Every spec states every fact, even when the
   * answer is "no": a fact left out is a compile error, never a skipped check.
   */
  facts: Facts;
  /** What the model is told about this action, in the tool description: when to use it and how. */
  guide: string;
  /** The step in the owner's words: past tense once done ("Clicked …"), the plain verb when not. */
  step(call: Call, words: Words): string;
}

export interface Facts {
  /** The URL this call goes to, scope-checked before dispatch; null when it goes nowhere by itself. */
  goesTo: ((call: Call) => string | undefined) | null;
  /** A step on a link goes where the link points: that origin is scope-checked before dispatch. */
  followsLink: boolean;
  /** How this call could submit a form, if it could; the owner approves a submission before it is sent. */
  submits: ((call: Call) => SubmitVia | undefined) | null;
}

/** Facts for an action that goes nowhere, follows no link and submits nothing. */
export const INERT: Facts = { goesTo: null, followsLink: false, submits: null };

/** What a step's wording can use: the names of what it acts on, from the observation the model saw. */
export interface Words {
  done: boolean;
  /** "Opened" once done, "Open" when not. */
  verb(past: string, plain: string): string;
  /** The target: role and name when the observation knows it ('button "Search"'), else its ref, else "the page". */
  what: string;
  /** The target, or the point on the screenshot when the step aims by point. */
  where: string;
  /** A target named the same way as `what`, for a second element (a drag's end). */
  name(target: { ref?: string; name?: string; role?: string } | undefined, fallback: string): string;
}
