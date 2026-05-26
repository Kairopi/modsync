---
inclusion: always
---

# ModSync Architecture Quick Reference

`design.md` is the source of truth. This is a fast-access index. If anything here conflicts with `design.md`, design.md wins.

## Redis schema (per install — Devvit Redis is per-install namespaced)

| Key | Type | Value | TTL | Cap |
| --- | --- | --- | --- | --- |
| `claims:{sub}:{thingId}` | STRING (JSON) | `{ moderator, claimedAt }` | 90s | one per item |
| `claims-index:{sub}` | SORTED SET | member=thingId, score=expiry-ms | none | manual prune via score |
| `actions:{sub}` | SORTED SET | member=JSON ActionEntry, score=ts | none | 500 (zRemRangeByRank) |
| `combos:{sub}` | HASH | field=name, value=JSON ComboSpec | none | 50 |
| `metrics:{sub}:{isoWeek}` | HASH | softWarningsShown / collisionsDetected / redundantActionsAvoided | 60 days | HINCRBY only |
| `deleted-mods:{sub}` | HASH | username -> "1" | none | append-only |
| `mods:{sub}` | HASH | username -> "1" | refreshed via sentinel | populated by requireMod |
| `mods-expiry:{sub}` | STRING | "1" | 300s | gates mods cache freshness |

## Realtime channels

- `claims-{sub}` — `claim` and `release` events
- `actions-{sub}` — `action` events

Hyphens, never colons. Per-sub scoping prevents cross-install leak.

## TypeScript types (lock these signatures)

```ts
type ThingId = `t1_${string}` | `t3_${string}`;

interface ClaimRecord { moderator: string; claimedAt: number; }

type StepKind = "REMOVE" | "LOCK" | "BAN" | "MODNOTE" | "APPROVE";

type ComboStep =
  | { kind: "REMOVE" }
  | { kind: "LOCK" }
  | { kind: "APPROVE" }
  | { kind: "BAN"; days: number; reason: string }
  | { kind: "MODNOTE"; text: string; label?: "ABUSE_WARNING" | "SPAM_WARNING" | "HELPFUL_USER" | "OTHER" };

interface ComboSpec { name: string; steps: ComboStep[]; description?: string; }

interface ActionEntry {
  id: string; ts: number; moderator: string; thingId: ThingId;
  comboName: string | "Claim";
  ranSteps: ComboStep[]; failedStepIndex?: number; failureMessage?: string;
}

type RealtimeEvent =
  | { type: "claim"; thingId: ThingId; moderator: string; claimedAt: number; ttlSec: number }
  | { type: "release"; thingId: ThingId; moderator: string; reason: "completed" | "expired" | "manual" }
  | { type: "action"; entry: ActionEntry };

interface MetricsBucket {
  softWarningsShown: number; collisionsDetected: number; redundantActionsAvoided: number;
}
```

Constants exported from `src/shared/types.ts`:
- `MAX_FEED_ENTRIES = 500`
- `CLAIM_TTL_SEC = 90`
- `MAX_COMBOS = 50`
- `COMBO_NAME_REGEX = /^[a-z0-9-_ ]{1,40}$/i`

## File layout

```
src/
  server/
    index.ts                      # Hono entry, wires all routers
    auth.ts                       # requireMod
    claims.ts                     # claim/release/refresh/getClaim/listActiveClaims
    combos.ts                     # validateCombo/saveCombo/deleteCombo/listCombos
    executor.ts                   # runCombo
    feed.ts                       # appendAction/readFeed/purgeByThingId
    metrics.ts                    # bumpMetric/getMetrics
    realtime.ts                   # publishClaim/publishAction/subscribe...
    redisKeys.ts                  # claimKey/actionsKey/combosKey/metricsKey/isoWeekKey
    scrub.ts                      # isModeratorDeleted/scrubEntry
    seed.ts                       # demo seed
    routes/
      menu.ts                     # /internal/menu/{claim,combo-picker}
      forms.ts                    # /internal/form/{soft-warning,combo-picker,combo-editor}-submit
      triggers.ts                 # /internal/trigger/{app-install,post-delete,comment-delete}
      api.ts                      # /api/{feed,metrics,combos,claims,dev/seed}
  client/
    index.html
    index.tsx                     # mounts <App />
    App.tsx                       # tab router + realtime wiring
    api.ts                        # typed fetch wrappers
    realtime.ts                   # useRealtime hook with backoff
    types.ts                      # re-exports from @shared/types
    tabs/
      ActivityFeed.tsx
      MetricsDashboard.tsx
      ComboConfig.tsx
  shared/
    types.ts                      # all shared types + constants
tests/
  _fakes/
    redisFake.ts                  # in-memory Redis with TTL/HASH/sorted-set/get/set/exists/hExists
  *.spec.ts                       # one file per module
```

## Correctness properties (from design.md)

11 properties are validated by ≥1 leaf task each via fast-check:
1. Claim write produces correct record + index entry
2. Each claim/release publishes exactly one realtime event
3. No-foreign-claim path and combo-override path produce correct claim state
4. Release deletes claim + index; refresh updates timestamp + score
5. (covered by 4)
6. Realtime payload integrity (publish-then-subscribe deepEqual)
7. Combo validator + CRUD round-trip
8. Feed ordering, cap, and prepend-dedupe (server + client halves)
9. Metric counter routing (HINCRBY against right week + field) + zero-state
10. Auth gate (requireMod returns iff in mod list, no side-effects on throw)
11. ISO week key correctness (covered by 2.2)

## Critical gotchas

- **`requireMod` is on EVERY menu, form, and mutating /api endpoint.** The auth fake records calls; tests assert it's invoked.
- **Soft warning is a Devvit Form**, not a React dialog. Declared in `devvit.json` as `softWarningForm`. The webview never renders it.
- **`softWarningsShown` is incremented at form-show time** (in 4.2 / 8.3a). `collisionsDetected` and `redundantActionsAvoided` are mutually exclusive, incremented at form-submit time (in 4.2b). Never increment `softWarningsShown` from the submit handler.
- **The combo picker rebuilds its options every time it opens**, so the 5-second freshness requirement is satisfied without cache invalidation.
- **Devvit Web request limit is 30s.** Combo validator caps `steps.length` at 10.
- **MODNOTE.text caps at 1000 chars; BAN.days in [0, 999].** Enforced in 8.1 validator.

## Cut order (if time runs short)

P0 floor (cannot cut): 4.x, 4.2 + 4.2b + 6.3, 5.x + 6.4, 6.1 + 6.2, 9.x, 10.x.

P1 (cuttable, in this order):
1. Combos (8.x) — fall back to 8.6 default-only
2. Activity feed (7.x) — trim to last-50 only
