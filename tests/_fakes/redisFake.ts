/**
 * In-memory Redis fake for ModSync tests. SHARED RESOURCE — tasks 4.1, 5.1,
 * 7.1, 8.1, 9.1, 9.2 all import this. Keep it complete and faithful to the
 * verified Devvit-Web 0.12.24 surface documented in
 * `.kiro/steering/01-build-truth.md` ("Installed SDK API surface").
 *
 * Storage model:
 *   - Three independent maps for STRING / HASH / SORTED SET keys. A single
 *     key cannot collide across types (real Redis would error on type
 *     mismatch; in this fake we keep them isolated and never error — every
 *     call site in ModSync uses one Redis type per key).
 *   - `expirations` carries an absolute ms-epoch `expiresAt` for keys that
 *     were `set` with `{ expiration: Date }` or `expire`d. On every read,
 *     `checkExpiry(key)` is consulted FIRST: if the injected `now()` has
 *     passed the expiry, the key is lazily evicted from all three maps and
 *     the read sees the key as missing. This matches Devvit Redis (which
 *     reports the same effect even if the key isn't physically purged yet).
 *
 * Determinism:
 *   - Accept an injected `now(): number` so tests can pin or advance time
 *     without touching the global clock. Defaults to `Date.now`.
 *
 * Recording:
 *   - `_writes` counts every mutating call. Auth-throw-path tests (4.2 /
 *     4.2b) assert these counters are 0 after a forbidden call.
 *   - `_publishes` is NOT here — the realtime fake lives next to its
 *     consumer test file (e.g. `tests/claims.spec.ts`).
 *
 * Surface (matches the user's task-4.1 prompt verbatim):
 *   get / set / del / exists / expire / incrBy
 *   hGet / hGetAll / hSet / hDel / hKeys / hIncrBy / hMGet
 *   zAdd / zRange / zRem / zRemRangeByRank / zRemRangeByScore / zScore / zCard
 *
 * `set` with `{ nx: true }` + existing key returns `""` (real Redis returns
 * nil; the typed Devvit signature is `Promise<string>` so we use `""` as
 * the "not applied" sentinel). Tests in this repo do not currently rely on
 * NX/XX semantics — the support is here for completeness so 4.2 and later
 * can opt in if needed.
 */

/** ms-epoch clock. Defaults to `Date.now` when not injected. */
export type NowFn = () => number;

/** Options for `makeRedisFake`. */
export interface RedisFakeOptions {
  now?: NowFn;
}

/** Public type of the fake. The methods structurally satisfy every narrow
 * `RedisLike`-style interface declared by individual server modules. */
export interface RedisFake {
  // ---- STRING ops ----
  get(key: string): Promise<string | undefined>;
  set(
    key: string,
    value: string,
    options?: { expiration?: Date; nx?: boolean; xx?: boolean },
  ): Promise<string>;
  del(...keys: string[]): Promise<void>;
  exists(...keys: string[]): Promise<number>;
  expire(key: string, seconds: number): Promise<void>;
  incrBy(key: string, value: number): Promise<number>;

  // ---- HASH ops ----
  hGet(key: string, field: string): Promise<string | undefined>;
  hGetAll(key: string): Promise<Record<string, string>>;
  hSet(key: string, fieldValues: Record<string, string>): Promise<number>;
  hDel(key: string, fields: string[]): Promise<number>;
  hKeys(key: string): Promise<string[]>;
  hIncrBy(key: string, field: string, value: number): Promise<number>;
  hMGet(key: string, fields: string[]): Promise<(string | null)[]>;

  // ---- SORTED SET ops ----
  zAdd(
    key: string,
    ...members: { member: string; score: number }[]
  ): Promise<number>;
  zRange(
    key: string,
    start: number | string,
    stop: number | string,
    opts?: {
      by?: "score" | "rank" | "lex";
      reverse?: boolean;
      limit?: { offset: number; count: number };
    },
  ): Promise<{ member: string; score: number }[]>;
  zRem(key: string, members: string[]): Promise<number>;
  zRemRangeByRank(key: string, start: number, stop: number): Promise<number>;
  zRemRangeByScore(
    key: string,
    min: number | string,
    max: number | string,
  ): Promise<number>;
  zScore(key: string, member: string): Promise<number | undefined>;
  zCard(key: string): Promise<number>;

  // ---- Recording side-channel ----
  /**
   * Per-method write counters. Every mutating call increments exactly one
   * counter. Auth-throw-path tests assert these are all 0 after a forbidden
   * call (Property 10).
   */
  readonly _writes: {
    set: number;
    del: number;
    expire: number;
    incrBy: number;
    hSet: number;
    hDel: number;
    hIncrBy: number;
    zAdd: number;
    zRem: number;
    zRemRangeByRank: number;
    zRemRangeByScore: number;
  };
}

function parseInfBound(v: number | string, fallback: number): number {
  if (typeof v === "number") return v;
  if (v === "+inf" || v === "inf") return Number.POSITIVE_INFINITY;
  if (v === "-inf") return Number.NEGATIVE_INFINITY;
  const parsed = Number(v);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Build a fresh in-memory Redis fake. Each test should make its own. */
export function makeRedisFake(options: RedisFakeOptions = {}): RedisFake {
  const now: NowFn = options.now ?? Date.now;

  const strings = new Map<string, string>();
  const hashes = new Map<string, Map<string, string>>();
  const sortedSets = new Map<string, Map<string, number>>();
  const expirations = new Map<string, number>();

  const _writes = {
    set: 0,
    del: 0,
    expire: 0,
    incrBy: 0,
    hSet: 0,
    hDel: 0,
    hIncrBy: 0,
    zAdd: 0,
    zRem: 0,
    zRemRangeByRank: 0,
    zRemRangeByScore: 0,
  };

  /**
   * Lazy expiry. Returns `true` if the key is alive after this call,
   * `false` if it was just evicted (or never existed). Always check FIRST
   * before any read or mutation that depends on existence.
   */
  function checkExpiry(key: string): boolean {
    const exp = expirations.get(key);
    if (exp === undefined) {
      return (
        strings.has(key) || hashes.has(key) || sortedSets.has(key)
      );
    }
    if (now() >= exp) {
      strings.delete(key);
      hashes.delete(key);
      sortedSets.delete(key);
      expirations.delete(key);
      return false;
    }
    return strings.has(key) || hashes.has(key) || sortedSets.has(key);
  }

  function keyExists(key: string): boolean {
    if (!checkExpiry(key)) return false;
    return strings.has(key) || hashes.has(key) || sortedSets.has(key);
  }

  /** Sort members in `key` by (score asc, member asc lex). Cheap; fake-scale. */
  function sortedView(
    key: string,
  ): { member: string; score: number }[] {
    const m = sortedSets.get(key);
    if (!m) return [];
    return Array.from(m.entries())
      .map(([member, score]) => ({ member, score }))
      .sort(
        (a, b) =>
          a.score - b.score || (a.member < b.member ? -1 : a.member > b.member ? 1 : 0),
      );
  }

  return {
    _writes,

    // ---- STRING ops ----
    async get(key) {
      if (!checkExpiry(key)) return undefined;
      return strings.get(key);
    },

    async set(key, value, opts) {
      _writes.set += 1;
      // Evict if expired so NX/XX see the post-expiry state.
      checkExpiry(key);
      const existed = strings.has(key);
      if (opts?.nx && existed) return "";
      if (opts?.xx && !existed) return "";
      strings.set(key, value);
      // Setting a STRING clears any HASH/SORTED-SET data on the same key
      // (real Redis would WRONGTYPE; we just isolate types here).
      hashes.delete(key);
      sortedSets.delete(key);
      if (opts?.expiration) {
        expirations.set(key, opts.expiration.getTime());
      } else {
        expirations.delete(key);
      }
      return "OK";
    },

    async del(...keys) {
      _writes.del += 1;
      for (const k of keys) {
        strings.delete(k);
        hashes.delete(k);
        sortedSets.delete(k);
        expirations.delete(k);
      }
    },

    async exists(...keys) {
      let n = 0;
      for (const k of keys) {
        if (keyExists(k)) n += 1;
      }
      return n;
    },

    async expire(key, seconds) {
      _writes.expire += 1;
      if (!keyExists(key)) return;
      expirations.set(key, now() + seconds * 1000);
    },

    async incrBy(key, value) {
      _writes.incrBy += 1;
      checkExpiry(key);
      const cur = strings.has(key) ? Number(strings.get(key)) : 0;
      const next = (Number.isFinite(cur) ? cur : 0) + value;
      strings.set(key, String(next));
      return next;
    },

    // ---- HASH ops ----
    async hGet(key, field) {
      if (!checkExpiry(key)) return undefined;
      return hashes.get(key)?.get(field);
    },

    async hGetAll(key) {
      if (!checkExpiry(key)) return {};
      const bucket = hashes.get(key);
      if (!bucket) return {};
      return Object.fromEntries(bucket);
    },

    async hSet(key, fieldValues) {
      _writes.hSet += 1;
      checkExpiry(key);
      let bucket = hashes.get(key);
      if (!bucket) {
        bucket = new Map();
        hashes.set(key, bucket);
      }
      let added = 0;
      for (const [f, v] of Object.entries(fieldValues)) {
        if (!bucket.has(f)) added += 1;
        bucket.set(f, v);
      }
      return added;
    },

    async hDel(key, fields) {
      _writes.hDel += 1;
      if (!checkExpiry(key)) return 0;
      const bucket = hashes.get(key);
      if (!bucket) return 0;
      let removed = 0;
      for (const f of fields) {
        if (bucket.delete(f)) removed += 1;
      }
      if (bucket.size === 0) {
        hashes.delete(key);
        expirations.delete(key);
      }
      return removed;
    },

    async hKeys(key) {
      if (!checkExpiry(key)) return [];
      return Array.from(hashes.get(key)?.keys() ?? []);
    },

    async hIncrBy(key, field, value) {
      _writes.hIncrBy += 1;
      checkExpiry(key);
      let bucket = hashes.get(key);
      if (!bucket) {
        bucket = new Map();
        hashes.set(key, bucket);
      }
      const cur = bucket.has(field) ? Number(bucket.get(field)) : 0;
      const next = (Number.isFinite(cur) ? cur : 0) + value;
      bucket.set(field, String(next));
      return next;
    },

    async hMGet(key, fields) {
      if (!checkExpiry(key)) return fields.map(() => null);
      const bucket = hashes.get(key);
      if (!bucket) return fields.map(() => null);
      return fields.map((f) => bucket.get(f) ?? null);
    },

    // ---- SORTED SET ops ----
    async zAdd(key, ...members) {
      _writes.zAdd += 1;
      checkExpiry(key);
      let s = sortedSets.get(key);
      if (!s) {
        s = new Map();
        sortedSets.set(key, s);
      }
      let added = 0;
      for (const { member, score } of members) {
        if (!s.has(member)) added += 1;
        s.set(member, score);
      }
      return added;
    },

    async zRange(key, start, stop, opts) {
      if (!checkExpiry(key)) return [];
      const view = sortedView(key);
      const by = opts?.by ?? "rank";

      let filtered: { member: string; score: number }[];

      if (by === "score") {
        const min = parseInfBound(start, Number.NEGATIVE_INFINITY);
        const max = parseInfBound(stop, Number.POSITIVE_INFINITY);
        filtered = view.filter((m) => m.score >= min && m.score <= max);
      } else if (by === "lex") {
        // Real Redis lex ranges use `[` / `(` / `-` / `+` prefixes; we
        // simplify to inclusive string range. Adequate for our use.
        const minStr = String(start).replace(/^[\[(]/, "");
        const maxStr = String(stop).replace(/^[\[(]/, "");
        filtered = view.filter(
          (m) =>
            (start === "-" || m.member >= minStr) &&
            (stop === "+" || m.member <= maxStr),
        );
      } else {
        // by rank
        const len = view.length;
        const startNum = typeof start === "number" ? start : Number(start);
        const stopNum = typeof stop === "number" ? stop : Number(stop);
        const startIdx =
          startNum < 0 ? Math.max(0, len + startNum) : Math.min(startNum, len);
        const stopIdx =
          stopNum < 0
            ? Math.max(-1, len + stopNum)
            : Math.min(stopNum, len - 1);
        filtered =
          startIdx > stopIdx ? [] : view.slice(startIdx, stopIdx + 1);
      }

      if (opts?.reverse) filtered = filtered.slice().reverse();

      if (opts?.limit) {
        const { offset, count } = opts.limit;
        filtered = filtered.slice(offset, offset + count);
      }

      return filtered;
    },

    async zRem(key, members) {
      _writes.zRem += 1;
      if (!checkExpiry(key)) return 0;
      const s = sortedSets.get(key);
      if (!s) return 0;
      let removed = 0;
      for (const m of members) {
        if (s.delete(m)) removed += 1;
      }
      if (s.size === 0) {
        sortedSets.delete(key);
        expirations.delete(key);
      }
      return removed;
    },

    async zRemRangeByRank(key, start, stop) {
      _writes.zRemRangeByRank += 1;
      if (!checkExpiry(key)) return 0;
      const s = sortedSets.get(key);
      if (!s) return 0;
      const view = sortedView(key);
      const len = view.length;
      const startIdx =
        start < 0 ? Math.max(0, len + start) : Math.min(start, len);
      const stopIdx =
        stop < 0 ? Math.max(-1, len + stop) : Math.min(stop, len - 1);
      if (startIdx > stopIdx) return 0;
      const slice = view.slice(startIdx, stopIdx + 1);
      for (const { member } of slice) s.delete(member);
      if (s.size === 0) {
        sortedSets.delete(key);
        expirations.delete(key);
      }
      return slice.length;
    },

    async zRemRangeByScore(key, min, max) {
      _writes.zRemRangeByScore += 1;
      if (!checkExpiry(key)) return 0;
      const s = sortedSets.get(key);
      if (!s) return 0;
      const minN = parseInfBound(min, Number.NEGATIVE_INFINITY);
      const maxN = parseInfBound(max, Number.POSITIVE_INFINITY);
      let removed = 0;
      for (const [member, score] of Array.from(s.entries())) {
        if (score >= minN && score <= maxN) {
          s.delete(member);
          removed += 1;
        }
      }
      if (s.size === 0) {
        sortedSets.delete(key);
        expirations.delete(key);
      }
      return removed;
    },

    async zScore(key, member) {
      if (!checkExpiry(key)) return undefined;
      return sortedSets.get(key)?.get(member);
    },

    async zCard(key) {
      if (!checkExpiry(key)) return 0;
      return sortedSets.get(key)?.size ?? 0;
    },
  };
}
