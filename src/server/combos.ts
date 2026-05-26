/**
 * Combos module for ModSync. Owns the validator + CRUD primitives that
 * back the `/api/combos` route (task 8.2), the combo picker menu
 * (task 8.3a), and the combo editor form (task 8.5). See
 * `.kiro/specs/modsync/design.md` "Combo Picker Flow" / "Combo Editor"
 * and `tasks.md` task 8.1 for the validator's exact rules.
 *
 * Storage shape (per-install, per `02-modsync-architecture.md`):
 *   - `combos:{sub}` — HASH, field = combo name, value = JSON `ComboSpec`.
 *     No TTL. Cap of `MAX_COMBOS` (50) total combos per install enforced
 *     here on every `saveCombo` create path.
 *
 * Validator philosophy:
 *   - Pure function (`validateCombo`) — no Redis, no I/O. Returns
 *     `{ ok: true, value }` with a clean coerced `ComboSpec` (extra
 *     fields stripped, optional `description` / MODNOTE `label` only
 *     present when set), or `{ ok: false, message }` with the FIRST
 *     validation failure encountered.
 *   - Order of checks: object → `name` (string + regex + uniqueness) →
 *     `steps` (array + size) → each step in order → optional
 *     `description`.
 *   - Inside a step the order is kind → kind-specific fields.
 *
 * Dependency injection:
 *   - `saveCombo` / `deleteCombo` / `listCombos` accept `{ redis }`. The
 *     module never imports `@devvit/web/server`. Tests inject the
 *     in-memory fake from `tests/_fakes/redisFake.ts`.
 *
 * Failure semantics:
 *   - `saveCombo` does NOT have a transaction — we read, validate,
 *     check the cap, then write. A concurrent writer could theoretically
 *     bypass the cap by 1 if two creates race. Acceptable for ModSync
 *     scale (per-sub combos, manually edited by mods); the route
 *     handler in 8.2 is the only writer in production.
 */

import {
  COMBO_NAME_REGEX,
  MAX_COMBOS,
  type ComboSpec,
  type ComboStep,
} from "../shared/types";
import { combosKey } from "./redisKeys";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Discriminated result shape returned by `validateCombo`. */
export type ValidationResult =
  | { ok: true; value: ComboSpec }
  | { ok: false; message: string };

/**
 * Minimal Redis surface this module uses. Tracks Devvit-Web 0.12.24 per
 * `01-build-truth.md`. The in-memory fake structurally satisfies it.
 */
export interface RedisLike {
  hGetAll(key: string): Promise<Record<string, string>>;
  hSet(key: string, fieldValues: Record<string, string>): Promise<number>;
  hDel(key: string, fields: string[]): Promise<number>;
}

/** Injected dependencies for the persistence helpers. */
export interface CombosDeps {
  redis: RedisLike;
}

// ---------------------------------------------------------------------------
// Validation constants — locked by task 8.1 + design.md
// ---------------------------------------------------------------------------

const STEP_KINDS = ["REMOVE", "LOCK", "BAN", "MODNOTE", "APPROVE"] as const;

const MODNOTE_LABELS = [
  "ABUSE_WARNING",
  "SPAM_WARNING",
  "HELPFUL_USER",
  "OTHER",
] as const;
type ModNoteLabel = (typeof MODNOTE_LABELS)[number];

/** `steps.length` must satisfy `1 <= length <= MAX_STEPS`. */
const MAX_STEPS = 10;
const MIN_STEPS = 1;

/** MODNOTE.text length cap. */
const MAX_MODNOTE_TEXT_LEN = 1000;

/** BAN.days inclusive bounds. */
const MIN_BAN_DAYS = 0;
const MAX_BAN_DAYS = 999;

// ---------------------------------------------------------------------------
// Internal predicates
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isInteger(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n);
}

// ---------------------------------------------------------------------------
// Step validation
// ---------------------------------------------------------------------------

type StepValidationResult =
  | { ok: true; value: ComboStep }
  | { ok: false; message: string };

function validateStep(step: unknown, index: number): StepValidationResult {
  if (!isPlainObject(step)) {
    return { ok: false, message: `Step ${index} is not an object` };
  }
  const kind = step["kind"];
  if (typeof kind !== "string") {
    return {
      ok: false,
      message: `Step ${index} has missing or non-string "kind"`,
    };
  }
  if (!(STEP_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, message: `Step ${index} has invalid kind "${kind}"` };
  }

  switch (kind) {
    case "REMOVE":
      return { ok: true, value: { kind: "REMOVE" } };
    case "LOCK":
      return { ok: true, value: { kind: "LOCK" } };
    case "APPROVE":
      return { ok: true, value: { kind: "APPROVE" } };
    case "BAN": {
      const days = step["days"];
      const reason = step["reason"];
      if (!isInteger(days)) {
        return {
          ok: false,
          message: `Step ${index} (BAN) "days" must be an integer`,
        };
      }
      if (days < MIN_BAN_DAYS || days > MAX_BAN_DAYS) {
        return {
          ok: false,
          message: `Step ${index} (BAN) "days" must be in [${MIN_BAN_DAYS}, ${MAX_BAN_DAYS}]`,
        };
      }
      if (typeof reason !== "string") {
        return {
          ok: false,
          message: `Step ${index} (BAN) "reason" must be a string`,
        };
      }
      return { ok: true, value: { kind: "BAN", days, reason } };
    }
    case "MODNOTE": {
      const text = step["text"];
      if (typeof text !== "string") {
        return {
          ok: false,
          message: `Step ${index} (MODNOTE) "text" must be a string`,
        };
      }
      if (text.length > MAX_MODNOTE_TEXT_LEN) {
        return {
          ok: false,
          message: `Step ${index} (MODNOTE) "text" exceeds ${MAX_MODNOTE_TEXT_LEN} chars`,
        };
      }
      // Optional `label` — only include in the coerced output if present.
      // `exactOptionalPropertyTypes: true` forbids `label: undefined`.
      const labelRaw = step["label"];
      if (labelRaw === undefined) {
        return { ok: true, value: { kind: "MODNOTE", text } };
      }
      if (typeof labelRaw !== "string") {
        return {
          ok: false,
          message: `Step ${index} (MODNOTE) "label" must be a string`,
        };
      }
      if (!(MODNOTE_LABELS as readonly string[]).includes(labelRaw)) {
        return {
          ok: false,
          message: `Step ${index} (MODNOTE) "label" must be one of ${MODNOTE_LABELS.join(", ")}`,
        };
      }
      return {
        ok: true,
        value: { kind: "MODNOTE", text, label: labelRaw as ModNoteLabel },
      };
    }
    default:
      // Unreachable given the includes() check above, but the type
      // system can't narrow `kind` against a runtime array.
      return { ok: false, message: `Step ${index} has invalid kind` };
  }
}

// ---------------------------------------------------------------------------
// Public API: validator
// ---------------------------------------------------------------------------

/**
 * Pure validator for a candidate `ComboSpec`. Returns the FIRST error
 * encountered or a coerced clean spec on success.
 *
 * `existingNames` is the list of combo names already taken in the
 * subreddit MINUS the name being updated (callers in the route /
 * `saveCombo` are responsible for that filter so an UPDATE is allowed
 * to re-use its own name).
 */
export function validateCombo(
  spec: unknown,
  existingNames: string[],
): ValidationResult {
  if (!isPlainObject(spec)) {
    return { ok: false, message: "Combo must be an object" };
  }

  const name = spec["name"];
  if (typeof name !== "string") {
    return { ok: false, message: 'Combo "name" must be a string' };
  }
  if (!COMBO_NAME_REGEX.test(name)) {
    return {
      ok: false,
      message: `Combo "name" must be 1-40 chars from [a-z0-9-_ ] (case-insensitive)`,
    };
  }
  if (existingNames.includes(name)) {
    return { ok: false, message: `Combo "${name}" already exists` };
  }

  const stepsRaw = spec["steps"];
  if (!Array.isArray(stepsRaw)) {
    return { ok: false, message: 'Combo "steps" must be an array' };
  }
  if (stepsRaw.length < MIN_STEPS) {
    return { ok: false, message: `Combo must have at least ${MIN_STEPS} step` };
  }
  if (stepsRaw.length > MAX_STEPS) {
    return {
      ok: false,
      message: `Combo must have at most ${MAX_STEPS} steps`,
    };
  }

  const steps: ComboStep[] = [];
  for (let i = 0; i < stepsRaw.length; i++) {
    const result = validateStep(stepsRaw[i], i);
    if (!result.ok) return result;
    steps.push(result.value);
  }

  // Optional `description`. `exactOptionalPropertyTypes: true` means we
  // construct the output object conditionally rather than passing
  // `description: undefined`.
  const descriptionRaw = spec["description"];
  if (descriptionRaw !== undefined && typeof descriptionRaw !== "string") {
    return { ok: false, message: 'Combo "description" must be a string' };
  }

  const value: ComboSpec =
    typeof descriptionRaw === "string"
      ? { name, steps, description: descriptionRaw }
      : { name, steps };

  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// Public API: persistence
// ---------------------------------------------------------------------------

/**
 * Read every combo for `sub` from the HASH. Skips entries whose JSON
 * fails to parse (defensive — would never happen against our own
 * writers, but `hGetAll` could theoretically return manually-injected
 * garbage). Order of returned entries matches the HASH iteration order
 * from the underlying Redis fake / Devvit Redis.
 */
export async function listCombos(
  sub: string,
  deps: CombosDeps,
): Promise<ComboSpec[]> {
  const all = await deps.redis.hGetAll(combosKey(sub));
  const out: ComboSpec[] = [];
  for (const value of Object.values(all)) {
    try {
      out.push(JSON.parse(value) as ComboSpec);
    } catch {
      // Skip silently per task 8.1 prompt.
    }
  }
  return out;
}

/**
 * Validate-then-persist a combo. Behavior:
 *   1. Read existing combos via `listCombos`.
 *   2. Build `existingNames` = combos minus the name being saved (so an
 *      UPDATE is allowed to re-use its own name).
 *   3. Run `validateCombo`. Throw with the validator's message on
 *      failure.
 *   4. If this is a CREATE (`spec.name` not in current combos) AND the
 *      hash already holds `MAX_COMBOS` entries, throw.
 *   5. Persist with `hSet` (single field).
 *
 * Returns the coerced spec (the same value `validateCombo` produced).
 */
export async function saveCombo(
  sub: string,
  spec: ComboSpec,
  deps: CombosDeps,
): Promise<ComboSpec> {
  const combos = await listCombos(sub, deps);
  const existingNames = combos
    .filter((c) => c.name !== spec.name)
    .map((c) => c.name);

  const result = validateCombo(spec, existingNames);
  if (!result.ok) {
    throw new Error(result.message);
  }

  const isCreate = !combos.some((c) => c.name === spec.name);
  if (isCreate && combos.length >= MAX_COMBOS) {
    throw new Error(
      `Cannot create combo: max of ${MAX_COMBOS} combos reached`,
    );
  }

  await deps.redis.hSet(combosKey(sub), {
    [spec.name]: JSON.stringify(result.value),
  });
  return result.value;
}

/**
 * Delete a combo by name. Idempotent — `hDel` against a missing field
 * is a no-op (returns 0). No realtime publish or metric bump is fired
 * here; the route handler in 8.2 returns 200 either way.
 */
export async function deleteCombo(
  sub: string,
  name: string,
  deps: CombosDeps,
): Promise<void> {
  await deps.redis.hDel(combosKey(sub), [name]);
}
