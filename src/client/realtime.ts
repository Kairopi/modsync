/**
 * `useRealtime` — React hook wrapping Devvit's `connectRealtime` primitive
 * with reconnection backoff and a resync hook for the consumer.
 *
 * Wraps `connectRealtime({ channel, onMessage, onConnect, onDisconnect })`
 * from `@devvit/web/client` (the SDK does NOT auto-reconnect — that
 * lifecycle is owned by this hook).
 *
 * Behaviour (per `tasks.md` task 6.2 + `design.md` "Realtime → Client"):
 *   - Mounts: open a connection on the supplied channel; track `connected`
 *     via state set by the SDK's `onConnect` / `onDisconnect` callbacks.
 *   - On disconnect: schedule a reconnect via `setTimeout` with the
 *     current backoff (`250ms → 500 → 1000 → 2000 → 4000`, capped at
 *     4000ms), then double the backoff for the next failure.
 *   - On a successful (non-initial) reconnect: reset backoff to 250ms AND
 *     invoke `onResync?.()` so the consumer can refetch `/api/claims` +
 *     `/api/feed` to converge with state that may have drifted while the
 *     socket was down. The initial connect does NOT trigger `onResync`.
 *   - Unmount: clear any pending reconnect timer and call
 *     `disconnectRealtime(channel)` to release the SDK-side handle.
 *
 * The hook keeps `onEvent` and `onResync` in refs so a parent re-render
 * passing fresh closures doesn't tear down the socket (the effect's only
 * dep is `channel`).
 *
 * Source of truth: `.kiro/specs/modsync/tasks.md` task 6.2,
 * `.kiro/steering/01-build-truth.md` "Client realtime hook".
 */
import { useEffect, useRef, useState } from 'react';
import type { JsonValue } from '@devvit/shared-types/json.js';

// `@devvit/web/client` re-exports `connectRealtime` / `disconnectRealtime`
// from `@devvit/realtime/client`. Both packages publish their browser
// bundle via the `"browser"` package export condition; without
// `customConditions: ["browser"]` set in `tsconfig.json` (which lives
// outside this task's authorized files), `tsc --build` resolves the
// `"default"` panic stub instead and reports the runtime symbols as
// missing exports. Vite (production bundle) and Vitest (test harness)
// both apply the `"browser"` condition, so they resolve the real
// implementation. We declare the surface locally so this single file
// type-checks without touching `tsconfig.json`.
type ConnectRealtimeOptions<Msg extends JsonValue> = {
  channel: string;
  onConnect?: (channel: string) => void;
  onDisconnect?: (channel: string) => void;
  onMessage: (data: Msg) => void;
};

type Connection = { disconnect: () => Promise<void> };

declare module '@devvit/web/client' {
  export function connectRealtime<Msg extends JsonValue>(
    opts: Readonly<ConnectRealtimeOptions<Msg>>,
  ): Connection;
  export function disconnectRealtime(channel: string): void;
  export function isRealtimeConnected(channel: string): boolean;
}

// The ambient `declare module` block above needs to come before the
// value import so tsc sees the augmented shape. ESLint's
// `import/first` rule would normally flag this; we don't have that
// plugin loaded in `eslint.config.js`, so we instead document the
// intentional import-after-declare pattern in a comment.
import { connectRealtime, disconnectRealtime } from '@devvit/web/client';

const INITIAL_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 4000;

export function useRealtime<T extends JsonValue>(
  channel: string,
  onEvent: (e: T) => void,
  onResync?: () => void,
): { connected: boolean } {
  const [connected, setConnected] = useState(false);

  // Refs so the latest callbacks are used inside the SDK's long-lived
  // closures without re-running the connect effect on every render.
  const onEventRef = useRef(onEvent);
  const onResyncRef = useRef(onResync);
  onEventRef.current = onEvent;
  onResyncRef.current = onResync;

  useEffect(() => {
    let cancelled = false;
    let backoff = INITIAL_BACKOFF_MS;
    let hasConnectedOnce = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const open = (): void => {
      if (cancelled) return;
      connectRealtime<T>({
        channel,
        onMessage: (msg) => {
          if (cancelled) return;
          onEventRef.current(msg);
        },
        onConnect: () => {
          if (cancelled) return;
          setConnected(true);
          if (hasConnectedOnce) {
            // Successful (non-initial) reconnect: reset backoff and
            // signal the consumer to refetch authoritative state.
            backoff = INITIAL_BACKOFF_MS;
            const resync = onResyncRef.current;
            if (resync !== undefined) resync();
          } else {
            hasConnectedOnce = true;
          }
        },
        onDisconnect: () => {
          if (cancelled) return;
          setConnected(false);
          const delay = backoff;
          backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
          timer = setTimeout(() => {
            timer = undefined;
            open();
          }, delay);
        },
      });
    };

    open();

    return () => {
      cancelled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      disconnectRealtime(channel);
    };
  }, [channel]);

  return { connected };
}
