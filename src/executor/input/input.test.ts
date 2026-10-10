/** The executor implements exactly the actions the registry says act on the page. */
import { describe, expect, it } from 'vitest';
import { ACTING } from '../../actions/index.js';
import { INPUT } from './index.js';

describe('input actions', () => {
  it('cover the registry\'s acting actions, no more and no fewer', () => {
    expect(Object.keys(INPUT).sort()).toEqual([...ACTING].sort());
  });
});
