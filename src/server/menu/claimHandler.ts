/**
 * Claim menu handler for ModSync (task 4.2).
 *
 * Source of truth:
 *   - `.kiro/specs/modsync/design.md` "Claim handler algorithm" — drives
 *     the branch shape (foreign-claim vs no-claim) and the soft-warning
 *     form payload.
 *   - `.kiro/specs/modsync/tasks.md` task 4.2 — pins the file path,
 *     export shape, dep injection contract, and the two PBT properties.
 *   - `.kiro/steering/02-modsync-architecture.md` "Soft Warning UX" /
 *     "Critical gotchas": `softWarningsShown` is incremented at
 *     form-show time (right here); `collisionsDetected` and
 *     `redundantActionsAvoided` are bumped by the form-submit handler
 *     (4.2b), NEVER from this file.
 *
 * Algorithm:
 *
 *   1. Resolve the current subreddit name via `deps.getSub()` (production
 *      closes over `context.subredditName`; tests inject a fixed string
 *      getter). The handler never imports `@devvit/web/server` — that
 *      keeps the unit harness pure.
 *
 *   2. Run the auth gate via `deps.auth({ sub })`. On `ForbiddenError`
 *      we short-circuit with `{ showToast: 'Forbidden' }` (Devvit menu
 *      handlers cannot return HTTP statuses, so the error surface is a
 *      neutral toast). Other errors bubble to Hono's default 500 path.
 *      Property 10 (auth gate has no side effects on throw) is preserved
 *      because we never call `claims` / `metrics` after a failed auth.
 *
 *   3. Branch on `body.location`:
 *        - 'subreddit' → claim doesn't apply to subreddits; return a
 *          toast and stop. No metric bump, no claim write.
 *        - 'post' → expect `body.targetId` to start with `t3_`.
 *        - 'comment' → expect `body.targetId` to start with `t1_`.
 *      A mismatched prefix returns `{ showToast: 'Invalid target' }`
 *      with no side effects (defensive — Devvit always supplies the
 *      right prefix in practice but we don't trust untyped strings).
 *
 *   4. Read the existing claim via `deps.claims.getClaim(sub, thingId)`.
 *      If a foreign moderator owns it (`existing.moderator !== user`):
 *        - `bumpMetric(sub, 'softWarning')` exactly once. This is the
 *          ONLY place where `softWarningsShown` is incremented for the
 *          claim flow (the combo flow's equivalent bump lives in
 *          8.3a).
 *        - return `UiResponse { showForm: { name: 'softWarningForm',
 *          form: { fields: [warningText, proceed], acceptLabel:
 *          'Submit', cancelLabel: 'Cancel' }, data: { kind: 'claim',
 *          thingId } } }`. Do NOT write the claim and do NOT publish.
 *
 *   5. Otherwise (no claim, or own claim — refresh is the right thing
 *      to do on re-claim by the same mod, and `claim()` is idempotent
 *      on the moderator field) call `deps.claims.claim(sub, thingId,
 *      user)`. That writes the STRING + index entry and publishes the
 *      `claim` realtime event in one call. Return `{ showToast:
 *      'Claimed' }`.
 *
 * Soft-warning form fields (matches design.md "Soft Warning UX"):
 *   - `warningText` — disabled paragraph carrying the message
 *     `u/{moderator} is reviewing this — {ttlSec}s left.` so the
 *     moderator sees who has the lock and how long they have. The
 *     submit handler doesn't read this field; it's display-only.
 *   - `proceed` — boolean toggle (default false). The submit endpoint
 *     in 4.2b reads `body.values.proceed` and routes to either the
 *     override path (HINCRBY collisionsDetected, write claim, publish)
 *     or the cancel path (HINCRBY redundantActionsAvoided).
 *
 * Dep injection shape (`ClaimHandlerDeps`):
 *   - `auth`, `getSub` — same AuthFn / getSub seam used by the metrics
 *     route (5.2). Tests inject a `vi.fn()`.
 *   - `claims` — pre-bound to a `ClaimsDeps` (redis + realtime + clock)
 *     at register time so the handler doesn't have to thread those
 *     dependencies through. Mirrors the `MetricsService` shape from
 *     `routes/metrics.ts`.
 *   - `metrics` — pre-bound `bumpMetric` over its own redis + clock.
 *     Same shape pattern.
 *
 * The form-submit handler (4.2b) lives in a sibling file and is the
 * place where `release` / `runCombo` get wired — those are NOT
 * dependencies of this handler.
 */

import type { MenuItemRequest, UiResponse, Form } from "@devvit/web/shared";
import { ForbiddenError } from "../auth.js";
import type { ClaimRecord, ThingId } from "../../shared/types.js";
import type { MetricKind } from "../metrics.js";

/**
 * Auth callable shape — mimics `requireMod` from `../auth.ts`.
 * Production wiring uses `(ctx) => requireMod(ctx, { redis, reddit })`.
 * Tests inject a `vi.fn()`.
 */
export type AuthFn = (ctx: {
  sub: string;
}) => Promise<{ user: string; sub: string }>;

/**
 * Pre-bound claims surface. Production wiring closes over a
 * `ClaimsDeps` (redis + realtime + clock) at register time. Tests
 * inject the real `getClaim` / `claim` curried over an in-memory fake.
 */
export interface ClaimsService {
  getClaim(
    sub: string,
    thingId: ThingId,
  ): Promise<(ClaimRecord & { ttlSec: number }) | null>;
  claim(sub: string, thingId: ThingId, mod: string): Promise<ClaimRecord>;
}

/** Pre-bound metrics surface. Same shape as the metrics route's wrapper. */
export interface MetricsService {
  bumpMetric(sub: string, kind: MetricKind): Promise<void>;
}

/** Injected dependencies. */
export interface ClaimHandlerDeps {
  auth: AuthFn;
  getSub: () => string;
  claims: ClaimsService;
  metrics: MetricsService;
}

/**
 * Build the soft-warning form returned when a foreign moderator owns
 * the active claim. Two fields per design.md "Soft Warning UX":
 *
 *   - `warningText` — disabled paragraph carrying the message.
 *     Read-only; the submit handler does not consult this value.
 *   - `proceed` — boolean toggle (default `false`). The submit handler
 *     reads `body.values.proceed` to route to override vs cancel.
 *
 * `acceptLabel: 'Submit'`, `cancelLabel: 'Cancel'` — Cancel dismisses
 * the form without invoking the submit endpoint, so the cancel path's
 * counter (`redundantActionsAvoided`) only increments when the
 * moderator clicks Submit with `proceed === false`.
 */
function buildSoftWarningForm(
  existing: ClaimRecord & { ttlSec: number },
): Form {
  return {
    fields: [
      {
        type: "paragraph",
        name: "warningText",
        label: `u/${existing.moderator} is reviewing this — ${existing.ttlSec}s left.`,
        disabled: true,
      },
      {
        type: "boolean",
        name: "proceed",
        label: "Proceed despite teammate's claim?",
        defaultValue: false,
      },
    ],
    acceptLabel: "Submit",
    cancelLabel: "Cancel",
  };
}

/**
 * Handle `POST /internal/menu/claim`. See file-level docstring for the
 * full algorithm. Pure function — no Devvit globals consulted.
 *
 * Returns a `UiResponse` for Reddit to render. Either:
 *   - `{ showToast: 'Forbidden' }` (auth failed)
 *   - `{ showToast: '...' }` (location/prefix invalid)
 *   - `{ showForm: { name: 'softWarningForm', ... } }` (foreign claim)
 *   - `{ showToast: 'Claimed' }` (claim acquired)
 */
export async function onClaimMenu(
  body: MenuItemRequest,
  deps: ClaimHandlerDeps,
): Promise<UiResponse> {
  const sub = deps.getSub();

  // Step 2 — auth gate. ForbiddenError → toast; other throws bubble.
  let user: string;
  try {
    const result = await deps.auth({ sub });
    user = result.user;
  } catch (err) {
    if (
      err instanceof ForbiddenError ||
      (err instanceof Error && err.name === "ForbiddenError")
    ) {
      return { showToast: { text: "Forbidden", appearance: "neutral" } };
    }
    throw err;
  }

  // Step 3 — validate target by location. Subreddit-scope claims are
  // out of contract (the menu items still appear on `subreddit` per
  // devvit.json, but the claim subsystem only models posts / comments).
  if (body.location === "subreddit") {
    return {
      showToast: {
        text: "Claim doesn't apply to subreddits",
        appearance: "neutral",
      },
    };
  }
  const expectedPrefix = body.location === "post" ? "t3_" : "t1_";
  if (!body.targetId.startsWith(expectedPrefix)) {
    return { showToast: "Invalid target" };
  }
  // Cast is safe: we just verified the prefix matches one of the two
  // shapes that make up `ThingId` (`t1_${string}` | `t3_${string}`).
  const thingId = body.targetId as ThingId;

  // Step 4 — foreign-claim check.
  const existing = await deps.claims.getClaim(sub, thingId);
  if (existing && existing.moderator !== user) {
    await deps.metrics.bumpMetric(sub, "softWarning");
    return {
      showForm: {
        name: "softWarningForm",
        form: buildSoftWarningForm(existing),
        data: { kind: "claim", thingId },
      },
    };
  }

  // Step 5 — no foreign claim. Write + publish via the storage layer.
  await deps.claims.claim(sub, thingId, user);
  return { showToast: { text: "Claimed", appearance: "success" } };
}
