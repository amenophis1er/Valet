/*
 * The action reference (docs/actions.md), generated from the registry so it
 * cannot fall behind the code. reference.test.ts holds the checked-in file to
 * this output; `npm run docs` rewrites it.
 */

import { FIELDS, FIELD_NAMES, type FieldName } from './fields.js';
import { ACTING, ACTIONS, SPECS, WIRE_SCHEMA } from './index.js';

const code = (text: string) => `\`${text}\``;
const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');

function factsOf(name: (typeof ACTIONS)[number]): string {
  const { facts } = SPECS[name];
  const said: string[] = [];
  if (facts.goesTo) said.push('goes to a URL (scope-checked)');
  if (facts.followsLink) said.push('may follow a link (scope-checked)');
  if (facts.submits) said.push('may submit a form (owner approves)');
  return said.join('; ') || '—';
}

export function actionReference(): string {
  const lines: string[] = [
    '# Actions',
    '',
    '<!-- Generated from src/actions by `npm run docs`. Do not edit by hand: reference.test.ts fails when this file and the code disagree. -->',
    '',
    'The agent works through one tool, `browser`. Each call names an `action` and the fields it needs.',
    'Every call is validated, then checked by the run controller (fresh evidence, the run\'s scope, form submissions) before anything is dispatched; see [architecture.md](architecture.md).',
    '',
    `**Acting actions** — ${ACTING.map(code).join(', ')} — act on the page: they must carry the latest \`observation\` id, invalidate it, and are followed by a new observation.`,
    '',
    '## Summary',
    '',
    '| Action | Acts on the page | Required | Optional | Safety facts |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const name of ACTIONS) {
    const spec = SPECS[name];
    lines.push(`| ${code(name)} | ${spec.acting ? 'yes' : 'no'} | ${(spec.fields.required ?? []).map(code).join(', ') || '—'} | ${(spec.fields.optional ?? []).map(code).join(', ') || '—'} | ${factsOf(name)} |`);
  }
  lines.push('', '## Each action', '');
  for (const name of ACTIONS) {
    const spec = SPECS[name];
    lines.push(`### ${code(name)}`, '', spec.guide, '');
  }
  lines.push('## Fields', '', '| Field | Type | Description |', '| --- | --- | --- |');
  const wire = WIRE_SCHEMA.properties as Record<string, { type?: string; enum?: readonly string[]; description?: string }>;
  for (const field of FIELD_NAMES as FieldName[]) {
    const schema = wire[field]!;
    const type = schema.enum ? schema.enum.map((value) => code(value)).join(' \\| ') : code(schema.type ?? 'object');
    const exclusive = (FIELDS[field] as { exclusive?: boolean }).exclusive ? ' Refused on any other action.' : '';
    lines.push(`| ${code(field)} | ${type} | ${cell((schema.description ?? '') + exclusive)} |`);
  }
  return `${lines.join('\n')}\n`;
}
