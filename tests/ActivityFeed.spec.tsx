// @vitest-environment jsdom
/**
 * Component + property tests for `src/client/tabs/ActivityFeed.tsx`
 * (task 7.3).
 *
 * Architecture: ActivityFeed is a pure presentation component. The
 * parent (`App.tsx`) owns `/api/feed` fetching AND realtime wiring;
 * incoming `action` events are folded into the feed via the exported
 * `prependDedupe` helper. The component does NOT fetch on its own.
 *
 * Coverage:
 *   - render with seeded entries: moderator + comboName + thingId link +
 *     timestamp render correctly
 *   - failed-step badge appears iff `failedStepIndex !== undefined`
 *   - feed === [] → empty-state copy
 *   - feed === undefined → loading state
 *   - PBT (≥100 iter) — Property 8 (client half, pure form):
 *       forall existingFeed and incoming event entry. prependDedupe
 *       yields feed[0].id === incoming.id (or feed unchanged if dup id)
 *       AND length ≤ 500.
 *
 * **Validates: Requirement 7 — Property 8 (client half)** per
 * `.kiro/specs/modsync/design.md`.
 */
import { afterEach, describe, expect, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import fc from 'fast-check';
import {
  ActivityFeed,
  prependDedupe,
} from '../src/client/tabs/ActivityFeed';
import {
  MAX_FEED_ENTRIES,
  type ActionEntry,
  type ComboStep,
  type ThingId,
} from '../src/shared/types';

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<ActionEntry> = {}): ActionEntry {
  const base: ActionEntry = {
    id: 'e-0',
    ts: Date.now() - 60_000, // 1 minute ago by default
    moderator: 'alice',
    thingId: 't3_abc123' as ThingId,
    comboName: 'Claim',
    ranSteps: [],
  };
  return { ...base, ...overrides };
}

// ---------------------------------------------------------------------------
// Render tests
// ---------------------------------------------------------------------------

describe('ActivityFeed render', () => {
  test('renders loading state when feed is undefined', () => {
    render(<ActivityFeed />);
    expect(screen.getByText(/loading/i)).toBeDefined();
    expect(screen.queryByTestId('activity-feed-list')).toBeNull();
  });

  test('renders empty-state copy when feed is empty array', () => {
    render(<ActivityFeed feed={[]} />);
    expect(
      screen.getByText('No moderator actions recorded yet.'),
    ).toBeDefined();
    expect(screen.queryByTestId('activity-feed-list')).toBeNull();
  });

  test('renders all entries with moderator + comboName + thingId link', () => {
    const entries: ActionEntry[] = [
      makeEntry({
        id: 'e-1',
        moderator: 'alice',
        thingId: 't3_post1' as ThingId,
        comboName: 'spam-removal',
        ranSteps: [{ kind: 'REMOVE' } as ComboStep],
      }),
      makeEntry({
        id: 'e-2',
        moderator: 'bob',
        thingId: 't1_comment2' as ThingId,
        comboName: 'Claim',
        ranSteps: [],
      }),
    ];
    render(<ActivityFeed feed={entries} />);

    const rendered = screen.getAllByTestId('activity-feed-entry');
    expect(rendered).toHaveLength(2);

    const moderators = screen.getAllByTestId('entry-moderator').map((n) => n.textContent);
    expect(moderators).toEqual(['alice', 'bob']);

    const combos = screen.getAllByTestId('entry-combo-name').map((n) => n.textContent);
    expect(combos).toEqual(['spam-removal', 'Claim']);

    const links = screen.getAllByTestId('entry-thing-link') as HTMLAnchorElement[];
    expect(links).toHaveLength(2);
    expect(links[0]!.getAttribute('href')).toBe('https://reddit.com/t3_post1');
    expect(links[0]!.textContent).toBe('t3_post1');
    expect(links[1]!.getAttribute('href')).toBe('https://reddit.com/t1_comment2');
    expect(links[1]!.textContent).toBe('t1_comment2');
  });

  test('renders relative timestamps in the entry rows', () => {
    const entries: ActionEntry[] = [
      makeEntry({ id: 'e-1', ts: Date.now() - 120_000 }), // 2 min ago
      makeEntry({ id: 'e-2', ts: Date.now() - 5_000 }), // 5s ago
    ];
    render(<ActivityFeed feed={entries} />);
    const stamps = screen.getAllByTestId('entry-timestamp').map((n) => n.textContent);
    expect(stamps).toHaveLength(2);
    // First entry is 2 minutes old, second is ~5 seconds old.
    expect(stamps[0]).toMatch(/^\d+m ago$/);
    expect(stamps[1]).toMatch(/^\d+s ago$|^just now$/);
  });

  test('renders the failed-step badge for entries with failedStepIndex set', () => {
    const entries: ActionEntry[] = [
      makeEntry({
        id: 'e-clean',
        comboName: 'spam-removal',
        ranSteps: [{ kind: 'REMOVE' } as ComboStep],
      }),
      makeEntry({
        id: 'e-failed',
        comboName: 'rule-violation',
        ranSteps: [{ kind: 'REMOVE' } as ComboStep],
        failedStepIndex: 1,
        failureMessage: 'API error',
      }),
    ];
    render(<ActivityFeed feed={entries} />);

    const badges = screen.getAllByTestId('entry-failed-badge');
    expect(badges).toHaveLength(1);
    expect(badges[0]!.textContent).toContain('failed at step 1');
  });

  test('does NOT render the failed-step badge when failedStepIndex is absent', () => {
    const entries: ActionEntry[] = [
      makeEntry({
        id: 'e-clean',
        ranSteps: [{ kind: 'REMOVE' } as ComboStep],
      }),
    ];
    render(<ActivityFeed feed={entries} />);
    expect(screen.queryByTestId('entry-failed-badge')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PBT — Property 8 (client half, pure form)
// ---------------------------------------------------------------------------

describe('Property 8 (client half — prependDedupe contract)', () => {
  // Reddit-y arbitraries (mirror tests/feed.spec.ts so the input space
  // matches the server-side property test).
  const modArb = fc.stringMatching(/^[A-Za-z0-9_-]{3,20}$/);
  const thingIdArb: fc.Arbitrary<ThingId> = fc.oneof(
    fc
      .stringMatching(/^[a-z0-9]{4,10}$/)
      .map((s): ThingId => `t1_${s}` as const),
    fc
      .stringMatching(/^[a-z0-9]{4,10}$/)
      .map((s): ThingId => `t3_${s}` as const),
  );

  // ULID-ish id arbitrary — uniqueness across feed + incoming is what
  // matters for the dedupe contract; concrete shape isn't load-bearing.
  const idArb = fc.stringMatching(/^[A-Z0-9]{8,16}$/);

  const entryArb: fc.Arbitrary<ActionEntry> = fc.record({
    id: idArb,
    ts: fc.integer({ min: 0, max: 4_000_000_000_000 }),
    moderator: modArb,
    thingId: thingIdArb,
    comboName: fc.oneof(
      fc.constant('Claim' as const),
      fc.string({ minLength: 1, maxLength: 40 }),
    ),
    ranSteps: fc.constant([]),
  });

  test('forall feed and incoming. prepended head matches OR feed unchanged on duplicate id; length ≤ 500', () => {
    fc.assert(
      fc.property(
        // Seed feed: 0..600 entries (covers below-cap, at-cap, above-cap),
        // with a unique-id constraint so dedupe semantics are well-defined.
        fc.uniqueArray(entryArb, {
          selector: (e) => e.id,
          minLength: 0,
          maxLength: 600,
        }),
        entryArb,
        // 50% of iterations: incoming uses an id that ALREADY exists in
        // the seeded feed (so we exercise the dedupe branch). Other 50%:
        // a fresh entry. We pick the existing id via a nat index when
        // possible.
        fc.boolean(),
        fc.nat({ max: 599 }),
        (existingFeed, freshIncoming, useExistingId, idx) => {
          let incoming: ActionEntry;
          if (useExistingId && existingFeed.length > 0) {
            const pickIdx = idx % existingFeed.length;
            const dupedId = existingFeed[pickIdx]!.id;
            incoming = { ...freshIncoming, id: dupedId };
          } else {
            incoming = freshIncoming;
          }

          const result = prependDedupe(existingFeed, incoming);

          // Length cap: never exceeds MAX_FEED_ENTRIES.
          expect(result.length).toBeLessThanOrEqual(MAX_FEED_ENTRIES);

          // Branch on whether the incoming id was already present in
          // the existing feed (NOT in the post-cap result, because
          // result might have evicted the dup if feed had length
          // > MAX). The dedupe semantic is "if incoming.id is in the
          // feed we received, return feed unchanged".
          const dupInExisting = existingFeed.some((e) => e.id === incoming.id);

          if (dupInExisting) {
            // Dedupe branch: feed unchanged (referentially identical).
            expect(result).toBe(existingFeed);
          } else {
            // Prepend branch: head matches incoming.
            expect(result.length).toBeGreaterThan(0);
            expect(result[0]!.id).toBe(incoming.id);
            // Below-cap: length is feed.length + 1.
            // At-or-above-cap: length is exactly MAX_FEED_ENTRIES.
            const expected = Math.min(
              existingFeed.length + 1,
              MAX_FEED_ENTRIES,
            );
            expect(result.length).toBe(expected);
            // Tail preservation: every survivor besides the head was
            // already in existingFeed in the same relative order.
            for (let i = 1; i < result.length; i++) {
              expect(result[i]).toBe(existingFeed[i - 1]);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
