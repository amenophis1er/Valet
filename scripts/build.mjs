/*
 * Builds `dist/`, the folder the owner loads unpacked.
 *
 * esbuild rather than the workspace's `tsc`, because Chrome wants three
 * separate bundles with three different shapes (an ES module worker, a classic
 * script for the page, an ES module for the side panel) and no `node_modules`
 * resolution at runtime. Types are still checked: `npm run typecheck` runs
 * `tsc` over the same sources with `noEmit`.
 */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Where the extension goes unless a caller says otherwise: the folder the owner loads unpacked. */
const DIST = path.join(root, 'dist');

/** Everything `manifest.json` names, so the manifest test has one list to check against. */
export const BUNDLES = [
  { entry: 'src/background.ts', out: 'background.js', format: 'esm' },
  { entry: 'src/executor/content.ts', out: 'content.js', format: 'iife' },
  { entry: 'src/panel.ts', out: 'panel.js', format: 'esm' },
  { entry: 'src/mic.ts', out: 'mic.js', format: 'esm' },
  { entry: 'src/viewer.ts', out: 'viewer.js', format: 'esm' },
  { entry: 'src/document.ts', out: 'document.js', format: 'esm' },
  { entry: 'src/welcome.ts', out: 'welcome.js', format: 'esm' },
];
export const STATIC = ['manifest.json', 'panel.html', 'tokens.css', 'panel.css', 'mic.html', 'viewer.html', 'document.html', 'welcome.html'];

/** The dev build's id, written into the bundles after they are hashed (see below). */
const DEV_ID_PLACEHOLDER = '__DEV_ID_PLACEHOLDER__';

export async function buildExtension({ clean = true, dev = false, out = DIST } = {}) {
  const dist = out;
  if (clean) await rm(dist, { recursive: true, force: true });
  await mkdir(path.join(dist, 'icons'), { recursive: true });

  // Which build is loaded, shown in Settings: a missed reload at chrome://extensions is then obvious.
  // A dev build carries no time: the stamp would change the panel bundle every minute, and so reload it for nothing.
  let commit = 'unknown';
  try { commit = execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim(); } catch { /* not a checkout */ }
  const stamp = dev ? `dev · ${commit}` : `${commit} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  for (const bundle of BUNDLES) {
    await build({
      define: { __BUILD__: JSON.stringify(stamp), __DEV__: JSON.stringify(dev), __DEV_ID__: JSON.stringify(dev ? DEV_ID_PLACEHOLDER : '') },
      entryPoints: [path.join(root, bundle.entry)],
      outfile: path.join(dist, bundle.out),
      bundle: true, format: bundle.format, target: 'chrome116', platform: 'browser',
      // A release is read by whoever loads it unpacked; there is nothing to hide. A dev build maps stack traces to the sources.
      minify: false, sourcemap: dev ? 'inline' : false, legalComments: 'none',
    });
  }

  for (const asset of STATIC) await cp(path.join(root, 'static', asset), path.join(dist, asset));
  // The app icon, from the design system (static/icons).
  await cp(path.join(root, 'static', 'icons'), path.join(dist, 'icons'), { recursive: true });

  // The manifest's version is the package's: one number everywhere.
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(path.join(dist, 'manifest.json'), 'utf8'));
  manifest.version = pkg.version;
  await writeFile(path.join(dist, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  if (dev) await stampDevBuild(dist);
  return dist;
}

/**
 * The dev reloader's record, dist/dev-build.json: this build's id (ms), and for
 * the worker and the panel the id of the last build in which their files
 * changed. Each bundle carries its own build id, so a running worker or panel
 * compares what is on disk with what it was built from — whether or not it was
 * awake when the change happened — and reloads only when its own part moved on.
 * The bundles are hashed before their id goes in, so the id itself changes nothing.
 */
async function stampDevBuild(dist) {
  const previous = await readFile(path.join(dist, 'dev-build.json'), 'utf8').then(JSON.parse).catch(() => ({}));
  const hash = async (files) => {
    const digest = createHash('sha256');
    for (const file of files) digest.update(await readFile(path.join(dist, file)));
    return digest.digest('hex').slice(0, 16);
  };
  const id = Math.max(Date.now(), (previous.id ?? 0) + 1);
  const worker = await hash(['background.js', 'content.js', 'manifest.json']);
  const panel = await hash(['panel.js', 'panel.html', 'panel.css']);
  const record = {
    id,
    worker, workerId: worker === previous.worker && previous.workerId ? previous.workerId : id,
    panel, panelId: panel === previous.panel && previous.panelId ? previous.panelId : id,
  };
  for (const bundle of BUNDLES) {
    const file = path.join(dist, bundle.out);
    const text = await readFile(file, 'utf8');
    if (text.includes(DEV_ID_PLACEHOLDER)) await writeFile(file, text.replaceAll(DEV_ID_PLACEHOLDER, String(id)));
  }
  await writeFile(path.join(dist, 'dev-build.json'), `${JSON.stringify(record)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`Extension: ${await buildExtension()}`);
}
