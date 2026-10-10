import { defineConfig } from '@playwright/test';

/** `npm run screenshots`: every screen and state of the UI, light and dark, for design work. Not a test suite. */
export default defineConfig({
  testDir: '.',
  timeout: 300_000,
  workers: 1,
  reporter: 'list',
  // A stuck step fails its scene, not the whole run.
  use: { actionTimeout: 15_000 },
  expect: { timeout: 15_000 },
});
