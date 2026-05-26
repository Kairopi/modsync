// @vitest-environment jsdom
/**
 * Component tests for `src/client/tabs/MetricsDashboard.tsx` (task 6.4).
 *
 * Architecture: MetricsDashboard is a pure presentation component. The
 * parent (`App.tsx`) fetches `/api/metrics` and threads the bucket down
 * via the `metrics` prop. The component does NOT fetch on its own.
 *
 * Validates:
 *   - Three counters render the values from `metrics` prop.
 *   - All-zero bucket renders the empty-state copy.
 *   - Undefined metrics renders a loading state.
 *   - PBT (100 iter): forall MetricsBucket b. counters render b's exact
 *     values; all-zero buckets show the empty-state copy.
 *
 * **Validates: Requirement 8 — Property 9 (zero-state UX)** per
 * `.kiro/specs/modsync/design.md`.
 */
import { afterEach, describe, expect, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import fc from 'fast-check';
import { MetricsDashboard } from '../src/client/tabs/MetricsDashboard';
import type { MetricsBucket } from '../src/shared/types';

interface MetricsResponseShape extends MetricsBucket {
  period: 'week' | 'month';
  periodKey: string;
}

const EMPTY_COPY = 'No collision events recorded yet for this period.';

afterEach(() => {
  cleanup();
});

describe('MetricsDashboard', () => {
  test('renders the three counter values from the metrics prop', () => {
    const metrics: MetricsResponseShape = {
      softWarningsShown: 3,
      collisionsDetected: 7,
      redundantActionsAvoided: 12,
      period: 'week',
      periodKey: '2025-W42',
    };
    render(<MetricsDashboard metrics={metrics} />);
    expect(screen.getByTestId('metric-soft-warnings').textContent).toBe('3');
    expect(screen.getByTestId('metric-collisions').textContent).toBe('7');
    expect(screen.getByTestId('metric-redundant').textContent).toBe('12');
  });

  test('renders the empty-state copy when all counters are zero', () => {
    const metrics: MetricsResponseShape = {
      softWarningsShown: 0,
      collisionsDetected: 0,
      redundantActionsAvoided: 0,
      period: 'week',
      periodKey: '2025-W42',
    };
    render(<MetricsDashboard metrics={metrics} />);
    expect(screen.getByText(EMPTY_COPY)).toBeDefined();
    expect(screen.queryByTestId('metric-soft-warnings')).toBeNull();
    expect(screen.queryByTestId('metric-collisions')).toBeNull();
    expect(screen.queryByTestId('metric-redundant')).toBeNull();
  });

  test('renders a loading state when metrics is undefined', () => {
    render(<MetricsDashboard />);
    expect(screen.getByText(/loading/i)).toBeDefined();
  });
});

describe('MetricsDashboard property tests', () => {
  test('forall MetricsBucket b: counters render b exactly; all-zero shows empty-state', () => {
    // Validates Requirement 8 — Property 9 (zero-state UX).
    fc.assert(
      fc.property(
        fc.record({
          softWarningsShown: fc.integer({ min: 0, max: 1_000_000 }),
          collisionsDetected: fc.integer({ min: 0, max: 1_000_000 }),
          redundantActionsAvoided: fc.integer({ min: 0, max: 1_000_000 }),
        }),
        (bucket: MetricsBucket) => {
          const metrics: MetricsResponseShape = {
            ...bucket,
            period: 'week',
            periodKey: '2025-W42',
          };
          try {
            render(<MetricsDashboard metrics={metrics} />);
            const allZero =
              bucket.softWarningsShown === 0 &&
              bucket.collisionsDetected === 0 &&
              bucket.redundantActionsAvoided === 0;
            if (allZero) {
              expect(screen.getByText(EMPTY_COPY)).toBeDefined();
              expect(screen.queryByTestId('metric-soft-warnings')).toBeNull();
              expect(screen.queryByTestId('metric-collisions')).toBeNull();
              expect(screen.queryByTestId('metric-redundant')).toBeNull();
            } else {
              expect(screen.getByTestId('metric-soft-warnings').textContent).toBe(
                String(bucket.softWarningsShown),
              );
              expect(screen.getByTestId('metric-collisions').textContent).toBe(
                String(bucket.collisionsDetected),
              );
              expect(screen.getByTestId('metric-redundant').textContent).toBe(
                String(bucket.redundantActionsAvoided),
              );
              expect(screen.queryByText(EMPTY_COPY)).toBeNull();
            }
          } finally {
            cleanup();
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
