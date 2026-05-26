/**
 * Typed thin fetch wrappers for ModSync's `/api/*` endpoints.
 *
 * Each wrapper:
 *   - issues a single `fetch('/api/...')` with the appropriate method and body
 *   - parses the JSON response on 2xx
 *   - throws an `Error` (with status code + best-effort body excerpt) on non-2xx
 *
 * No retry, no caching. The caller (App.tsx, tabs, useRealtime resync) is
 * responsible for orchestration. Source of truth: `tasks.md` task 6.1 +
 * `.kiro/specs/modsync/design.md` "Server Endpoints".
 */
import type {
  ActionEntry,
  ClaimRecord,
  ComboSpec,
  MetricsBucket,
  ThingId,
} from './types';

/** GET /api/metrics response shape (server returns bucket + period metadata). */
export type MetricsResponse = MetricsBucket & {
  period: 'week' | 'month';
  periodKey: string;
};

/** GET /api/claims response shape. Keys are full ThingIds; values carry ttl. */
export type ClaimsResponse = Record<ThingId, ClaimRecord & { ttlSec: number }>;

async function request<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    let detail = '';
    try {
      detail = await res.text();
    } catch {
      /* swallow body-read errors — surface status only */
    }
    const trimmed = detail.length > 200 ? `${detail.slice(0, 200)}…` : detail;
    throw new Error(
      `${init?.method ?? 'GET'} ${path} failed: ${res.status}${trimmed ? ` — ${trimmed}` : ''}`,
    );
  }
  return (await res.json()) as T;
}

/** GET /api/feed?limit=N (default 50; route clamps to [1, 500]). */
export function getFeed(limit?: number): Promise<ActionEntry[]> {
  const qs = typeof limit === 'number' ? `?limit=${encodeURIComponent(limit)}` : '';
  return request<ActionEntry[]>(`/api/feed${qs}`);
}

/** GET /api/metrics?period=week|month (default week). */
export function getMetrics(period?: 'week' | 'month'): Promise<MetricsResponse> {
  const qs = period ? `?period=${encodeURIComponent(period)}` : '';
  return request<MetricsResponse>(`/api/metrics${qs}`);
}

/** GET /api/combos. Returns the full combos list for the current install. */
export function getCombos(): Promise<ComboSpec[]> {
  return request<ComboSpec[]>('/api/combos');
}

/** GET /api/claims. Returns the active claims map for the current install. */
export function getClaims(): Promise<ClaimsResponse> {
  return request<ClaimsResponse>('/api/claims');
}

/** POST /api/combos with a ComboSpec body. Returns the saved spec. */
export function saveCombo(spec: ComboSpec): Promise<ComboSpec> {
  return request<ComboSpec>('/api/combos', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(spec),
  });
}

/** DELETE /api/combos/:name. Idempotent; returns `{ ok: true }`. */
export function deleteCombo(name: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/combos/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  });
}

/** POST /api/dev/seed?count=N. Demo seeding endpoint (gated server-side). */
export function seed(count?: number): Promise<{ created: number }> {
  const qs = typeof count === 'number' ? `?count=${encodeURIComponent(count)}` : '';
  return request<{ created: number }>(`/api/dev/seed${qs}`, { method: 'POST' });
}
