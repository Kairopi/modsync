/**
 * Default combos shipped with ModSync. Seeded into `combos:{sub}` on
 * first install via task 9.3's `onAppInstall` handler, which accepts a
 * `defaultCombos: ComboSpec[]` field on `AppInstallDeps` and is gated
 * on `combos:{sub}` being empty so re-installs do not duplicate or
 * overwrite mod-edited combos.
 *
 * Source of truth for the validation contract these specs must satisfy:
 *   - `src/server/combos.ts` `validateCombo` (task 8.1)
 *   - `src/shared/types.ts` `COMBO_NAME_REGEX`, `MAX_COMBOS`, `ComboSpec`
 *
 * Picking philosophy:
 *   - Two combos that demonstrate ModSync's value to a fresh mod team
 *     without being overly aggressive — every action is one a human
 *     moderator would take routinely on the same target. No bans
 *     longer than 7 days, no permanent bans, no stacked nuke combos.
 *   - Names are lowercase + hyphenated so they pass `COMBO_NAME_REGEX`
 *     (`/^[a-z0-9-_ ]{1,40}$/i`) and read naturally in the combo
 *     picker UI (task 8.3a).
 *   - Step counts well below the validator cap of 10 so a mod adding
 *     their own steps via the editor (task 8.5) has plenty of room.
 */

import type { ComboSpec } from "../shared/types";

/**
 * Two starter combos seeded on first install. Order is preserved when
 * the seeder iterates this array. Lock the contents — the test
 * harness asserts validator-pass + name-uniqueness + bound checks
 * against this exact list.
 */
export const DEFAULT_COMBOS: ComboSpec[] = [
  {
    name: "spam-removal",
    description:
      "Remove spam, apply a 7-day ban, and log a SPAM_WARNING mod note.",
    steps: [
      { kind: "REMOVE" },
      { kind: "BAN", days: 7, reason: "Spam" },
      {
        kind: "MODNOTE",
        text: "Removed for spam",
        label: "SPAM_WARNING",
      },
    ],
  },
  {
    name: "rule-violation",
    description:
      "Remove a rule-violating post or comment, lock further replies, and log a mod note.",
    steps: [
      { kind: "REMOVE" },
      { kind: "LOCK" },
      {
        kind: "MODNOTE",
        text: "Removed for rule violation",
        label: "OTHER",
      },
    ],
  },
];
