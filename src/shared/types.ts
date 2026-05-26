/**
 * Shared types and constants for ModSync.
 *
 * Source of truth: `.kiro/specs/modsync/design.md` ("TypeScript types") and
 * `.kiro/steering/02-modsync-architecture.md`. Do not add fields not specified
 * there. Do not change `interface` <-> `type` choices.
 *
 * Imported from both server (`src/server/**`) and client (`src/client/**`).
 * Until task 1.3 lands the `@shared` Vite/Vitest alias, downstream modules
 * import via relative paths.
 */

/** Reddit Thing ID with prefix: `t1_` for comments, `t3_` for posts. */
export type ThingId = `t1_${string}` | `t3_${string}`;

/** A live claim on a single Thing. Stored as JSON in `claims:{sub}:{thingId}`. */
export interface ClaimRecord {
  moderator: string;
  claimedAt: number;
}

/** Discriminator tag for a single step in a combo. */
export type StepKind = "REMOVE" | "LOCK" | "BAN" | "MODNOTE" | "APPROVE";

/**
 * A single step in a combo. Discriminated by `kind`.
 *
 * - `BAN` carries `days` (validator caps at [0, 999]) and `reason`.
 * - `MODNOTE` carries `text` (validator caps at 1000 chars) and an optional
 *   `label` from a fixed enum.
 */
export type ComboStep =
  | { kind: "REMOVE" }
  | { kind: "LOCK" }
  | { kind: "APPROVE" }
  | { kind: "BAN"; days: number; reason: string }
  | {
      kind: "MODNOTE";
      text: string;
      label?: "ABUSE_WARNING" | "SPAM_WARNING" | "HELPFUL_USER" | "OTHER";
    };

/** A named, ordered list of steps. Stored as JSON in `combos:{sub}` HASH. */
export interface ComboSpec {
  name: string;
  steps: ComboStep[];
  description?: string;
}

/** One entry in the activity feed (`actions:{sub}` sorted set). */
export interface ActionEntry {
  id: string;
  ts: number;
  moderator: string;
  thingId: ThingId;
  comboName: string | "Claim";
  ranSteps: ComboStep[];
  failedStepIndex?: number;
  failureMessage?: string;
}

/**
 * A realtime broadcast on `claims-{sub}` or `actions-{sub}`. Discriminated by
 * `type`. Channel naming uses hyphens — Devvit Realtime forbids `:`.
 */
export type RealtimeEvent =
  | {
      type: "claim";
      thingId: ThingId;
      moderator: string;
      claimedAt: number;
      ttlSec: number;
    }
  | {
      type: "release";
      thingId: ThingId;
      moderator: string;
      reason: "completed" | "expired" | "manual";
    }
  | { type: "action"; entry: ActionEntry };

/** A single ISO-week metrics bucket (`metrics:{sub}:{isoWeek}` HASH). */
export interface MetricsBucket {
  softWarningsShown: number;
  collisionsDetected: number;
  redundantActionsAvoided: number;
}

/** Cap on entries kept in `actions:{sub}` (sorted set, trimmed by rank). */
export const MAX_FEED_ENTRIES = 500;

/** Claim TTL in seconds. Used for both Redis `expiration` and the index score. */
export const CLAIM_TTL_SEC = 90;

/** Cap on combos stored per install in `combos:{sub}`. */
export const MAX_COMBOS = 50;

/** Validation regex for combo names: 1-40 chars, [a-z0-9-_ ], case-insensitive. */
export const COMBO_NAME_REGEX = /^[a-z0-9-_ ]{1,40}$/i;
