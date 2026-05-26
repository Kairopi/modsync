---
inclusion: always
---

# ModSync Spec Pointer (READ FIRST)

You are working on **ModSync**, a Devvit Web mod-tool app for the Reddit Mod Tools and Migrated Apps Hackathon (deadline 2026-05-27 9pm PT). The spec is fully written and locked. **Do not invent requirements or alter the architecture.** Every implementation decision must trace back to one of the three documents below.

## Source of truth (read order)

1. `.kiro/specs/modsync/requirements.md` — 10 EARS-format requirements + glossary. The "what".
2. `.kiro/specs/modsync/design.md` — architecture, Redis schema, devvit.json shape, every flow, the 11 correctness properties. The "how".
3. `.kiro/specs/modsync/tasks.md` — 34 leaf tasks with explicit file paths, function signatures, PBT properties, acceptance signals. The "do this".

## Implementation ledger

Read `.kiro/steering/03-implementation-log.md` to see what is already built, what files exist, and what public exports / decisions came before. This prevents you from re-implementing existing modules or contradicting an earlier decision.

## Operating rules

- **Before any code change**, read the relevant section of `tasks.md` for the current task ID, then cross-reference `design.md` for the data model / flow / property the change must satisfy.
- **Do not deviate from the spec.** If a leaf task is impossible or contradicts the toolchain (see `01-build-truth.md`), STOP and surface the conflict — do not silently work around it.
- **Stay inside file paths declared by the task.** Do not create modules the task does not authorize.
- **Property tests are required, not optional.** Every leaf task that produces validated logic ships with `fast-check` properties at the iteration count the task names (≥100 minimum, ≥200 for executor + validator).
- **After completing a task**, append an entry to `03-implementation-log.md` (see that file for the entry format).

## Hackathon stakes

This is a competitive build with realistic 10-15% odds at the $10K grand prize. Slop loses; precision and PBT-validated correctness wins. Every task has been written to be self-contained and parallelizable — execute tasks as written and the system composes correctly.
