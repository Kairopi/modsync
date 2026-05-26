/**
 * Combo execution engine for ModSync. Runs a `ComboSpec` step-by-step
 * against the Reddit API, refreshing the claim before each step so a
 * long-running combo cannot let the claim expire under the moderator's
 * feet, and recording the result (success or partial failure) in the
 * activity feed plus a realtime broadcast.
 *
 * Source of truth: `.kiro/specs/modsync/design.md` "Combo Execution
 * Engine" — the algorithm here is a faithful translation of the
 * pseudocode in that section. Two intentional refinements:
 *
 *   1. The design's pseudocode reaches for the global `redis` /
 *      `realtime` / `reddit` clients. ModSync's modules are
 *      dependency-injection-only (see claims.ts / feed.ts / realtime.ts
 *      and `01-build-truth.md` "Installed SDK API surface"). The
 *      executor takes an `ExecutorDeps` bag that production code
 *      constructs from `@devvit/web/server` clients and tests construct
 *      from in-memory fakes.
 *
 *   2. The design uses `redis.set ... ex: 90` directly to refresh the
 *      claim. Devvit-Web 0.12.24 takes `{ expiration: Date }`, not
 *      `{ ex }`. We delegate to `claims.refresh()` instead — same
 *      semantics, correct API, plus the realtime claim event fires for
 *      each refresh which lets clients observe the long-running combo's
 *      progress on the `claims-{sub}` channel.
 *
 * Storage / channels touched per `runCombo` call:
 *   - For each successful step: one `claim` set + one `claims-index`
 *     zAdd (via `claims.refresh`) and one realtime event on
 *     `claims-{sub}`. Plus the Reddit-side action via `deps.reddit`.
 *   - At the end: one `actions:{sub}` zAdd (via `feed.appendAction`),
 *     one realtime event on `actions-{sub}` (via
 *     `realtime.publishAction`), one `claims:{sub}:{thingId}` del, one
 *     `claims-index:{sub}` zRem, one realtime event on `claims-{sub}`
 *     (`type: "release"`, `reason: "completed"` or `"manual"`).
 *
 * Failure semantics:
 *   - The combo runs steps sequentially. The first step whose
 *     `dispatch` call throws (or whose preceding `refresh` throws)
 *     halts the loop. The action entry records `ranSteps` (everything
 *     up to but excluding the failed step), `failedStepIndex`, and
 *     `failureMessage`. The release uses `reason: "manual"` so the
 *     client can distinguish a partial failure from a clean completion.
 *   - The action entry is ALWAYS appended and published, regardless of
 *     success or partial failure — the audit trail is the source of
 *     truth for what the combo actually did.
 *   - The release ALWAYS happens, even on partial failure, so the
 *     foreign-claim path doesn't get permanently stuck on a Thing whose
 *     combo ran half-way and threw.
 */

import { ulid } from "ulid";

import {
  refresh as refreshClaim,
  release as releaseClaim,
  type ClaimsDeps,
} from "./claims";
import { appendAction, type FeedDeps } from "./feed";
import { publishAction, type RealtimeLike } from "./realtime";
import type {
  ActionEntry,
  ComboSpec,
  ComboStep,
  ThingId,
} from "../shared/types";

/** ModNote label enum, mirrored from `ComboStep` "MODNOTE" variant. */
type ModNoteLabel = NonNullable<
  Extract<ComboStep, { kind: "MODNOTE" }>["label"]
>;

/**
 * Reddit-side surface the executor uses. Production wires this to the
 * `reddit` client from `@devvit/web/server`; tests inject a recording
 * fake. Method names match the Devvit Reddit client's documented shape:
 * `remove`, `approve`, `lock`, `banUser`, `addModNote`.
 */
export interface RedditClient {
  remove(thingId: ThingId): Promise<void>;
  approve(thingId: ThingId): Promise<void>;
  lock(thingId: ThingId): Promise<void>;
  banUser(opts: {
    thingId: ThingId;
    days: number;
    reason: string;
    by: string;
  }): Promise<void>;
  addModNote(opts: {
    thingId: ThingId;
    text: string;
    label?: ModNoteLabel;
    by: string;
  }): Promise<void>;
}

/**
 * Injected dependencies for `runCombo`.
 *
 *   - `redis` — must satisfy both the `claims` module's RedisLike (for
 *     `refresh` / `release`) and the `feed` module's RedisLike (for
 *     `appendAction`). The intersection covers `get`, `set`, `del`,
 *     `zAdd`, `zRange`, `zRem`, `zRemRangeByRank`, `zScore`.
 *   - `realtime` — a single object with a `send(channel, msg)` method.
 *     Passed to `claims.refresh` / `claims.release` (which publish
 *     directly via the injected realtime to keep claim events tight)
 *     AND to `realtime.publishAction` (which uses the swallow-and-log
 *     wrapper from `src/server/realtime.ts`).
 *   - `reddit` — see `RedditClient` above.
 *   - `now` — clock injection for tests; defaults to `Date.now`.
 *   - `idGen` — id factory for tests; defaults to `ulid()`.
 */
export interface ExecutorDeps {
  redis: ClaimsDeps["redis"] & FeedDeps["redis"];
  realtime: RealtimeLike;
  reddit: RedditClient;
  now?: () => number;
  idGen?: () => string;
}

/**
 * Translate a single `ComboStep` into the matching Reddit-API call.
 * Throws bubble up to the `runCombo` loop, where they're recorded as a
 * partial failure.
 */
async function dispatch(
  step: ComboStep,
  thingId: ThingId,
  mod: string,
  reddit: RedditClient,
): Promise<void> {
  switch (step.kind) {
    case "REMOVE":
      return reddit.remove(thingId);
    case "APPROVE":
      return reddit.approve(thingId);
    case "LOCK":
      return reddit.lock(thingId);
    case "BAN":
      return reddit.banUser({
        thingId,
        days: step.days,
        reason: step.reason,
        by: mod,
      });
    case "MODNOTE": {
      // `exactOptionalPropertyTypes: true` forbids `label: undefined` —
      // construct the args without `label` when the step doesn't
      // specify one.
      if (step.label !== undefined) {
        return reddit.addModNote({
          thingId,
          text: step.text,
          label: step.label,
          by: mod,
        });
      }
      return reddit.addModNote({
        thingId,
        text: step.text,
        by: mod,
      });
    }
  }
}

/**
 * Run `combo` against `thingId` on behalf of `mod`. Returns the final
 * `ActionEntry` (success or partial failure) that was appended to the
 * feed and published on `actions-{sub}`.
 *
 * Step loop:
 *   1. Refresh the claim (resets TTL to 90s + publishes a `claim`
 *      event on `claims-{sub}` so subscribers can update their TTL
 *      countdown).
 *   2. Dispatch the step against Reddit.
 *   3. If both succeed, append to `ranSteps` and continue.
 *   4. If either throws, record `failedStepIndex` + `failureMessage`
 *      and break out of the loop.
 *
 * After the loop:
 *   1. Build the `ActionEntry` (omitting `failedStepIndex` /
 *      `failureMessage` when the combo completed cleanly — required by
 *      `exactOptionalPropertyTypes`).
 *   2. Append it to `actions:{sub}` via `feed.appendAction`.
 *   3. Publish a single `action` event on `actions-{sub}` via
 *      `realtime.publishAction` (swallow-and-log wrapper).
 *   4. Release the claim with `reason: "completed"` on a clean run or
 *      `reason: "manual"` on partial failure.
 */
export async function runCombo(
  thingId: ThingId,
  combo: ComboSpec,
  mod: string,
  sub: string,
  deps: ExecutorDeps,
): Promise<ActionEntry> {
  const now = deps.now ?? Date.now;
  const idGen = deps.idGen ?? ulid;

  // Bundle the per-module deps once. `claimsDeps.realtime` accepts the
  // wider `RealtimeLike` (msg: unknown) via parameter bivariance — the
  // claims module declares `msg: RealtimeEvent` but a function whose
  // parameter is `unknown` is structurally compatible at the
  // assignment site under method-shorthand bivariance.
  const claimsDeps: ClaimsDeps = {
    redis: deps.redis,
    realtime: deps.realtime,
    now,
  };
  const feedDeps: FeedDeps = { redis: deps.redis };

  const ranSteps: ComboStep[] = [];
  let failedIndex: number | undefined;
  let failureMessage: string | undefined;

  for (let i = 0; i < combo.steps.length; i++) {
    const step = combo.steps[i];
    // `noUncheckedIndexedAccess: true` makes `combo.steps[i]` `T | undefined`.
    // The validator (task 8.1) ensures `combo.steps.length >= 1` and every
    // index is populated, so this branch is unreachable in production;
    // belt-and-suspenders to keep the type narrowing honest.
    if (step === undefined) break;

    try {
      await refreshClaim(sub, thingId, mod, claimsDeps);
      await dispatch(step, thingId, mod, deps.reddit);
      ranSteps.push(step);
    } catch (err) {
      failedIndex = i;
      const maybeMsg = (err as { message?: unknown } | null | undefined)
        ?.message;
      failureMessage = String(maybeMsg ?? err);
      break;
    }
  }

  const entry: ActionEntry = {
    id: idGen(),
    ts: now(),
    moderator: mod,
    thingId,
    comboName: combo.name,
    ranSteps,
  };
  if (failedIndex !== undefined) {
    entry.failedStepIndex = failedIndex;
  }
  if (failureMessage !== undefined) {
    entry.failureMessage = failureMessage;
  }

  await appendAction(sub, entry, feedDeps);
  await publishAction(deps.realtime, sub, { type: "action", entry });

  await releaseClaim(
    sub,
    thingId,
    failedIndex === undefined ? "completed" : "manual",
    mod,
    claimsDeps,
  );

  return entry;
}
