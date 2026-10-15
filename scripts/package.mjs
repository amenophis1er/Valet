/*
 * The Chrome Web Store package: a release build, zipped, without the
 * manifest's `key` (the store assigns the id itself and refuses a key).
 * The release workflow uploads what this makes; store/build.mjs (local,
 * untracked) makes the same package beside the listing's images.
 *
 *   node scripts/package.mjs [out-dir]     → <out-dir>/valet-<version>.zip
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildExtension } from './build.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Build and zip the extension for the store; returns the zip's path. */
export async function packageExtension(outDir = path.join(root, 'store', 'out')) {
  await mkdir(outDir, { recursive: true });
  const build = await mkdtemp(path.join(os.tmpdir(), 'valet-package-'));
  try {
    await buildExtension({ out: build });
    const manifestPath = path.join(build, 'manifest.json');
    const { key: _key, ...manifest } = JSON.parse(await readFile(manifestPath, 'utf8'));
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const zip = path.join(outDir, `valet-${manifest.version}.zip`);
    await rm(zip, { force: true });
    execFileSync('zip', ['-qr', '-X', zip, '.'], { cwd: build });
    return zip;
  } finally {
    await rm(build, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const zip = await packageExtension(process.argv[2] ? path.resolve(process.argv[2]) : undefined);
  console.log(path.relative(root, zip));
}
