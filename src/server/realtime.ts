/**
 * Realtime publish layer for ModSync. This module is a thin server-side
 * wrapper over Devvit's `realtime.send(channel, msg)` primitive (see
 * `.kiro/steering/01-build-truth.md` "Installed SDK API surface" — the
 * underlying primitive is `realtime.send`, NOT a `publish` method).
 *
 * Channel naming
 * --------------
 * Devvit Realtime forbids `:` in channel names. ModSync uses two
 * per-install channels, both with hyphens:
 *   - `claims-{sub}`  — `claim` and `release` events
 *   - `actions-{sub}` — `action` events (combo runs)
 *
 * Helper exports `claimsChannel(sub)` and `actionsChannel(sub)` are the
 * single source of truth for these names. The CLIENT subscribes via
 * `connectRealtime({ channel })` (see `.kiro/steering/01-build-truth.md`
 * "Client" section) — there is no server-side subscribe primitive in
 * Devvit Web, which is why this file only exports publish wrappers and
 * channel-name helpers, not subscribe wrappers.
 *
 * Failure handling
 * ----------------
 * The publish wrappers swallow + log errors. Realtime is a best-effort
 * broadcast layer; the canonical state lives in Redis (see `claims.ts`
 * and `feed.ts`). Clients reconcile via the next `/api/claims` /
 * `/api/feed` refetch on reconnect — see the on-resync semantics in
 * `connectRealtime` (task 6.2). Letting a publish failure bubble up
 * would otherwise abort the calling handler AFTER the Redis write has
 * already committed, leaving the persisted state correct but the HTTP
 * response 500 — strictly worse for the moderator.
 */

import type { RealtimeEvent } from "../shared/types";

/**
 * Devvit's Realtime primitive accepts any JSON-serializable value. We
 * mirror that via `unknown` rather than pulling a `JsonValue` type from
 * `@devvit/shared` so this module has zero runtime imports beyond the
 * shared types file. Tests inject a recording fake with the same shape.
 */
export interface RealtimeLike {
  send(channel: string, msg: unknown): Promise<void>;
}

/** Channel name for claim/release broadcasts. Hyphens are mandatory. */
export function claimsChannel(sub: string): string {
  return `claims-${sub}`;
}

/** Channel name for combo-action broadcasts. Hyphens are mandatory. */
export function actionsChannel(sub: string): string {
  return `actions-${sub}`;
}

/**
 * Publish a `claim` or `release` event on `claims-{sub}`. Fire-and-
 * forget: any error from `realtime.send` is logged and swallowed so the
 * caller's Redis-write side effect (already committed before publish)
 * is not retroactively aborted.
 */
export async function publishClaim(
  realtime: RealtimeLike,
  sub: string,
  event: RealtimeEvent,
): Promise<void> {
  try {
    await realtime.send(claimsChannel(sub), event);
  } catch (err) {
    console.error(
      `[realtime] publishClaim failed for sub="${sub}":`,
      err,
    );
  }
}

/**
 * Publish an `action` event on `actions-{sub}`. Same swallow-and-log
 * semantics as `publishClaim`.
 */
export async function publishAction(
  realtime: RealtimeLike,
  sub: string,
  event: RealtimeEvent,
): Promise<void> {
  try {
    await realtime.send(actionsChannel(sub), event);
  } catch (err) {
    console.error(
      `[realtime] publishAction failed for sub="${sub}":`,
      err,
    );
  }
}
