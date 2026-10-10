/*
 * The dev reloader (`npm run dev` only; `__DEV__` is false in every other
 * build, so this compiles to nothing). Polls dist/dev-build.json, which the
 * dev build writes, from the extension's own files — no network.
 *
 * Each bundle carries the id of the build it came from (`__DEV_ID__`), and the
 * record says in which build the worker's and the panel's files last changed.
 * A part reloads when the record names a build newer than its own: so a
 * change made while the worker slept is seen the moment it wakes, and a change
 * to the panel alone never reloads the extension.
 */
declare const __DEV__: boolean;
declare const __DEV_ID__: string;

export function devReload(part: 'worker' | 'panel', onChange: () => void): void {
  if (typeof __DEV__ === 'undefined' || !__DEV__) return;
  const mine = Number(__DEV_ID__) || 0;
  let fired = false;
  const check = async (): Promise<void> => {
    if (fired) return;
    try {
      const url = (globalThis as unknown as { chrome: { runtime: { getURL(path: string): string } } }).chrome.runtime.getURL('dev-build.json');
      const build = await (await fetch(url, { cache: 'no-store' })).json() as Record<string, unknown>;
      const changedIn = Number(build[`${part}Id`]) || 0;
      if (changedIn > mine) { fired = true; onChange(); }
    } catch {
      // Between two writes of the file, or not a dev build after all: try again next time.
    }
  };
  void check();
  setInterval(() => void check(), 1_000);
}
