import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

/**
 * Tests for `devvit.json`.
 *
 * Source: `.kiro/specs/modsync/tasks.md` task 6.3.
 *
 * Locks the form-rendering contract end-to-end:
 *   1. The three named forms (`softWarningForm`, `comboPickerForm`,
 *      `comboEditorForm`) point at the exact endpoint strings the
 *      submit handlers (4.2b, 8.3b, 8.5) expect.
 *   2. Every form / trigger / menu endpoint declared in `devvit.json`
 *      is actually wired into the Hono route tree rooted at
 *      `src/server/index.ts`. The tree is composed of `index.ts` plus
 *      its child routers under `src/server/routes/` (menu, forms,
 *      triggers, api). We grep the union of those files for each
 *      endpoint's literal path. Task 6.3's prompt is explicit: if any
 *      expected wiring is absent, FAIL — that surfaces a real gap
 *      rather than papering over it.
 *
 * The current child route files are thin scaffolds with stub
 * `c.json({ ok: true })` handlers from task 1.1. Real wiring is a
 * future integration task; the grep test is intentionally satisfied
 * by the stubs because the path strings are mounted as soon as a
 * route is declared, regardless of handler implementation.
 *
 * Files read via `readFileSync`:
 *   - `devvit.json` (the wiring under test)
 *   - `src/server/index.ts` (root router; mounts `/internal/{menu,form,trigger}` and `/api`)
 *   - every `*.ts` under `src/server/routes/` (leaf path declarations)
 */

const REPO_ROOT = path.resolve(__dirname, "..");
const DEVVIT_JSON_PATH = path.join(REPO_ROOT, "devvit.json");
const SERVER_INDEX_PATH = path.join(REPO_ROOT, "src", "server", "index.ts");
const ROUTES_DIR = path.join(REPO_ROOT, "src", "server", "routes");

interface DevvitJson {
  name: string;
  forms?: Record<string, string>;
  triggers?: Record<string, string>;
  menu?: { items?: Array<{ endpoint: string }> };
}

function loadDevvitJson(): DevvitJson {
  const raw = readFileSync(DEVVIT_JSON_PATH, "utf8");
  return JSON.parse(raw) as DevvitJson;
}

function loadRouteCorpus(): { sources: Record<string, string>; combined: string } {
  const sources: Record<string, string> = {};
  sources["src/server/index.ts"] = readFileSync(SERVER_INDEX_PATH, "utf8");
  for (const entry of readdirSync(ROUTES_DIR)) {
    if (!entry.endsWith(".ts")) continue;
    const full = path.join(ROUTES_DIR, entry);
    sources[`src/server/routes/${entry}`] = readFileSync(full, "utf8");
  }
  const combined = Object.values(sources).join("\n");
  return { sources, combined };
}

/**
 * An endpoint declared in `devvit.json` looks like
 * `/internal/form/soft-warning-submit`. The Hono tree mounts the
 * `/internal/form` prefix in `src/server/index.ts` and the leaf
 * `/soft-warning-submit` in `src/server/routes/forms.ts`. To prove
 * the endpoint is wired we assert BOTH:
 *   - the prefix `/<prefix>` (e.g. `/form`) is mounted in `index.ts`
 *     via `.route('/<prefix>', ...)`
 *   - the leaf path string (e.g. `/soft-warning-submit`) appears in
 *     the union of the route source files (i.e. some `.post(...)` /
 *     `.get(...)` declaration registers it)
 * Each `/api/*` endpoint is handled the same way — `index.ts`
 * mounts `/api`, and the leaf is in `routes/api.ts`.
 */
function assertEndpointWired(
  endpoint: string,
  indexSource: string,
  combinedSource: string,
  context: string,
): void {
  // Endpoint shape: `/internal/<prefix>/<leaf>` or `/api/<leaf>`.
  const internalMatch = endpoint.match(/^\/internal\/([^/]+)(\/.+)$/);
  const apiMatch = endpoint.match(/^\/api(\/.+)$/);

  if (internalMatch) {
    const [, prefix, leaf] = internalMatch;
    // index.ts mounts the prefix under the `/internal` parent.
    const prefixPattern = new RegExp(`\\.route\\(\\s*['"]\\/${prefix}['"]`);
    expect(
      prefixPattern.test(indexSource),
      `${context}: expected src/server/index.ts to mount prefix '/${prefix}' for endpoint ${endpoint}`,
    ).toBe(true);
    // Leaf path appears literally somewhere in the route corpus.
    expect(
      combinedSource.includes(`'${leaf}'`) || combinedSource.includes(`"${leaf}"`),
      `${context}: expected leaf path '${leaf}' (from ${endpoint}) to appear in src/server/index.ts or src/server/routes/*.ts`,
    ).toBe(true);
  } else if (apiMatch) {
    const [, leaf] = apiMatch;
    expect(
      /\.route\(\s*['"]\/api['"]/.test(indexSource),
      `${context}: expected src/server/index.ts to mount '/api' for endpoint ${endpoint}`,
    ).toBe(true);
    expect(
      combinedSource.includes(`'${leaf}'`) || combinedSource.includes(`"${leaf}"`),
      `${context}: expected leaf path '${leaf}' (from ${endpoint}) to appear in src/server/routes/*.ts`,
    ).toBe(true);
  } else {
    throw new Error(
      `${context}: endpoint ${endpoint} does not match /internal/<prefix>/<leaf> or /api/<leaf>`,
    );
  }
}

describe("devvit.json — form-rendering contract (task 6.3)", () => {
  test("forms block declares the three named forms with locked endpoint strings", () => {
    const cfg = loadDevvitJson();
    expect(cfg.forms).toBeDefined();
    const forms = cfg.forms!;
    expect(forms.softWarningForm).toBe("/internal/form/soft-warning-submit");
    expect(forms.comboPickerForm).toBe("/internal/form/combo-picker-submit");
    expect(forms.comboEditorForm).toBe("/internal/form/combo-editor-submit");
    expect(Object.keys(forms).sort()).toEqual([
      "comboEditorForm",
      "comboPickerForm",
      "softWarningForm",
    ]);
  });

  test("every form endpoint is wired into the route tree rooted at src/server/index.ts", () => {
    const cfg = loadDevvitJson();
    const { sources, combined } = loadRouteCorpus();
    const indexSource = sources["src/server/index.ts"];
    expect(indexSource, "src/server/index.ts must be readable").toBeTruthy();
    for (const [name, endpoint] of Object.entries(cfg.forms ?? {})) {
      assertEndpointWired(endpoint, indexSource, combined, `forms.${name}`);
    }
  });

  test("every trigger endpoint is wired into the route tree rooted at src/server/index.ts", () => {
    const cfg = loadDevvitJson();
    const { sources, combined } = loadRouteCorpus();
    const indexSource = sources["src/server/index.ts"];
    expect(cfg.triggers).toBeDefined();
    const triggers = cfg.triggers!;
    // Spec locks 3 triggers: app-install, post-delete, comment-delete.
    expect(Object.keys(triggers).sort()).toEqual([
      "onAppInstall",
      "onCommentDelete",
      "onPostDelete",
    ]);
    for (const [name, endpoint] of Object.entries(triggers)) {
      assertEndpointWired(endpoint, indexSource, combined, `triggers.${name}`);
    }
  });

  test("every menu endpoint is wired into the route tree rooted at src/server/index.ts", () => {
    const cfg = loadDevvitJson();
    const { sources, combined } = loadRouteCorpus();
    const indexSource = sources["src/server/index.ts"];
    expect(cfg.menu?.items).toBeDefined();
    const items = cfg.menu!.items!;
    // Spec locks 2 menu items: claim + combo-picker.
    expect(items.length).toBe(2);
    const endpoints = items.map((i) => i.endpoint).sort();
    expect(endpoints).toEqual([
      "/internal/menu/claim",
      "/internal/menu/combo-picker",
    ]);
    for (const item of items) {
      assertEndpointWired(
        item.endpoint,
        indexSource,
        combined,
        `menu.items[endpoint=${item.endpoint}]`,
      );
    }
  });
});
