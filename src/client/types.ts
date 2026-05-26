/**
 * Client-side type re-exports.
 *
 * Re-exports the canonical shared types/constants from `src/shared/types.ts`.
 * The relative path is intentional — the `@shared` alias is wired in
 * `vitest.config.ts` (see task 1.3 / `.kiro/steering/03-implementation-log.md`)
 * but NOT in `vite.config.ts`, so production client builds cannot resolve
 * `@shared/types`. Use this barrel file from every client module that needs
 * shared types.
 */
export type {
  ActionEntry,
  ClaimRecord,
  ComboSpec,
  ComboStep,
  MetricsBucket,
  RealtimeEvent,
  StepKind,
  ThingId,
} from '../shared/types';

export {
  CLAIM_TTL_SEC,
  COMBO_NAME_REGEX,
  MAX_COMBOS,
  MAX_FEED_ENTRIES,
} from '../shared/types';
