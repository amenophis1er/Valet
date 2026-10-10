/**
 * Golden files for everything the model and the owner read about actions:
 * the JSON Schema of the browser tool, its description, and how each step is
 * worded in the transcript. A change to any of them shows up as a diff of a
 * checked-in file, so it is always deliberate.
 */
import { describe, expect, it } from 'vitest';
import { TOOL_DESCRIPTION, WIRE_SCHEMA, commandSchema, describeStep } from './index.js';

const TARGETS = [
  { ref: 'e1', role: 'button', name: 'Search' },
  { ref: 'e2', role: 'link', name: 'Blue mug' },
  { ref: 'e3', role: 'textbox', name: 'Email' },
];

/** One call per action and option, as the model would send it. */
const CALLS: Array<Record<string, unknown>> = [
  { action: 'navigate', url: 'https://shop.example/mugs' },
  { action: 'navigate', url: 'https://shop.example/mugs', newTab: true },
  { action: 'observe' },
  { action: 'screenshot' },
  { action: 'click', target: { ref: 'e1' } },
  { action: 'click', target: { ref: 'e2' }, count: 2 },
  { action: 'click', target: { ref: 'e2' }, button: 'right' },
  { action: 'click', point: { x: 120, y: 40 }, screenshot: 's1' },
  { action: 'click', target: { by: 'role', role: 'link', name: 'Docs' } },
  { action: 'hover', target: { ref: 'e2' } },
  { action: 'drag', target: { ref: 'e2' }, to: { point: { x: 300, y: 20 } } },
  { action: 'drag', point: { x: 1, y: 2 }, to: { target: { ref: 'e1' } } },
  { action: 'fill', target: { ref: 'e3' }, value: 'a@b.test' },
  { action: 'select', target: { ref: 'e3' }, value: 'Blue' },
  { action: 'press', target: { ref: 'e3' }, key: 'Enter' },
  { action: 'scroll', direction: 'down' },
  { action: 'tab', tabId: 'tab-2' },
  { action: 'close' },
  { action: 'teleport' },
];

const O = 'obs-1';
/** What the validator accepts and how it words a refusal: valid calls, and every rule broken once. */
const VALIDATION: unknown[] = [
  ...CALLS.map((call) => ({ ...call, ...(['click', 'hover', 'drag', 'fill', 'select', 'press', 'scroll'].includes(String(call['action'])) ? { observation: O } : {}) })),
  { action: 'navigate' }, { action: 'navigate', url: 'x'.repeat(2049) }, { action: 'observe', newTab: true },
  { action: 'click', observation: O }, { action: 'click', target: { ref: 'e1' } }, { action: 'click', observation: O, target: { ref: 'e1' }, point: { x: 1, y: 1 }, screenshot: 's' },
  { action: 'click', observation: O, point: { x: 1, y: 1 } }, { action: 'click', observation: O, target: { ref: 'e1' }, count: 3 },
  { action: 'click', observation: O, target: { ref: 'e1' }, count: 2, button: 'right' }, { action: 'hover', observation: O, target: { ref: 'e1' }, count: 2 },
  { action: 'fill', observation: O, target: { ref: 'e1' }, button: 'right', value: 'x' }, { action: 'fill', observation: O, target: { ref: 'e1' } },
  { action: 'fill', observation: O, value: 'x' }, { action: 'select', observation: O, target: { ref: 'e1' } },
  { action: 'press', observation: O, target: { ref: 'e1' } }, { action: 'press', observation: O, key: 'Enter' }, { action: 'press', observation: O, target: { ref: 'e1' }, key: 'F5' },
  { action: 'scroll', observation: O }, { action: 'scroll', observation: O, direction: 'left' }, { action: 'tab' },
  { action: 'drag', observation: O, target: { ref: 'e1' } }, { action: 'drag', observation: O, target: { ref: 'e1' }, to: {} },
  { action: 'drag', observation: O, target: { ref: 'e1' }, to: { target: { ref: 'e2' }, point: { x: 1, y: 1 } }, screenshot: 's' },
  { action: 'drag', observation: O, target: { ref: 'e1' }, to: { point: { x: 1, y: 1 } } }, { action: 'click', observation: O, target: { ref: 'e1' }, to: { target: { ref: 'e2' } } },
  { action: 'screenshot', point: { x: 1, y: 1 }, screenshot: 's' },
  { action: 'click', observation: O, target: { name: 'Docs' } }, { action: 'click', observation: O, target: { by: 'link', role: 'button', name: 'Docs' } },
  { action: 'click', observation: O, target: { ref: '' } }, { action: 'click', observation: O, target: { x: 1, y: 2 } }, { action: 'observe', extra: true }, {},
];

describe('golden files', () => {
  it('what the validator accepts, and the first thing it says when it does not', async () => {
    const lines = VALIDATION.map((input) => {
      const parsed = commandSchema.safeParse(input);
      const verdict = parsed.success ? 'ok' : `${parsed.error.issues[0]!.path.map(String).join('.') || '(root)'}: ${parsed.error.issues[0]!.message}`;
      return `${JSON.stringify(input)}\n  → ${verdict}`;
    });
    await expect(`${lines.join('\n')}\n`).toMatchFileSnapshot('./golden/validation.txt');
  });

  it('the wire schema', async () => {
    await expect(`${JSON.stringify(WIRE_SCHEMA, null, 2)}\n`).toMatchFileSnapshot('./golden/wire-schema.json');
  });

  it('the tool description', async () => {
    await expect(`${TOOL_DESCRIPTION.split(/(?<=\.) (?=[A-Z{])/).join('\n')}\n`).toMatchFileSnapshot('./golden/tool-description.txt');
  });

  it('the wording of every step, done and not done', async () => {
    const lines = CALLS.flatMap((call) => [true, false].map((done) => `${done ? 'done ' : 'not  '} ${JSON.stringify(call)}\n       → ${describeStep(call, TARGETS, done)}`));
    await expect(`${lines.join('\n')}\n`).toMatchFileSnapshot('./golden/step-wording.txt');
  });
});
