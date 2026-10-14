/*
 * Keeps the service worker alive while a run is going.
 *
 * Chrome stops an extension's worker after about thirty seconds without an
 * extension API call. A run spends long stretches making none: a slow
 * navigation, a model request, an approval card or a question waiting for the
 * owner. The panel sends heartbeats meanwhile, but the panel belongs to one
 * tab and closes when the owner looks at another, and then nothing keeps the
 * worker up: it was stopped mid-run, with a card waiting, while the owner
 * read elsewhere. So the worker pings on its own, every `EVERY_MS`, as long
 * as any conversation is running, and not a moment longer: an idle or paused
 * conversation lets the worker sleep as Chrome intends.
 */

export const EVERY_MS = 20_000;

export interface Timers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export class KeepAlive {
  readonly #ping: () => void;
  readonly #timers: Timers;
  readonly #busy = new Set<string>();
  #handle: unknown;

  /** `ping` is any cheap extension API call; its result does not matter. */
  // Wrapped: the bare functions, called as methods of this object, throw "Illegal invocation" in Chrome.
  constructor(ping: () => void, timers: Timers = { set: (callback, ms) => setInterval(callback, ms), clear: (handle) => clearInterval(handle as number) }) {
    this.#ping = ping;
    this.#timers = timers;
  }

  /** Whether the pings are going. */
  get active(): boolean { return this.#handle !== undefined; }

  /** Tell it a conversation is running, or no longer is. */
  want(id: string, busy: boolean): void {
    if (busy) this.#busy.add(id); else this.#busy.delete(id);
    const needed = this.#busy.size > 0;
    if (needed && this.#handle === undefined) this.#handle = this.#timers.set(() => this.#ping(), EVERY_MS);
    if (!needed && this.#handle !== undefined) {
      this.#timers.clear(this.#handle);
      this.#handle = undefined;
    }
  }
}
