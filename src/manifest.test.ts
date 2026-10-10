/**
 * The folder the owner loads unpacked.
 *
 * A manifest that names a file Chrome cannot find fails at load time with a
 * dialog and no explanation, so the build itself is the test: it runs, and then
 * every path the manifest mentions has to exist.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BUNDLES, STATIC, buildExtension } from '../scripts/build.mjs';
import { EXTENSION_ID } from './id.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** A build of its own, never the dist/ a dev loop may be serving. */
let dist: string;
let manifest: Record<string, any>;

beforeAll(async () => {
  dist = await buildExtension({ out: await mkdtemp(path.join(os.tmpdir(), 'errand-manifest-')) });
  manifest = JSON.parse(await readFile(path.join(dist, 'manifest.json'), 'utf8'));
}, 60_000);

afterAll(async () => { if (dist) await rm(dist, { recursive: true, force: true }); });

const exists = async (relative: string) => (await stat(path.join(dist, relative)).catch(() => null))?.isFile() ?? false;

describe('the built extension', () => {
  it('is a Manifest V3 extension carrying the package version', async () => {
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    expect(manifest['manifest_version']).toBe(3);
    expect(manifest['version']).toBe(pkg.version);
    expect(manifest['name']).toBe('Errand');
    expect(manifest['minimum_chrome_version']).toBe('116');
  });

  it('asks for exactly the permissions it needs, and says why it wants every site', () => {
    // `activeTab` would be the permission for a browser the owner is driving;
    // this one only ever works in background tabs. The web pages it may reach
    // are named as the two schemes it can drive, never as `<all_urls>`.
    expect(new Set(manifest['permissions'])).toEqual(new Set([
      'tabs', 'tabGroups', 'scripting', 'debugger', 'storage', 'sidePanel', 'declarativeNetRequest', 'webNavigation',
    ]));
    for (const absent of ['activeTab', 'alarms', 'offscreen']) expect(manifest['permissions']).not.toContain(absent);
    expect(manifest['host_permissions']).toEqual(['http://*/*', 'https://*/*']);
    expect(String(manifest['description'])).toMatch(/access to every site because it works on the ones you ask/);
  });

  /*
   * Chrome derives an unpacked extension's id from the folder path unless the
   * manifest pins a key. This is the derivation Chrome performs: the SHA-256 of
   * the DER public key, first sixteen bytes, `0`-`f` mapped onto `a`-`p`.
   */
  it('carries the fixed public key, so its id is stable', () => {
    const key = manifest['key'];
    expect(typeof key).toBe('string');
    const digest = createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32);
    const derived = [...digest].map((hex) => String.fromCharCode('a'.charCodeAt(0) + parseInt(hex, 16))).join('');
    expect(derived).toBe(EXTENSION_ID);
    expect(JSON.stringify(manifest)).not.toMatch(/PRIVATE KEY/);
  });

  it('lets no other extension and no web page message it', async () => {
    // External messages only reach onMessageExternal/onConnectExternal; the worker has neither.
    // An empty externally_connectable would say the same but makes Chrome warn.
    expect(manifest).not.toHaveProperty('externally_connectable');
    for (const bundle of BUNDLES) {
      const source = await readFile(path.join(dist, bundle.out), 'utf8');
      expect(source).not.toMatch(/onMessageExternal|onConnectExternal/);
    }
  });

  it('has a side panel and no popup, offscreen document or alarm', () => {
    expect(manifest['side_panel']).toEqual({ default_path: 'panel.html' });
    expect(manifest['action']['default_popup']).toBeUndefined();
  });

  it('names only files that are in the folder', async () => {
    const named = [
      manifest['background']['service_worker'],
      manifest['side_panel']['default_path'],
      ...Object.values(manifest['icons'] as Record<string, string>),
    ];
    for (const file of named) expect(await exists(file), `${file} is missing`).toBe(true);
    for (const bundle of BUNDLES) expect(await exists(bundle.out), `${bundle.out} is missing`).toBe(true);
    for (const asset of STATIC) expect(await exists(asset), `${asset} is missing`).toBe(true);
  });

  it('runs the worker as a module and has no remote code in it', async () => {
    expect(manifest['background']['type']).toBe('module');
    for (const bundle of BUNDLES) {
      const source = await readFile(path.join(dist, bundle.out), 'utf8');
      expect(source, `${bundle.out} loads code from elsewhere`).not.toMatch(/\bimport\s*\(\s*['"]https?:/);
      expect(source).not.toMatch(/\bimportScripts\s*\(/);
      expect(source).not.toMatch(/\beval\s*\(/);
    }
  });

  it('draws its own icons rather than shipping a fetched asset', async () => {
    for (const [size, file] of Object.entries(manifest['icons'] as Record<string, string>)) {
      const bytes = await readFile(path.join(dist, file));
      expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG');
      expect(bytes.readUInt32BE(16)).toBe(Number(size));
    }
  });
});
