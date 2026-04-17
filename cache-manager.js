'use strict';
// ═══════════════════════════════════════════════════════════════════
//  BingeBox Omega — cache-manager.js  v3.0
//  Two-tier (L1 hot / L2 warm) LRU cache with:
//    • Stale-while-revalidate (SWR)
//    • Adaptive TTL (popular keys get longer TTLs)
//    • zlib compression for large payloads
//    • Tag-based invalidation
//    • Memory-pressure eviction
//    • Admin REST router for server.js to mount
// ═══════════════════════════════════════════════════════════════════

const zlib    = require('zlib');
const os      = require('os');
const express = require('express');
const createLogger = require('./logger');

const log = createLogger('Cache');

// ── Config ───────────────────────────────────────────────────────
const CFG = {
  L1_MAX         : 300,
  L2_MAX         : 2_000,
  DEFAULT_TTL    : 5   * 60_000,   // 5 min
  MAX_TTL        : 60  * 60_000,   // 60 min
  MIN_TTL        : 30  * 1_000,    // 30 s
  COMPRESS_BYTES : 4_096,          // compress payloads > 4 KB
  MEM_THRESHOLD  : 0.85,           // evict L2 when RSS / total > this
  SWR_WINDOW     : 30  * 1_000,    // serve stale for up to 30 s while refreshing
  METRICS_RESET  : 60  * 60_000,   // reset hit counters every hour
  ADAPTIVE_CAP   : 8,              // max hit-factor doublings for adaptive TTL
};

// ── Metrics ──────────────────────────────────────────────────────
const m = {
  hits: 0, misses: 0, staleHits: 0, evictions: 0,
  compressions: 0, decompressions: 0, errors: 0, inflight: 0,
  reset() {
    this.hits = this.misses = this.staleHits = this.evictions =
    this.compressions = this.decompressions = this.errors = this.inflight = 0;
  },
  snapshot() {
    const total = this.hits + this.misses;
    return { ...this, hitRate: total ? +(this.hits / total).toFixed(4) : 0, total };
  },
};
setInterval(() => m.reset(), CFG.METRICS_RESET);

// ── Compression helpers ───────────────────────────────────────────
function tryCompress(str) {
  if (!str || str.length < CFG.COMPRESS_BYTES) return { raw: str, compressed: false };
  try {
    const buf = zlib.gzipSync(Buffer.from(str, 'utf8'));
    m.compressions++;
    return { raw: buf, compressed: true };
  } catch (_) {
    return { raw: str, compressed: false };
  }
}

function tryDecompress(entry) {
  if (!entry.compressed) return entry.raw;
  try {
    m.decompressions++;
    return zlib.gunzipSync(entry.raw).toString('utf8');
  } catch (_) {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════
//  LRU cache tier
// ═══════════════════════════════════════════════════════════════════
class LRUTier {
  constructor(maxSize, name) {
    this._map  = new Map();
    this._max  = maxSize;
    this.name  = name;
    this.evictions = 0;
  }

  _evictOldest() {
    const key = this._map.keys().next().value;
    if (key !== undefined) { this._map.delete(key); this.evictions++; m.evictions++; }
  }

  /** Returns { value, stale, ttlMs } or null */
  get(key) {
    const entry = this._map.get(key);
    if (!entry) return null;

    // Move to tail (LRU refresh)
    this._map.delete(key);
    this._map.set(key, entry);

    const now     = Date.now();
    const expired = now > entry.expires;
    const stale   = !expired && now > (entry.expires - CFG.SWR_WINDOW);

    if (expired && !entry.allowStale) return null;

    try {
      const raw   = tryDecompress(entry);
      if (raw === null) { this._map.delete(key); return null; }
      const value = JSON.parse(raw);
      return { value, stale: expired || stale, ttlMs: Math.max(0, entry.expires - now) };
    } catch (_) {
      this._map.delete(key);
      return null;
    }
  }

  /** Stores value; returns true */
  set(key, value, ttlMs, tags = []) {
    if (this._map.size >= this._max) this._evictOldest();
    const serialized = JSON.stringify(value);
    const { raw, compressed } = tryCompress(serialized);
    this._map.set(key, {
      raw, compressed,
      expires   : Date.now() + ttlMs,
      ttlMs,
      tags,
      allowStale: true,
      setAt     : Date.now(),
    });
    return true;
  }

  delete(key)         { return this._map.delete(key); }
  clear()             { const n = this._map.size; this._map.clear(); return n; }
  get size()          { return this._map.size; }
  keys()              { return [...this._map.keys()]; }

  /** Invalidate all entries carrying a given tag */
  invalidateByTag(tag) {
    let n = 0;
    for (const [k, v] of this._map) {
      if (v.tags?.includes(tag)) { this._map.delete(k); n++; }
    }
    return n;
  }

  info() {
    return {
      name       : this.name,
      size       : this._map.size,
      maxSize    : this._max,
      evictions  : this.evictions,
      utilization: +((this._map.size / this._max) * 100).toFixed(1) + '%',
    };
  }
}

// ── The two tiers ────────────────────────────────────────────────
const L1 = new LRUTier(CFG.L1_MAX,  'L1-Hot');
const L2 = new LRUTier(CFG.L2_MAX,  'L2-Warm');

// ── Adaptive TTL ─────────────────────────────────────────────────
const _hitCount = new Map();
setInterval(() => _hitCount.clear(), CFG.METRICS_RESET);

function adaptiveTTL(key, baseTTL) {
  const hits = (_hitCount.get(key) || 0) + 1;
  _hitCount.set(key, hits);
  return Math.min(
    Math.max(baseTTL * Math.pow(1.3, Math.min(hits - 1, CFG.ADAPTIVE_CAP)), CFG.MIN_TTL),
    CFG.MAX_TTL
  );
}

// ═══════════════════════════════════════════════════════════════════
//  Public API
// ═══════════════════════════════════════════════════════════════════

/** Get from cache. Returns { value, stale, ttlMs, source } or null */
function get(key) {
  const l1 = L1.get(key);
  if (l1) { m.hits++; if (l1.stale) m.staleHits++; return { ...l1, source: 'L1' }; }

  const l2 = L2.get(key);
  if (l2) {
    m.hits++;
    if (l2.stale) m.staleHits++;
    // Promote to L1
    L1.set(key, l2.value, Math.min(l2.ttlMs, CFG.DEFAULT_TTL * 2));
    return { ...l2, source: 'L2' };
  }

  m.misses++;
  return null;
}

/** Set in both tiers with adaptive TTL */
function set(key, value, baseTTL = CFG.DEFAULT_TTL, tags = []) {
  const ttl = adaptiveTTL(key, baseTTL);
  L1.set(key, value, Math.min(ttl, CFG.DEFAULT_TTL * 2), tags);
  L2.set(key, value, ttl, tags);
}

/** Delete from both tiers */
function del(key) { L1.delete(key); L2.delete(key); }

/** Invalidate all entries with a given tag */
function invalidateTag(tag) {
  const n = L1.invalidateByTag(tag) + L2.invalidateByTag(tag);
  log.info(`Tag invalidation: "${tag}" — ${n} entries removed`);
  return n;
}

// ── In-flight dedup map ──────────────────────────────────────────
const inflight = new Map();

/**
 * Cache-aside with SWR.
 * - Fresh hit  → return cached value
 * - Stale hit  → return stale immediately, refresh in background
 * - Miss       → await fetcher, cache result
 * - In-flight  → coalesce into the same promise
 */
async function getOrFetch(key, fetcher, baseTTL = CFG.DEFAULT_TTL, tags = []) {
  const cached = get(key);

  if (cached && !cached.stale) return cached.value;

  if (cached && cached.stale) {
    // Background refresh — serve stale immediately
    if (!inflight.has(key)) {
      m.inflight++;
      const p = fetcher()
        .then(fresh => { set(key, fresh, baseTTL, tags); return fresh; })
        .catch(err  => { m.errors++; log.warn(`BG refresh failed: ${key}`, { msg: err.message }); })
        .finally(() => { inflight.delete(key); m.inflight--; });
      inflight.set(key, p);
    }
    return cached.value;
  }

  // Miss — check in-flight
  if (inflight.has(key)) return inflight.get(key);

  m.inflight++;
  const p = fetcher()
    .then(fresh  => { set(key, fresh, baseTTL, tags); return fresh; })
    .catch(err   => { m.errors++; inflight.delete(key); m.inflight--; throw err; })
    .finally(() => { inflight.delete(key); m.inflight--; });

  inflight.set(key, p);
  return p;
}

// ── Memory-pressure eviction ─────────────────────────────────────
function checkMemPressure() {
  const ratio = process.memoryUsage().rss / os.totalmem();
  if (ratio > CFG.MEM_THRESHOLD) {
    const evictN = Math.ceil(L2.size * 0.20);
    L2.keys().slice(0, evictN).forEach(k => L2.delete(k));
    log.warn(`Memory pressure (${(ratio * 100).toFixed(1)}%) — evicted ${evictN} L2 entries`);
  }
}
setInterval(checkMemPressure, 30_000);

// ═══════════════════════════════════════════════════════════════════
//  Admin REST router  (mounted at /api/v1/cache by server.js)
// ═══════════════════════════════════════════════════════════════════
const router = express.Router();

router.get('/stats', (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    metrics  : m.snapshot(),
    l1       : L1.info(),
    l2       : L2.info(),
    inflight : inflight.size,
    memory   : {
      rssMB   : +(mem.rss        / 1048576).toFixed(1),
      heapMB  : +(mem.heapUsed   / 1048576).toFixed(1),
      totalMB : +(os.totalmem()  / 1048576).toFixed(0),
      pressure: +((mem.rss / os.totalmem()) * 100).toFixed(1) + '%',
    },
    config   : CFG,
  });
});

router.delete('/all', (req, res) => {
  const l1 = L1.clear();
  const l2 = L2.clear();
  inflight.clear();
  _hitCount.clear();
  log.info('Full cache clear', { l1, l2 });
  res.json({ cleared: { l1, l2 }, message: 'Cache cleared' });
});

router.delete('/tag/:tag', (req, res) => {
  const n = invalidateTag(req.params.tag);
  res.json({ invalidated: n, tag: req.params.tag });
});

router.delete('/key/:key', (req, res) => {
  del(decodeURIComponent(req.params.key));
  res.json({ deleted: req.params.key });
});

router.get('/keys', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 500);
  res.json({ l1: L1.keys().slice(0, limit), l2: L2.keys().slice(0, limit) });
});

// ═══════════════════════════════════════════════════════════════════
//  Exports
// ═══════════════════════════════════════════════════════════════════
module.exports = {
  get, set, del, invalidateTag, getOrFetch,
  metrics: m,
  L1, L2,
  router,
  CFG,
};
