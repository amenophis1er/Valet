/*
 * `npm run dev`: build once in dev mode, then rebuild on every change to src/
 * or static/. The dev build carries a reloader (compiled out of normal
 * builds): the worker reloads the extension when worker code changed, and the
 * side panel reloads itself when only panel files changed. Load dist/ unpacked
 * once; after that, save and watch.
 *
 * Working on byok at the same time: `npm install --no-save
 * ../byok` links the checkout into node_modules, and its dist/
 * is watched too (build it there with `npm run build`, or its own watcher).
 */
import { lstat, realpath } from 'node:fs/promises';
import { watch } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildExtension } from './build.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIBRARY = path.join(root, 'node_modules', '@amenophis1er', 'byok');
let pending;
let building = false;

async function rebuild(reason) {
  if (building) { pending = reason; return; }
  building = true;
  const started = Date.now();
  try {
    // Not a clean build: rm -rf of dist would make the loaded extension flicker.
    await buildExtension({ clean: false, dev: true });
    console.log(`built in ${Date.now() - started} ms${reason ? ` (${reason})` : ''}`);
  } catch (error) {
    console.error(`build failed: ${error instanceof Error ? error.message : error}`);
  } finally {
    building = false;
    if (pending) { const next = pending; pending = undefined; void rebuild(next); }
  }
}

await rebuild('start');
let timer;
const watched = [];
function watchDir(dir, label) {
  watch(dir, { recursive: true }, (_event, file) => {
    if (!file || /\.test\.ts$/.test(file)) return;
    clearTimeout(timer);
    timer = setTimeout(() => void rebuild(`${label}/${file}`), 80);
  });
  watched.push(label);
}
for (const dir of ['src', 'static']) watchDir(path.join(root, dir), dir);
// A linked library checkout (a symlink in node_modules): its built output is a source too.
const linked = await lstat(LIBRARY).then((stat) => stat.isSymbolicLink(), () => false);
if (linked) {
  const libraryDist = path.join(await realpath(LIBRARY), 'dist');
  if (await lstat(libraryDist).then(() => true, () => false)) watchDir(libraryDist, 'byok/dist');
  else console.log(`byok is linked but not built: run its build, then start this again to watch it.`);
}
console.log(`Watching ${watched.join(', ')}. Load ${path.join(root, 'dist')} unpacked once; it reloads itself.`);
