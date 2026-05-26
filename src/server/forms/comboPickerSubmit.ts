/**
 * Combo-picker form-submit handler for ModSync (task 8.3b).
 *
 * Source of truth:
 *   - `.kiro/specs/modsync/design.md` "Combo Picker Flow" step 5 — drives
 *     the branch shape (foreign-claim soft-warning vs no-foreign-claim
 *     run-combo) and the soft-warning form payload (`data.kind: "combo"`
 *     so the soft-warning submit handler in 4.2b can route to the
 *     override path correctly).
 *   - `.kiro/specs/modsync/tasks.md` task 8.3b — pins the file path,
 *     export shape, dep injection contract, and the two PBT properties.
 *   - `.kiro/steering/02-modsync-architecture.md` "Soft Warning UX" /
 *     "Critical gotchas": `softWarningsShown` is incremented at
 *     form-show time (right here on the foreign-claim branch); the
 *     follow-up `collisionsDetected` and `redundantActionsAvoided`
 *     bumps live in 4.2b's submit handler.
 *
 * Reddit POSTs to this endpoint when a moderator picks a combo from
 * the `comboPickerForm` and clicks Run. The body shape is
 *   `{ values: { comboName }, data: { thingId } }`
 * where `comboName` is the value selected in the picker (carried
 * through `body.values`) and `thingId` is the original target Reddit
 * Thing piped through `body.data` from the menu handler in 8.3a.
 *
 * Algorithm (matches the user's prompt verbatim):
 *
 *   1. Resolve the current subreddit via `deps.getSub()`. Production
 *      closes over `context.subredditName`; tests inject a fixed
 *      string getter. The handler never imports `@devvit/web/server`
 *      so the unit harness stays pure.
 *
 *   2. Run the auth gate via `deps.auth({ sub })`. On `ForbiddenError`
 *      we short-circuit with `{ showToast: 'Forbidden' }`. Other
 *      errors bubble to Hono's default 500 path. Property 10 (auth
 *      gate has no side effects on throw) is preserved because we
 *      never call `combos` / `claims` / `executor` / `metrics` after
 *      a failed auth.
 *
 *   3. Load the combo: `deps.combos.listCombos(sub)` and find the
 *      `ComboSpec` whose `name === comboName`. If missing, return a
 *      `Combo not found` toast and stop. No claim write, no metric
 *      bump, no executor invocation.
 *
 *   4. Validate `thingId` shape. The select picker carries a generic
 *      string through `body.data.thingId`; we re-check the prefix
 *      (`t1_` or `t3_`) so a malformed payload doesn't reach the
 *      claims / executor layer. On mismatch, return
 *      `{ showToast: 'Invalid target' }` with no side effects.
 *
 *   5. Read the existing claim via `deps.claims.getClaim(sub,
 *      thingId)`. If a foreign moderator owns it
 *      (`existing.moderator !== user`):
 *        - `bumpMetric(sub, 'softWarning')` exactly once (Property 9
 *          counter routing — combo-flow form-shown branch).
 *        - return the soft-warning form with `data.kind: 'combo'`,
 *          `data.thingId`, and `data.comboName`. The soft-warning
 *          submit handler in 4.2b reads `data.kind` to route between
 *          claim-flow and combo-flow override paths; carrying
 *          `comboName` lets the override path re-resolve the combo
 *          and invoke the executor.
 *        - DO NOT write the claim and DO NOT invoke the executor.
 *
 *   6. Otherwise (no claim, or own claim — re-running your own
 *      already-claimed item is a refresh-and-go path) call
 *      `deps.claims.claim(sub, thingId, user)` to write the STRING +
 *      index entry and publish the `claim` event, then await
 *      `deps.executor.runCombo(thingId, combo, user, sub)`. The
 *      executor refreshes the claim before each step, dispatches each
 *      step against Reddit, appends the action entry to the feed,
 *      publishes the `action` event, and releases the claim.
 *      Return `{ showToast: 'Combo complete' }`.
 *
 * Soft-warning form fields (matches design.md "Soft Warning UX" and
 * the 4.2 claim handler's form verbatim):
 *   - `warningText` — disabled paragraph carrying the message
 *     `u/{moderator} is reviewing this — {ttlSec}s left.`. Display
 *     only; the submit handler does not consult this value.
 *   - `proceed` — boolean toggle (default `false`). The 4.2b submit
 *     endpoint reads `body.values.proceed` to route override vs cancel.
 *
 * Dep injection shape (`ComboPickerSubmitDeps`):
 *   - `auth`, `getSub` — same AuthFn / getSub seam used by the claim
 *     handler (4.2) and the metrics route (5.2).
 *   - `claims` — pre-bound to a `ClaimsDeps` (redis + realtime + clock)
 *     at register time; exposes only the 2 methods this handler needs
 *     (`getClaim`, `claim`).
 *   - `combos` — pre-bound to a `CombosDeps` (redis); exposes only
 *     `listCombos` (the picker rebuilds options on every menu
 *     invocation per the spec's 5-second-freshness clause, so we
 *     re-read combos here rather than caching).
 *   - `executor` — pre-bound to an `ExecutorDeps` (redis + realtime +
 *     reddit + clock); exposes only `runCombo`.
 *   - `metrics` — pre-bound `bumpMetric` over its own redis + clock.
 *     Same shape pattern.
 *
 * The actual softWarningForm submit handler (4.2b) is a sibling
 * concern; this file only constructs the form payload. The 4.2b
 * handler will inspect `data.kind` to decide which override path
 * (claim vs combo) to run.
 */

import type { Form, UiResponse } from "@devvit/web/shared";
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
 * Pre-bound claims surface. Exposes only the 2 methods this handler
 * uses. Production wiring closes over `ClaimsDeps` (redis + realtime +
 * clock) at register time. Tests curry the real `getClaim` / `claim`
 * over an in-memory fake.
 */
export interface ClaimsService {
  getClaim(
    sub: string,
    thingId: ThingId,
  ): Promise<(ClaimRecord & { ttlSec: number }) | null>;
  claim(sub: string, thingId: ThingId, mod: string): Promise<ClaimRecord>;
}

/**
 * Pre-bound combos surface. Only `listCombos` is required — the picker
 * rebuilds options on every menu invocation, so the submit handler
 * re-reads here rather than caching.
 */
export interface CombosService {
  listCombos(sub: string): Promise<ComboSpec[]>;
}

/**
 * Pre-bound executor surface. Production wiring closes over an
 * `ExecutorDeps` (redis + realtime + reddit + clock) once at register
 * time; tests curry the real `runCombo` over an in-memory fake harness.
 * The return value is the appended `ActionEntry` but this handler
 * doesn't consume it (the executor's audit + realtime side effects are
 * the contract).
 */
export interface ExecutorService {
  runCombo(
    thingId: ThingId,
    combo: ComboSpec,
    mod: string,
    sub: string,
  ): Promise<ActionEntry>;
}

/** Pre-bound metrics surface. Same shape as `routes/metrics.ts`. */
export interface MetricsService {
  bumpMetric(sub: string, kind: MetricKind): Promise<void>;
}

/** Injected dependencies. */
export interface ComboPickerSubmitDeps {
  auth: AuthFn;
  getSub: () => string;
  claims: ClaimsService;
  combos: CombosService;
  executor: ExecutorService;
  metrics: MetricsService;
}

/**
 * Build the soft-warning form returned when a foreign moderator owns
 * the active claim and the current moderator wants to run a combo on
 * the same Thing. Two fields per design.md "Soft Warning UX":
 *
 *   - `warningText` — disabled paragraph carrying the message.
 *     Read-only; the submit handler does not consult this value.
 *   - `proceed` — boolean toggle (default `false`). The submit handler
 *     reads `body.values.proceed` to route override vs cancel.
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
 * Body shape Reddit posts to `/internal/form/combo-picker-submit`.
 * Mirrors design.md "Combo Picker Flow" step 5: `body.values.comboName`
 * is the user's pick, `body.data.thingId` is piped through from the
 * picker's `data` envelope.
 */
export interface ComboPickerSubmitBody {
  values: { comboName: string };
  data: { thingId: string };
}

/**
 * Handle `POST /internal/form/combo-picker-submit`. See file-level
 * docstring for the full algorithm. Pure function — no Devvit globals
 * consulted.
 *
 * Returns a `UiResponse` for Reddit to render. One of:
 *   - `{ showToast: 'Forbidden' }` (auth failed)
 *   - `{ showToast: 'Combo not found' }` (combo missing)
 *   - `{ showToast: 'Invalid target' }` (thingId prefix bad)
 *   - `{ showForm: { name: 'softWarningForm', ... } }` (foreign claim)
 *   - `{ showToast: 'Combo complete' }` (combo ran end-to-end)
 */
export async function onComboPickerSubmit(
  body: ComboPickerSubmitBody,
  deps: ComboPickerSubmitDeps,
): Promise<UiResponse> {
  const sub = deps.getSub();

  // Step 1 — auth gate. ForbiddenError → toast; other throws bubble.
  let user: string;
  try {
    const result = await deps.auth({ sub });
    user = result.user;
  } catch (err) {
    if (
      err instanceof ForbiddenError ||
      (err instanceof Error && err.name === "ForbiddenError")
    ) {
      return { showToast: "Forbidden" };
    }
    throw err;
  }

  const comboName = body.values.comboName;
  const thingIdRaw = body.data.thingId;

  // Step 2 — look up combo by name. Picker is supposed to constrain
  // selections to live combos but we re-read here so a stale picker
  // (combo deleted between menu open and submit) cannot drive the
  // executor against a missing spec.
  const combos = await deps.combos.listCombos(sub);
  const combo = combos.find((c) => c.name === comboName);
  if (!combo) {
    return { showToast: "Combo not found" };
  }

  // Step 3 — validate thingId prefix. Defensive: real Devvit always
  // supplies a valid prefix, but we don't trust untyped strings.
  if (!thingIdRaw.startsWith("t1_") && !thingIdRaw.startsWith("t3_")) {
    return { showToast: "Invalid target" };
  }
  // Cast is safe: we just verified the prefix matches one of the two
  // shapes that make up `ThingId` (`t1_${string}` | `t3_${string}`).
  const thingId = thingIdRaw as ThingId;

  // Step 4 — foreign-claim check.
  const existing = await deps.claims.getClaim(sub, thingId);
  if (existing && existing.moderator !== user) {
    await deps.metrics.bumpMetric(sub, "softWarning");
    return {
      showForm: {
        name: "softWarningForm",
        form: buildSoftWarningForm(existing),
        data: { kind: "combo", thingId, comboName },
      },
    };
  }

  // Step 5 — no foreign claim. Write + publish via the storage layer,
  // then run the combo end-to-end. The executor refreshes the claim
  // before each step and releases it on completion or partial failure.
  await deps.claims.claim(sub, thingId, user);
  await deps.executor.runCombo(thingId, combo, user, sub);
  return { showToast: "Combo complete" };
}
