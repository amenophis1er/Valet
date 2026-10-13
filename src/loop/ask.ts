/*
 * The `ask_owner` tool: a question with a few options, which the owner
 * answers in the panel with one click, by typing, or not at all (Skip).
 *
 * A question is not an approval. The options are the model's words, and may
 * come from a page; the answer is only text the model reads. Sites and forms
 * stay with the cards the extension raises (approvals.ts), and nothing here
 * can allow anything. The panel shows a question unlike a card, so the owner
 * never takes one for the other.
 *
 * The run waits on the question like Learn waits on Next: one waiter, Stop
 * answers it, and the time spent waiting does not count against the run.
 */

import type { AIToolCall } from '@amenophis1er/byok/types';
import { z } from 'zod';
import type { LoopHost } from './host.js';
import type { Question } from './protocol.js';
import { Waiter } from './waiter.js';

export const MAX_OPTIONS = 5;
const MAX_QUESTION_CHARS = 300;
const MAX_LABEL_CHARS = 80;
const MAX_HINT_CHARS = 160;
/** The most of a typed answer the model gets. */
const MAX_TYPED_CHARS = 2_000;

export const ASK_TOOL = {
  name: 'ask_owner',
  description: [
    'Ask the owner to choose, when the task needs a choice only they can make and you can name the choices: which of several matching items, which account or address, which date.',
    'The panel shows your options as buttons; the owner can also type their own answer, or skip.',
    `Give 2 to ${MAX_OPTIONS} short options, the one you recommend first; add a hint only when a label needs one. Set multi:true when several may be chosen.`,
    'This is not for permission: opening a site and sending a form are asked by Valet itself, so never ask whether you may. Never ask for a password.',
    'Ask only when you cannot reasonably decide yourself, and ask once: then act on the answer.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['question', 'options'],
    properties: {
      question: { type: 'string', minLength: 1, maxLength: MAX_QUESTION_CHARS, description: 'One short question, for example "Which mug should I add to the cart?"' },
      options: {
        type: 'array', minItems: 2, maxItems: MAX_OPTIONS,
        items: {
          type: 'object', additionalProperties: false, required: ['label'],
          properties: {
            label: { type: 'string', minLength: 1, maxLength: MAX_LABEL_CHARS },
            hint: { type: 'string', maxLength: MAX_HINT_CHARS, description: 'One line on what choosing it means.' },
          },
        },
      },
      multi: { type: 'boolean', description: 'Several options may be chosen.' },
    },
  },
} as const;

const input = z.object({
  question: z.string().trim().min(1).max(MAX_QUESTION_CHARS),
  options: z.array(z.object({ label: z.string().trim().min(1).max(MAX_LABEL_CHARS), hint: z.string().trim().max(MAX_HINT_CHARS).optional() }).strict())
    .min(2).max(MAX_OPTIONS)
    .refine((options) => new Set(options.map((option) => option.label.toLowerCase())).size === options.length, 'two options have the same label'),
  multi: z.boolean().optional(),
}).strict();

/** A question as the model asked it, checked; or why it cannot be asked. */
export function parseQuestion(args: unknown): { question: Omit<Question, 'id'> } | { error: string } {
  const parsed = input.safeParse(args);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { error: `Invalid ask_owner call — ${issue?.path.join('.') || 'input'}: ${issue?.message ?? 'malformed'}. Send {"question":"…","options":[{"label":"…"},{"label":"…"}]}.` };
  }
  const { question, options, multi } = parsed.data;
  return { question: { question, options: options.map((option) => (option.hint ? { label: option.label, hint: option.hint } : { label: option.label })), multi: multi === true } };
}

/** What the owner did with a question. */
export type Reply =
  | { picked: string[] }
  | { text: string }
  | { skipped: true }
  /** Stop, a new conversation, or the question was superseded. */
  | { stopped: true };

/** The owner's reply as the model reads it. */
function resultOf(reply: Reply): { result: Record<string, unknown>; isError: boolean } {
  if ('picked' in reply) return { result: { answer: reply.picked.join(', '), picked: reply.picked }, isError: false };
  if ('text' in reply) return { result: { answer: reply.text.slice(0, MAX_TYPED_CHARS), typed: 'The owner typed this instead of picking one of your options.' }, isError: false };
  if ('skipped' in reply) return { result: { skipped: 'The owner skipped this question. Decide yourself if you reasonably can; otherwise end your turn and say what you need from them.' }, isError: false };
  return { result: { skipped: 'The run was stopped before the owner answered.' }, isError: true };
}

export class Questions {
  readonly #host: LoopHost;
  readonly #stopped: () => boolean;
  readonly #reply = new Waiter<Reply>({ stopped: true });

  /** `stopped`: whether the owner pressed Stop; a question asked after that is not shown. */
  constructor(host: LoopHost, stopped: () => boolean) {
    this.#host = host;
    this.#stopped = stopped;
  }

  /** Whether a question is waiting for the owner. */
  get open(): boolean {
    return this.#reply.open;
  }

  /** Show the question and wait for the owner; the call gets its one result. False when it could not be asked. */
  async ask(call: AIToolCall): Promise<boolean> {
    const parsed = parseQuestion(call.args);
    if ('error' in parsed) {
      this.#host.answer(call, { error: parsed.error, notice: 'Nothing was asked.' }, true);
      return false;
    }
    if (this.#stopped()) {
      this.#host.answer(call, resultOf({ stopped: true }).result, true);
      return false;
    }
    const state = this.#host.state();
    // The waiter exists before the owner can see the question: an answer given at once is never lost.
    const answered = this.#reply.ask();
    const question: Question = { id: `q-${this.#host.now()}-${Math.random().toString(36).slice(2, 8)}`, ...parsed.question };
    state.question = question;
    this.#host.trace({ kind: 'question', question: question.question, options: question.options.map((option) => option.label), multi: question.multi });
    await this.#host.save();
    const asked = this.#host.now();
    const reply = await answered;
    state.question = undefined;
    // Time the owner took to answer is not the run's time.
    state.startedAt += this.#host.now() - asked;
    if ('picked' in reply || 'text' in reply) {
      state.transcript.push({ kind: 'agent', text: question.question });
      state.transcript.push({ kind: 'owner', text: 'picked' in reply ? reply.picked.join(', ') : reply.text });
    } else {
      // Skipped or stopped, the question stays in the conversation with what became of it.
      state.transcript.push({ kind: 'agent', text: question.question });
      this.#host.note('skipped' in reply ? 'You skipped the question.' : 'The question was not answered.');
    }
    this.#host.trace({ kind: 'reply', reply: 'picked' in reply ? reply.picked.join(', ') : 'text' in reply ? reply.text : 'skipped' in reply ? '(skipped)' : '(stopped)' });
    const { result, isError } = resultOf(reply);
    this.#host.answer(call, result, isError);
    await this.#host.save();
    return true;
  }

  /** The owner picked options, or skipped. An answer to any other question, or options it did not offer, are ignored. */
  pick(id: string, picked: string[] | null): void {
    const question = this.#host.state().question;
    if (!question || question.id !== id || !this.open) return;
    if (picked === null) { this.#reply.answer({ skipped: true }); return; }
    const offered = question.options.map((option) => option.label);
    const chosen = offered.filter((label) => picked.includes(label));
    if (chosen.length === 0 || chosen.length !== new Set(picked).size || (!question.multi && chosen.length > 1)) return;
    this.#reply.answer({ picked: chosen });
  }

  /** The owner typed their own answer to this question. An answer to any other question is ignored. */
  type(id: string, text: string): void {
    if (this.#host.state().question?.id !== id || !this.open || !text.trim()) return;
    this.#reply.answer({ text: text.trim() });
  }

  /** Stop: the open question is answered as stopped. */
  release(): void {
    this.#reply.release();
  }
}
