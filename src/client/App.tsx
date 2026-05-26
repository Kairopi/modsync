/**
 * ModSync webview shell.
 *
 * Renders a 3-tab layout (Activity / Metrics / Combos). On initial mount it
 * fires exactly four parallel fetches via `api.ts` (`getFeed` / `getMetrics`
 * / `getCombos` / `getClaims`) and threads the results into per-tab
 * placeholder components implemented by tasks 7.3 / 6.4 / 8.5.
 *
 * The soft-warning prompt is rendered by Reddit as a Devvit Form (declared
 * in `devvit.json` — see task 1.2 / 6.3); this component does NOT mount any
 * dialog for it.
 *
 * UI is built from plain React with minimal inline structure — no UI
 * library. Source of truth: `tasks.md` task 6.1.
 */
import { useEffect, useState, type ReactNode } from 'react';
import {
  getClaims,
  getCombos,
  getFeed,
  getMetrics,
  type ClaimsResponse,
  type MetricsResponse,
} from './api';
import { ActivityFeed } from './tabs/ActivityFeed';
import { ComboConfig } from './tabs/ComboConfig';
import { MetricsDashboard } from './tabs/MetricsDashboard';
import type { ActionEntry, ComboSpec } from './types';

type TabId = 'activity' | 'metrics' | 'combos';

interface TabSpec {
  id: TabId;
  label: string;
}

const TABS: readonly TabSpec[] = [
  { id: 'activity', label: 'Activity' },
  { id: 'metrics', label: 'Metrics' },
  { id: 'combos', label: 'Combos' },
] as const;

interface TabsProps {
  value: TabId;
  onChange: (next: TabId) => void;
  panels: Record<TabId, ReactNode>;
}

/**
 * Minimal inline tab component (3 buttons + active-content slots). All
 * panels stay mounted (hidden via the `hidden` attribute) so per-tab
 * effects (e.g. refetch on focus in 6.4 / 7.3) can run without
 * remount-thrash when the user toggles.
 */
function Tabs({ value, onChange, panels }: TabsProps) {
  return (
    <div>
      <div role="tablist" aria-label="ModSync tabs">
        {TABS.map((tab) => {
          const selected = tab.id === value;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`panel-${tab.id}`}
              onClick={() => onChange(tab.id)}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      {TABS.map((tab) => (
        <div
          key={tab.id}
          id={`panel-${tab.id}`}
          role="tabpanel"
          hidden={tab.id !== value}
        >
          {panels[tab.id]}
        </div>
      ))}
    </div>
  );
}

export function App() {
  const [tab, setTab] = useState<TabId>('activity');
  const [feed, setFeed] = useState<ActionEntry[] | undefined>(undefined);
  const [metrics, setMetrics] = useState<MetricsResponse | undefined>(
    undefined,
  );
  const [combos, setCombos] = useState<ComboSpec[] | undefined>(undefined);
  const [claims, setClaims] = useState<ClaimsResponse | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getFeed(), getMetrics(), getCombos(), getClaims()])
      .then(([f, m, c, cl]) => {
        if (cancelled) return;
        setFeed(f);
        setMetrics(m);
        setCombos(c);
        setClaims(cl);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Per-tab refetch on focus: when the user switches TO the metrics
  // tab, re-fetch `/api/metrics` so the dashboard reflects events that
  // landed since initial mount. Triggered from the Tabs `onChange`
  // handler, not from MetricsDashboard's own effect (which would
  // double-fetch on initial mount because every panel is mounted up
  // front under the `hidden` attribute).
  const handleTabChange = (next: TabId) => {
    setTab(next);
    if (next === 'metrics') {
      getMetrics()
        .then((m) => setMetrics(m))
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : String(err));
        });
    }
  };

  // The voids below silence `noUnusedLocals` for state slices that
  // tasks 7.3 / 8.5 will wire into their respective placeholders.
  void feed;
  void combos;
  void claims;

  return (
    <div>
      {error ? <div role="alert">{error}</div> : null}
      <Tabs
        value={tab}
        onChange={handleTabChange}
        panels={{
          activity: <ActivityFeed />,
          metrics: (
            <MetricsDashboard
              {...(metrics !== undefined ? { metrics } : {})}
            />
          ),
          combos: <ComboConfig />,
        }}
      />
    </div>
  );
}
