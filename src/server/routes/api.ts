/**
 * Production wiring for the public `/api/*` endpoints.
 *
 * Each handler closes over the per-request Devvit clients via the
 * adapters in `src/server/wiring.ts` and dispatches to the spec-module
 * implementations. Auth is enforced by `requireMod` for every route.
 */

import { Hono } from "hono";

import { ForbiddenError } from "../auth.js";
import { listActiveClaims } from "../claims.js";
import { getMetrics } from "../metrics.js";
import { readFeed } from "../feed.js";
import { registerCombosRoute } from "./combos.js";
import { registerFeedRoute } from "./feed.js";
import { registerMetricsRoute } from "./metrics.js";
import { seedDemo } from "../seed.js";
import {
  buildAuth,
  buildClaimsDeps,
  buildCombosDeps,
  buildFeedDeps,
  buildMetricsDeps,
  buildSeedReddit,
  getSeedEnabled,
  getSub,
} from "../wiring.js";

export const api = new Hono();

const auth = buildAuth();

// /api/feed — gated read endpoint, dispatches to feed.readFeed (with
// optional scrub layer wired via buildFeedDeps).
registerFeedRoute(api, {
  auth: async () => auth(),
  feed: {
    readFeed: (sub, limit) => readFeed(sub, limit, buildFeedDeps()),
  },
  getSub,
});

// /api/metrics — gated read endpoint, dispatches to metrics.getMetrics.
registerMetricsRoute(api, {
  auth: async () => auth(),
  metrics: {
    getMetrics: (sub, period) => getMetrics(sub, period, buildMetricsDeps()),
  },
  getSub,
});

// /api/combos — full CRUD.
registerCombosRoute(api, {
  auth,
  combos: buildCombosDeps(),
});

// /api/claims — gated. Returns the live claims map for realtime resync.
api.get("/claims", async (c) => {
  let sub: string;
  try {
    ({ sub } = await auth());
  } catch (err) {
    if (err instanceof ForbiddenError) {
      return c.json({ error: "forbidden" }, 403);
    }
    throw err;
  }
  const claims = await listActiveClaims(sub, buildClaimsDeps());
  return c.json(claims);
});

// /api/dev/seed — demo seed gated by the `seedEnabled` app setting.
// Setting defaults to OFF in production; flip ON only during the
// hackathon judging window.
api.post("/dev/seed", async (c) => {
  try {
    await auth();
  } catch (err) {
    if (err instanceof ForbiddenError) {
      return c.json({ error: "forbidden" }, 403);
    }
    throw err;
  }
  let count = 12;
  try {
    const body = (await c.req.json()) as { count?: unknown } | null;
    if (body && typeof body.count === "number" && body.count > 0) {
      count = Math.min(Math.floor(body.count), 50);
    }
  } catch {
    // No body or bad JSON — use default count.
  }
  const result = await seedDemo(count, {
    reddit: buildSeedReddit(),
    getSeedEnabled,
  });
  return c.json(result);
});
