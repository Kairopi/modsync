/**
 * Vitest global setup. Loaded for every test file via `setupFiles` in
 * `vitest.config.ts`.
 *
 * Keep this file minimal. ModSync's tests are mostly pure / use injected
 * fakes (see `tests/_fakes/redisFake.ts` from task 4.1 onward), so we do
 * not need a global mock surface here. Future hooks (e.g. resetting a
 * shared fast-check seed for reproducibility, or wiring up a deterministic
 * clock) can land here without touching individual specs.
 */

export {};
