/*
 * Waiting on the owner: an approval card, or Learn's Next.
 *
 * One waiter per question. It exists before the owner can see the question,
 * so an answer given at once is never lost; a second question answers the
 * first with its fallback before it begins; and Stop answers whatever is open
 * with the fallback, so a run can never hang on a question nobody will
 * answer.
 */

export class Waiter<T> {
  #resolve?: (value: T) => void;
  readonly #fallback: T;

  /** `fallback`: the answer when the question is superseded or the run stops (Deny for a card, go on for a step). */
  constructor(fallback: T) {
    this.#fallback = fallback;
  }

  /** Whether a question is open. */
  get open(): boolean {
    return this.#resolve !== undefined;
  }

  /** Open a question; an earlier open one gets the fallback first. */
  ask(): Promise<T> {
    this.answer(this.#fallback);
    return new Promise<T>((resolve) => { this.#resolve = resolve; });
  }

  /** The owner's answer; nothing open, nothing happens. */
  answer(value: T): void {
    const resolve = this.#resolve;
    this.#resolve = undefined;
    resolve?.(value);
  }

  /** Close whatever is open with the fallback. */
  release(): void {
    this.answer(this.#fallback);
  }
}
