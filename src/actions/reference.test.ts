/** docs/actions.md is generated from the registry; this fails when it falls behind. `npm run docs` rewrites it. */
import { expect, it } from 'vitest';
import { actionReference } from './reference.js';

it('docs/actions.md matches the registry', async () => {
  await expect(actionReference()).toMatchFileSnapshot('../../docs/actions.md');
});
