/**
 * MetricsDashboard tab.
 *
 * Renders three counters from the parent-fetched `MetricsResponse`:
 *   - Soft warnings shown
 *   - Collisions detected
 *   - Redundant actions avoided
 *
 * When all three counters are zero, renders the empty-state copy
 * "No collision events recorded yet for this period." per spec.
 *
 * Data flow:
 *   - The shell in `App.tsx` fetches `/api/metrics` once on initial mount
 *     and threads the result down via the `metrics` prop. This component
 *     does NOT fetch on its own — that would double-call `/api/metrics`
 *     given that App.tsx mounts every tab panel up front (the inactive
 *     panels are visually hidden, but their effects still run).
 *   - Per-tab refetch on focus is owned by the parent (`App.tsx` wires
 *     `onTabChange === 'metrics' → getMetrics()`); MetricsDashboard is
 *     a pure presentation component.
 *
 * Source of truth: `tasks.md` task 6.4. Validates Property 9 (zero-state
 * UX) per `.kiro/specs/modsync/design.md`.
 */
import type { MetricsResponse } from '../api';

export interface MetricsDashboardProps {
  /**
   * The parent-fetched metrics bucket. `undefined` means the parent's
   * initial fetch is still in-flight or has errored — render the
   * loading state in that case.
   */
  metrics?: MetricsResponse;
}

const EMPTY_COPY = 'No collision events recorded yet for this period.';

export function MetricsDashboard({ metrics }: MetricsDashboardProps = {}) {
  if (metrics === undefined) {
    return <div>Loading…</div>;
  }

  const isEmpty =
    metrics.softWarningsShown === 0 &&
    metrics.collisionsDetected === 0 &&
    metrics.redundantActionsAvoided === 0;

  if (isEmpty) {
    return (
      <div>
        <p>{EMPTY_COPY}</p>
      </div>
    );
  }

  return (
    <div>
      <dl>
        <div>
          <dt>Soft warnings shown</dt>
          <dd data-testid="metric-soft-warnings">{metrics.softWarningsShown}</dd>
        </div>
        <div>
          <dt>Collisions detected</dt>
          <dd data-testid="metric-collisions">{metrics.collisionsDetected}</dd>
        </div>
        <div>
          <dt>Redundant actions avoided</dt>
          <dd data-testid="metric-redundant">{metrics.redundantActionsAvoided}</dd>
        </div>
      </dl>
    </div>
  );
}
