/**
 * Production wiring for `/internal/menu/*` endpoints.
 *
 * Each handler reads the menu request body, builds the per-request
 * dep bag via the adapters in `src/server/wiring.ts`, and dispatches
 * to the spec-module handlers in `src/server/menu/`.
 */

import { Hono } from "hono";
import type { MenuItemRequest } from "@devvit/web/shared";

import { onClaimMenu } from "../menu/claimHandler.js";
import { onComboPickerMenu } from "../menu/comboPickerHandler.js";
import { claim, getClaim } from "../claims.js";
import { listCombos } from "../combos.js";
import { bumpMetric } from "../metrics.js";
import {
  buildAuth,
  buildClaimsDeps,
  buildCombosDeps,
  buildMetricsDeps,
  getSub,
} from "../wiring.js";

export const menu = new Hono();

const auth = buildAuth();

menu.post("/claim", async (c) => {
  const body = await c.req.json<MenuItemRequest>();
  const claimsDeps = buildClaimsDeps();
  const metricsDeps = buildMetricsDeps();
  const ui = await onClaimMenu(body, {
    auth: async () => auth(),
    getSub,
    claims: {
      getClaim: (sub, thingId) => getClaim(sub, thingId, claimsDeps),
      claim: (sub, thingId, mod) => claim(sub, thingId, mod, claimsDeps),
    },
    metrics: {
      bumpMetric: (sub, kind) => bumpMetric(sub, kind, metricsDeps),
    },
  });
  return c.json(ui);
});

menu.post("/combo-picker", async (c) => {
  const body = await c.req.json<MenuItemRequest>();
  const combosDeps = buildCombosDeps();
  const ui = await onComboPickerMenu(body, {
    auth: async () => auth(),
    getSub,
    combos: {
      listCombos: (sub) => listCombos(sub, combosDeps),
    },
  });
  return c.json(ui);
});
