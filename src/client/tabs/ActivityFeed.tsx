/**
 * ActivityFeed tab.
 *
 * Pure presentation component. The parent (`App.tsx`) owns data fetching
 * AND realtime wiring — when an `actions-{sub}` realtime `action` event
 * arrives, the parent calls `prependDedupe(currentFeed, e.entry)` and
 * passes the result down via the `feed` prop. This keeps the tab
 * single-purpose and avoids double-fetching `/api/feed` (every tab panel
 * is mounted up front in App.tsx; an internal `useEffect` here would
 * re-call `getFeed` on initial mount alongside the parent's call).
 *
 * Renders, for each entry:
 *   - moderator (server scrubs deleted accounts to "[deleted]" via task
 *     9.2's `scrubEntry` before the entry is appended to `actions:{sub}`,
 *     so we render the value verbatim — no client-side scrubbing).
 *   - comboName (the value is already `string | "Claim"` per the
 *     `ActionEntry` type contract).
 *   - thingId rendered as a link to `https://reddit.com/{thingId}`.
 *   - relative timestamp ("2m ago" / "5h ago" / "3d ago").
 *   - "(failed at step N)" badge when `failedStepIndex !== undefined`.
 *
 * State branches:
 *   - `feed === undefined`        → loading state
 *   - `feed.length === 0`         → empty state
 *   - otherwise                   → rendered entries (parent supplies
 *                                   them newest-first)
 *
 * Source of truth: `tasks.md` task 7.3. Validates Property 8 (client
 * half — pure prepend-dedupe form) per `.kiro/specs/modsync/design.md`.
 */
import { MAX_FEED_ENTRIES, type ActionEntry } from '../types';

export interface ActivityFeedProps {
  /**
   * The parent-fetched feed. `undefined` means the parent's initial
   * fetch is still in-flight (loading state). Empty array means the
   * fetch resolved with no entries (empty state). Non-empty array is
   * rendered as-is (parent supplies newest-first).
   */
  feed?: ActionEntry[];
}

const EMPTY_COPY = 'No moderator actions recorded yet.';

/**
 * Pure helper that models the parent-side prepend-dedupe contract for
 * incoming realtime `action` events. Exported so the property test in
 * `tests/ActivityFeed.spec.tsx` can exercise the contract without
 * rendering, and so a future task that wires realtime into App.tsx can
 * import this same function rather than re-implementing the dedupe
 * logic ad-hoc.
 *
 * Behavior:
 *   - If `incoming.id` already appears in `feed`, returns `feed`
 *     unchanged (referentially identical).
 *   - Otherwise returns a NEW array `[incoming, ...feed]` capped at
 *     `max` entries (default `MAX_FEED_ENTRIES = 500`).
 *
 * The cap matches the server-side `actions:{sub}` sorted-set cap from
 * task 7.1, so client and server agree on the upper bound.
 */
export function prependDedupe(
  feed: ActionEntry[],
  incoming: ActionEntry,
  max: number = MAX_FEED_ENTRIES,
): ActionEntry[] {
  for (const entry of feed) {
    if (entry.id === incoming.id) {
      return feed;
    }
  }
  const next = [incoming, ...feed];
  return next.length > max ? next.slice(0, max) : next;
}

/**
 * Format a millisecond-epoch timestamp as a relative time string
 * ("3s ago" / "12m ago" / "5h ago" / "2d ago"). Uses `Date.now()` as
 * the reference; pure function over its inputs otherwise.
 *
 * Future timestamps (positive `diff`) render as "just now" — happens
 * when client and server clocks differ.
 */
function formatRelativeTime(ts: number, now: number = Date.now()): string {
  const diffMs = now - ts;
  if (diffMs < 0) return 'just now';
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 1) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  const diffDay = Math.floor(diffHour / 24);
  return `${diffDay}d ago`;
}

export function ActivityFeed({ feed }: ActivityFeedProps = {}) {
  if (feed === undefined) {
    return <div>Loading…</div>;
  }

  if (feed.length === 0) {
    return (
      <div>
        <p>{EMPTY_COPY}</p>
      </div>
    );
  }

  return (
    <ul data-testid="activity-feed-list">
      {feed.map((entry) => (
        <li key={entry.id} data-testid="activity-feed-entry">
          <span data-testid="entry-moderator">{entry.moderator}</span>
          <span data-testid="entry-combo-name">{entry.comboName}</span>
          <a
            href={`https://reddit.com/${entry.thingId}`}
            data-testid="entry-thing-link"
            target="_blank"
            rel="noopener noreferrer"
          >
            {entry.thingId}
          </a>
          <span data-testid="entry-timestamp">
            {formatRelativeTime(entry.ts)}
          </span>
          {entry.failedStepIndex !== undefined ? (
            <span data-testid="entry-failed-badge">
              (failed at step {entry.failedStepIndex})
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
