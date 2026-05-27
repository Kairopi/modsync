/**
 * Production wiring for `/internal/form/*` form-submit endpoints.
 *
 * Three forms declared in devvit.json post to these endpoints:
 *   - softWarningForm     -> /internal/form/soft-warning-submit
 *   - comboPickerForm     -> /internal/form/combo-picker-submit
 *   - comboEditorForm     -> /internal/form/combo-editor-submit
 *
 * The combo-editor form is currently mod-only and is driven by the
 * webview's CRUD UI (task 8.5) via /api/combos POST/DELETE — so this
 * endpoint just acknowledges the submit. It exists because devvit.json
 * declares it; if a future revision adds a server-side flow, replace
 * the stub here.
 */

import { Hono } from "hono";

import { onComboPickerSubmit, type ComboPickerSubmitBody } from "../forms/comboPickerSubmit.js";
import { onSoftWarningSubmit, type SoftWarningSubmitBody } from "../forms/softWarningSubmit.js";
import { claim, getClaim } from "../claims.js";
import { listCombos } from "../combos.js";
import { runCombo } from "../executor.js";
import { bumpMetric } from "../metrics.js";
import {
  buildAuth,
  buildClaimsDeps,
  buildCombosDeps,
  buildExecutorDeps,
  buildMetricsDeps,
  getSub,
} from "../wiring.js";

export const forms = new Hono();

const auth = buildAuth();

forms.post("/soft-warning-submit", async (c) => {
  const body = await c.req.json<SoftWarningSubmitBody>();
  const claimsDeps = buildClaimsDeps();
  const combosDeps = buildCombosDeps();
  const metricsDeps = buildMetricsDeps();
  const executorDeps = buildExecutorDeps();
  const ui = await onSoftWarningSubmit(body, {
    auth: async () => auth(),
    getSub,
    claims: {
      claim: (sub, thingId, mod) => claim(sub, thingId, mod, claimsDeps),
    },
    combos: {
      listCombos: (sub) => listCombos(sub, combosDeps),
    },
    executor: {
      runCombo: (thingId, combo, mod, sub) =>
        runCombo(thingId, combo, mod, sub, executorDeps),
    },
    metrics: {
      bumpMetric: (sub, kind) => bumpMetric(sub, kind, metricsDeps),
    },
  });
  return c.json(ui);
});

forms.post("/combo-picker-submit", async (c) => {
  const body = await c.req.json<ComboPickerSubmitBody>();
  const claimsDeps = buildClaimsDeps();
  const combosDeps = buildCombosDeps();
  const metricsDeps = buildMetricsDeps();
  const executorDeps = buildExecutorDeps();
  const ui = await onComboPickerSubmit(body, {
    auth: async () => auth(),
    getSub,
    claims: {
      getClaim: (sub, thingId) => getClaim(sub, thingId, claimsDeps),
      claim: (sub, thingId, mod) => claim(sub, thingId, mod, claimsDeps),
    },
    combos: {
      listCombos: (sub) => listCombos(sub, combosDeps),
    },
    executor: {
      runCombo: (thingId, combo, mod, sub) =>
        runCombo(thingId, combo, mod, sub, executorDeps),
    },
    metrics: {
      bumpMetric: (sub, kind) => bumpMetric(sub, kind, metricsDeps),
    },
  });
  return c.json(ui);
});

// Combo-editor form-submit is currently a no-op acknowledgement —
// the webview drives combo CRUD via /api/combos directly. The form
// is declared in devvit.json but no server-side flow uses it today.
forms.post("/combo-editor-submit", (c) => c.json({ showToast: "Saved" }));
