/**
 * Soft-warning form submit handler for ModSync (task 4.2b). The
 * receiver for the `softWarningForm` declared in `devvit.json`. Reddit
 * posts the form's submitted values plus the original action-context
 * `data` payload to `/internal/form/soft-warning-submit`.
 *
 * Source of truth:
 *   - `.kiro/specs/modsync/design.md` "Soft Warning UX" — locks the
 *     form shape (`{ proceed: boolean }`), the data payload (`{ kind,
 *     thingId, comboName? }`), and the three-way routing semantics
 *     (collision override on proceed=true, redundant-avoided on
 *     proceed=false).
 *   - `.kiro/specs/modsync/tasks.md` task 4.2b — pins the file path,
 *     export shape, dep-injection contract, and the two PBT
 *     properties.
 *   - `.kiro/steering/02-modsync-architecture.md` "Critical gotchas"
 *     — `softWarningsShown` is incremented at form-SHOW time (in 4.2
 *     for the claim flow / 8.3a for the combo-picker flow), NEVER
 *     here. `collisionsDetected` and `redundantActionsAvoided` are
 *     mutually exclusive and incremented exactly once per submit.
 *
 * Three branches (locked routing per design.md "Soft Warning UX"
 * flow steps 5 + 6):
 *
 *   proceed === false  (Cancel / Submit-without-toggling)
 *     1. `bumpMetric(sub, 'redundantAvoided')` — exactly one HINCRBY
 *        against `redundantActionsAvoided`.
 *     2. NO claim write, NO realtime publish, NO combo run.
 *     3. Return `{ showToast: 'Cancelled' }`.
 *
 *   proceed === true  AND  kind === 'claim'  (Claim override)
 *     1. `bumpMetric(sub, 'collision')` — exactly one HINCRBY against
 *        `collisionsDetected`.
 *     2. `claims.claim(sub, thingId, user)` — writes the claim STRING
 *        + index entry AND publishes a `claim` realtime event in one
 *        call.
 *     3. Return `{ showToast: 'Claimed (override)' }`.
 *
 *   proceed === true  AND  kind === 'combo'  (Combo override)
 *     1. `bumpMetric(sub, 'collision')` — same single HINCRBY.
 *     2. `combos.listCombos(sub)` to look up the named combo. If the
 *        name is missing or no combo with that name exists, return
 *        `{ showToast: 'Combo not found' }` WITHOUT writing the claim
 *        and WITHOUT calling the executor (the collision bump
 *        already happened — that's per spec; the moderator did
 *        signal intent to override even though the combo was gone).
 *     3. `claims.claim(sub, thingId, user)` — write the override
 *        claim, publish on `claims-{sub}`.
 *     4. `executor.runCombo(thingId, combo, user, sub)` — runs the
 *        combo end-to-end (sequential steps, refresh between each,
 *        appendAction + publishAction at the tail, release at the
 *        end). The executor owns its own realtime publishes against
 *        `actions-{sub}`; this handler does NOT republish.
 *     5. Return `{ showToast: 'Combo complete' }`.
 *
 * Auth gate
 * ---------
 * `requireMod` runs first via the injected `auth` callable, exactly
 * like the claim-menu handler in 4.2. On `ForbiddenError` we return
 * `{ showToast: 'Forbidden' }` (Devvit form submits cannot return
 * HTTP statuses to the client — the response shape is `UiResponse`
 * and the only way to surface "you can't do this" is via
 * `showToast`). Property 10 is preserved: ZERO downstream calls
 * happen on the throw path — no metric bump, no claim write, no
 * combo lookup, no runCombo, no publish.
 *
 * Dep-injection seam
 * ------------------
 * The handler imports nothing from `@devvit/web/server`. Production
 * wiring at the route boundary closes over a per-request `redis` /
 * `realtime` / `reddit` triple plus the calendar clock and constructs
 * `claims` / `combos` / `executor` / `metrics` services curried over
 * those deps. Tests inject in-memory fakes plus recording wrappers
 * for `executor.runCombo`. This is the same pattern as
 * `src/server/menu/claimHandler.ts` and the various
 * `src/server/routes/*` modules.
 */

import type { UiResponse } from "@devvit/web/shared";
import { ForbiddenError } from "../auth.js";
import type {
  ActionEntry,
  ClaimRecord,
  ComboSpec,
  ThingId,
} from "../../shared/types.js";
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
 * Pre-bound claims surface. Production closes over a `ClaimsDeps`
 * (redis + realtime + clock); tests inject the real `claim()` curried
 * over an in-memory fake.
 */
export interface ClaimsService {
  claim(sub: string, thingId: ThingId, mod: string): Promise<ClaimRecord>;
}

/** Pre-bound combos surface. We only need `listCombos` here. */
export interface CombosService {
  listCombos(sub: string): Promise<ComboSpec[]>;
}

/**
 * Pre-bound executor surface. The 4-arg shape mirrors `runCombo` from
 * `../executor.ts` minus the deps bag (which production wiring closes
 * over at register time). Tests inject a recording fake whose body
 * pushes the call args into an array — the soft-warning handler is
 * not the system under test for the combo execution semantics; that's
 * `tests/executor.spec.ts`.
 */
export interface ExecutorService {
  runCombo(
    thingId: ThingId,
    combo: ComboSpec,
    mod: string,
    sub: string,
  ): Promise<ActionEntry>;
}

/** Pre-bound metrics surface. Same shape as the metrics route's wrapper. */
export interface MetricsService {
  bumpMetric(sub: string, kind: MetricKind): Promise<void>;
}

/** Injected dependencies. */
export interface SoftWarningDeps {
  auth: AuthFn;
  getSub: () => string;
  claims: ClaimsService;
  combos: CombosService;
  executor: ExecutorService;
  metrics: MetricsService;
}

/**
 * Form submit body shape. Devvit form submits arrive as
 * `{ values, data }` where `values` is the user-submitted field map
 * (typed by the `Form` declaration) and `data` is the
 * action-context envelope passed by the menu/picker handler that
 * originally returned the form. See design.md "Soft Warning UX" form
 * definition for the canonical field set.
 */
export interface SoftWarningSubmitBody {
  values: { proceed: boolean };
  data: { kind: "claim" | "combo"; thingId: string; comboName?: string };
}

/**
 * Handle `POST /internal/form/soft-warning-submit`. See file-level
 * docstring for the full algorithm. Pure function — no Devvit globals
 * consulted.
 */
export async function onSoftWarningSubmit(
  body: SoftWarningSubmitBody,
  deps: SoftWarningDeps,
): Promise<UiResponse> {
  const sub = deps.getSub();

  // Auth gate. ForbiddenError → Forbidden toast; other throws bubble
  // to Hono's default 500 handler.
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

  const { values, data } = body;
  const { kind, thingId: rawThingId, comboName } = data;
  const proceed = values.proceed;
  // The thingId envelope comes from the menu/picker handler that
  // originally returned the soft-warning form. Those handlers already
  // validated the prefix matched the location, so we trust the cast
  // here. (`ThingId = `t1_${string}` | `t3_${string}``.)
  const thingId = rawThingId as ThingId;

  // Cancel branch — short-circuits before any combo lookup or claim
  // write. softWarningsShown was already bumped at form-show time;
  // here we record the moderator's "I see, never mind" signal.
  if (proceed === false) {
    await deps.metrics.bumpMetric(sub, "redundantAvoided");
    return { showToast: "Cancelled" };
  }

  // Override branch — the moderator chose to claim despite the
  // foreign claim. Bump the collision counter FIRST (per design.md
  // flow step 5) so even a "combo not found" tail still records the
  // override intent.
  await deps.metrics.bumpMetric(sub, "collision");

  if (kind === "claim") {
    await deps.claims.claim(sub, thingId, user);
    return { showToast: "Claimed (override)" };
  }

  // kind === "combo"
  if (comboName === undefined) {
    return { showToast: "Combo not found" };
  }
  const combos = await deps.combos.listCombos(sub);
  const combo = combos.find((c) => c.name === comboName);
  if (combo === undefined) {
    return { showToast: "Combo not found" };
  }

  await deps.claims.claim(sub, thingId, user);
  await deps.executor.runCombo(thingId, combo, user, sub);
  return { showToast: "Combo complete" };
}
