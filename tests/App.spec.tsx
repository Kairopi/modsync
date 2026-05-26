// @vitest-environment jsdom
/**
 * UI-shell tests for `src/client/App.tsx` (task 6.1).
 *
 * Asserts:
 *   - the initial render fires exactly four parallel fetches against
 *     `/api/feed`, `/api/metrics`, `/api/combos`, `/api/claims`;
 *   - the three tab buttons (Activity / Metrics / Combos) are rendered.
 *
 * No PBT — task 6.1 is a UI shell with no validated logic. The test runs
 * under jsdom via the per-file pragma above (vitest 4 dropped
 * `environmentMatchGlobs`; see `.kiro/steering/03-implementation-log.md`
 * task 1.3).
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { App } from '../src/client/App';

interface FetchCall {
  url: string;
  method: string;
}

function mockFetch(): { calls: FetchCall[]; restore: () => void } {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const method =
      init?.method ??
      (typeof input === 'object' && 'method' in input ? input.method : 'GET') ??
      'GET';
    calls.push({ url, method: method.toUpperCase() });
    // Return shape per endpoint:
    //   /api/feed     -> []
    //   /api/metrics  -> {}
    //   /api/combos   -> []
    //   /api/claims   -> {}
    let payload: unknown = {};
    if (url.startsWith('/api/feed')) payload = [];
    else if (url.startsWith('/api/combos')) payload = [];
    else payload = {};
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('App initial render', () => {
  test('fires exactly four parallel fetches against the four /api endpoints', () => {
    const { calls, restore } = mockFetch();
    try {
      render(<App />);

      // Initial render queues all four fetches synchronously inside the
      // useEffect via Promise.all. They must be observable on the call list
      // before any microtask advances state.
      expect(calls).toHaveLength(4);

      const paths = calls.map((c) => new URL(c.url, 'http://localhost').pathname).sort();
      expect(paths).toEqual([
        '/api/claims',
        '/api/combos',
        '/api/feed',
        '/api/metrics',
      ]);

      // Every initial fetch is a GET — no mutations on shell mount.
      for (const call of calls) {
        expect(call.method).toBe('GET');
      }
    } finally {
      restore();
    }
  });

  test('renders Activity / Metrics / Combos tab buttons', () => {
    const { restore } = mockFetch();
    try {
      render(<App />);

      const activityTab = screen.getByRole('tab', { name: 'Activity' });
      const metricsTab = screen.getByRole('tab', { name: 'Metrics' });
      const combosTab = screen.getByRole('tab', { name: 'Combos' });

      expect(activityTab).toBeDefined();
      expect(metricsTab).toBeDefined();
      expect(combosTab).toBeDefined();

      // Default selected tab is Activity.
      expect(activityTab.getAttribute('aria-selected')).toBe('true');
      expect(metricsTab.getAttribute('aria-selected')).toBe('false');
      expect(combosTab.getAttribute('aria-selected')).toBe('false');
    } finally {
      restore();
    }
  });
});
