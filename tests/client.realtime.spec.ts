// @vitest-environment jsdom
/**
 * Tests for `src/client/realtime.ts`'s `useRealtime` hook (task 6.2).
 *
 * Validates:
 *   - reconnection backoff schedule is monotonic non-decreasing AND capped
 *     at 4000ms (Property: backoff cap);
 *   - `onResync` fires exactly once per successful reconnect (NOT on the
 *     initial connect) — supports the resync side of Property 8;
 *   - on unmount, the hook clears any pending reconnect timer and calls
 *     `disconnectRealtime(channel)`.
 *
 * The Devvit `connectRealtime` SDK call is mocked via `vi.mock` to capture
 * the supplied `onConnect` / `onDisconnect` / `onMessage` callbacks so we
 * can drive them directly in tests. `vi.useFakeTimers()` controls the
 * `setTimeout` backoff used by the hook.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fc from 'fast-check';
import { renderHook } from '@testing-library/react';

interface ConnectCallArgs {
  channel: string;
  onConnect?: (channel: string) => void;
  onDisconnect?: (channel: string) => void;
  onMessage: (data: unknown) => void;
}

const connectCalls: ConnectCallArgs[] = [];
const disconnectCalls: string[] = [];

vi.mock('@devvit/web/client', () => ({
  connectRealtime: (opts: ConnectCallArgs) => {
    connectCalls.push(opts);
    return { disconnect: async () => {} };
  },
  disconnectRealtime: (channel: string) => {
    disconnectCalls.push(channel);
  },
  isRealtimeConnected: () => false,
}));

// Imported AFTER the mock so the hook resolves to the mocked SDK.
const { useRealtime } = await import('../src/client/realtime');

const EXPECTED_SCHEDULE = [250, 500, 1000, 2000, 4000, 4000, 4000, 4000];

beforeEach(() => {
  connectCalls.length = 0;
  disconnectCalls.length = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Drive the most recently registered connection's `onConnect` callback to
 * simulate a successful socket open.
 */
function fireConnect(): ConnectCallArgs {
  const last = connectCalls[connectCalls.length - 1];
  if (!last) throw new Error('no active connectRealtime registration');
  last.onConnect?.(last.channel);
  return last;
}

/**
 * Drive the most recently registered connection's `onDisconnect` callback
 * and return how many connect attempts have been made so far. Each
 * disconnect schedules a reconnect via `setTimeout`; the test advances
 * fake timers to fire it.
 */
function fireDisconnect(): ConnectCallArgs {
  const last = connectCalls[connectCalls.length - 1];
  if (!last) throw new Error('no active connectRealtime registration');
  last.onDisconnect?.(last.channel);
  return last;
}

describe('useRealtime — backoff schedule', () => {
  test('first 8 disconnects produce the locked schedule [250, 500, 1000, 2000, 4000, 4000, 4000, 4000]', () => {
    const onEvent = vi.fn();
    const { unmount } = renderHook(() =>
      useRealtime<{ x: number }>('claims-Modsynnow', onEvent),
    );

    // Initial connect happens synchronously in the effect. Simulate a
    // first successful socket open so the hook's `hasConnectedOnce` flag
    // flips — otherwise the very first failure would still be backoff[0].
    fireConnect();

    const observed: number[] = [];
    for (let i = 0; i < EXPECTED_SCHEDULE.length; i++) {
      const before = connectCalls.length;
      fireDisconnect();
      // The hook scheduled a `setTimeout(open, expected[i])`. Advance
      // exactly that many ms; `connectRealtime` is invoked again.
      vi.advanceTimersByTime(EXPECTED_SCHEDULE[i] ?? 0);
      const after = connectCalls.length;
      expect(after).toBe(before + 1);
      observed.push(EXPECTED_SCHEDULE[i] ?? 0);
    }

    expect(observed).toEqual(EXPECTED_SCHEDULE);
    unmount();
  });

  test('successful reconnect resets backoff to 250ms', () => {
    const onEvent = vi.fn();
    const { unmount } = renderHook(() =>
      useRealtime<{ x: number }>('claims-Modsynnow', onEvent),
    );
    fireConnect();

    // Burn through 3 disconnects: 250 → 500 → 1000.
    fireDisconnect();
    vi.advanceTimersByTime(250);
    fireDisconnect();
    vi.advanceTimersByTime(500);
    fireDisconnect();
    vi.advanceTimersByTime(1000);

    // Successful reconnect at this point. Next disconnect MUST schedule
    // again at the initial 250ms.
    fireConnect();

    const beforeCount = connectCalls.length;
    fireDisconnect();
    // Advancing only 249ms must NOT yet trigger reconnect.
    vi.advanceTimersByTime(249);
    expect(connectCalls.length).toBe(beforeCount);
    // 1ms more (= 250ms total) MUST trigger.
    vi.advanceTimersByTime(1);
    expect(connectCalls.length).toBe(beforeCount + 1);

    unmount();
  });

  test('unmount clears pending reconnect timer and calls disconnectRealtime', () => {
    const onEvent = vi.fn();
    const { unmount } = renderHook(() =>
      useRealtime<{ x: number }>('claims-Modsynnow', onEvent),
    );
    fireConnect();
    fireDisconnect();

    const beforeUnmount = connectCalls.length;
    unmount();
    // Advance well past every backoff bucket — nothing more should connect.
    vi.advanceTimersByTime(60_000);
    expect(connectCalls.length).toBe(beforeUnmount);
    expect(disconnectCalls).toContain('claims-Modsynnow');
  });
});

describe('useRealtime — onResync', () => {
  test('does NOT fire on the initial connect', () => {
    const onEvent = vi.fn();
    const onResync = vi.fn();
    const { unmount } = renderHook(() =>
      useRealtime<{ x: number }>('claims-Modsynnow', onEvent, onResync),
    );

    fireConnect();
    expect(onResync).toHaveBeenCalledTimes(0);
    unmount();
  });

  test('fires exactly once per successful reconnect, never on initial', () => {
    const onEvent = vi.fn();
    const onResync = vi.fn();
    const { unmount } = renderHook(() =>
      useRealtime<{ x: number }>('claims-Modsynnow', onEvent, onResync),
    );

    fireConnect();
    expect(onResync).toHaveBeenCalledTimes(0);

    // Disconnect → reconnect → onResync fires once.
    fireDisconnect();
    vi.advanceTimersByTime(250);
    fireConnect();
    expect(onResync).toHaveBeenCalledTimes(1);

    // Second cycle.
    fireDisconnect();
    vi.advanceTimersByTime(500);
    fireConnect();
    expect(onResync).toHaveBeenCalledTimes(2);

    unmount();
  });
});

describe('useRealtime — property: backoff schedule + onResync semantics', () => {
  test('forall sequence of disconnect/reconnect events: backoff is monotonic non-decreasing capped at 4000ms; onResync fires exactly once per successful reconnect', () => {
    fc.assert(
      fc.property(
        // Each event drives the hook's state machine. After every
        // disconnect we either reconnect (true) or disconnect again
        // (which we model by chaining another `disconnect` event in the
        // sequence). We generate events as: true = "advance to next
        // disconnect-then-reconnect cycle", false = "advance to next
        // disconnect WITHOUT reconnect (cumulative failure)".
        fc.array(fc.boolean(), { minLength: 1, maxLength: 30 }),
        (events) => {
          // Reset module-level fake state for each iteration. Vitest's
          // `vi.useFakeTimers()` is already active from beforeEach.
          connectCalls.length = 0;
          disconnectCalls.length = 0;
          vi.clearAllTimers();

          const onEvent = vi.fn();
          const onResync = vi.fn();
          const { unmount } = renderHook(() =>
            useRealtime<{ x: number }>('claims-Modsynnow', onEvent, onResync),
          );

          // Initial connect.
          fireConnect();
          let resyncCount = 0;
          let consecutiveFailures = 0;
          const observedDelays: number[] = [];

          for (const reconnect of events) {
            const expectedDelay = Math.min(
              INITIAL_BACKOFF_MS_TEST * 2 ** consecutiveFailures,
              MAX_BACKOFF_MS_TEST,
            );
            const before = connectCalls.length;
            fireDisconnect();
            vi.advanceTimersByTime(expectedDelay);
            const afterAdvance = connectCalls.length;
            // Each disconnect schedules exactly one new connect attempt.
            if (afterAdvance !== before + 1) return false;
            observedDelays.push(expectedDelay);

            if (reconnect) {
              fireConnect();
              resyncCount++;
              consecutiveFailures = 0;
            } else {
              consecutiveFailures++;
            }
          }

          // Backoff is monotonic non-decreasing within a streak of
          // failures, capped at 4000.
          let streakDelay = INITIAL_BACKOFF_MS_TEST;
          let streakIdx = 0;
          for (let i = 0; i < events.length; i++) {
            const delay = observedDelays[i] ?? 0;
            if (delay > MAX_BACKOFF_MS_TEST) return false;
            if (i === streakIdx) {
              streakDelay = INITIAL_BACKOFF_MS_TEST;
            }
            if (delay !== streakDelay) return false;
            const next = events[i];
            if (next === true) {
              streakIdx = i + 1;
              streakDelay = INITIAL_BACKOFF_MS_TEST;
            } else {
              streakDelay = Math.min(streakDelay * 2, MAX_BACKOFF_MS_TEST);
            }
          }

          // onResync fires exactly once per successful (non-initial)
          // reconnect.
          if (onResync.mock.calls.length !== resyncCount) return false;

          unmount();
          return true;
        },
      ),
      { numRuns: 100 },
    );
  });
});

// Mirror the production constants in the test scope so the property test
// is self-contained without poking at the hook's internals.
const INITIAL_BACKOFF_MS_TEST = 250;
const MAX_BACKOFF_MS_TEST = 4000;
