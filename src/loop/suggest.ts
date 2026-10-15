/*
 * The `suggest_next` tool: up to three follow-ups the agent offers once it has
 * answered, shown as chips under its answer. A chip is a message: clicking it
 * sends its words as the owner's next message, through the same path and
 * approvals as typing them. The labels are the model's words, often shaped by
 * a page: text to show, never instructions to the extension.
 */

import { z } from 'zod';

export const MAX_FOLLOW_UPS = 3;
export const MAX_FOLLOW_UP_CHARS = 60;

export const SUGGEST_TOOL = {
  name: 'suggest_next',
  description: [
    'Offer the owner up to three next steps, as buttons under your answer, when your answer leaves an obvious fork: something you saw you could do next ("Add both to the cart", "Check the other seller", "Save this as CSV").',
    'Call it once, at the very end of your turn, after your answer. Each label is short and imperative, and names a concrete thing from this task; never a generic one ("Anything else?", "Summarize this").',
    'Skip it when there is no real next step: no buttons is better than filler.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['next'],
    properties: {
      next: {
        type: 'array', minItems: 1, maxItems: MAX_FOLLOW_UPS,
        items: { type: 'string', minLength: 1, maxLength: MAX_FOLLOW_UP_CHARS },
        description: 'The follow-ups, the most likely first.',
      },
    },
  },
} as const;

const input = z.object({ next: z.array(z.string().trim().min(1).max(MAX_FOLLOW_UP_CHARS)).min(1).max(MAX_FOLLOW_UPS) }).strict();

/** The follow-ups of a call, distinct and in order, or why the call was refused. */
export function parseSuggestions(args: unknown): { next: string[] } | { error: string } {
  const parsed = input.safeParse(args);
  if (!parsed.success) return { error: `Invalid suggest_next call: send {"next":["…"]} with 1 to ${MAX_FOLLOW_UPS} labels of up to ${MAX_FOLLOW_UP_CHARS} characters.` };
  const next = [...new Set(parsed.data.next.map((label) => label.replace(/\s+/g, ' ')))];
  return { next };
}
