import { describe, expect, test } from 'vitest';
import * as fc from 'fast-check';
import { MAX_FEED_ENTRIES } from '@shared/types';

/**
 * Sanity tests for the test toolchain itself. If either of these fails,
 * something is wrong with vitest, fast-check, or the `@shared` alias —
 * not with ModSync logic.
 *
 * Source: tasks.md task 1.3.
 */
describe('toolchain sanity', () => {
  test('fast-check property: forall n: int. n + 0 === n', () => {
    fc.assert(
      fc.property(fc.integer(), (n) => {
        return n + 0 === n;
      }),
      { numRuns: 100 },
    );
  });

  test('@shared alias resolves and constants are intact', () => {
    expect(MAX_FEED_ENTRIES).toBe(500);
  });
});
