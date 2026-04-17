'use strict';
// ═══════════════════════════════════════════════════════════════════
//  BingeBox Omega — api-proxy.js  v3.0
//  Express router mounted at /api/v1 by server.js.
//  All TMDB calls go through here — cache-manager handles L1/L2.
//
//  Routes (relative to mount point /api/v1):
//    GET  /tmdb/*         — proxy any TMDB endpoint
//    POST /tmdb/batch     — batch up to 10 TMDB requests in one call
//    GET  /tmdb/cache-info — live cache + circuit-breaker stats
//    DEL  /tmdb/cache     — flush the TMDB-related cache keys
// ═══════════════════════════════════════════════════════════════════

const https        = require('https');
const express      = require('express');
const cache        = require('./cache-manager');
const createLogger = require('./logger');

const router = express.Router();
const log    = createLogger('Proxy');

// ── Config ───────────────────────────────────────────────────────
const TMDB_BASE   = 'https://api.themoviedb.org/3';
const TMDB_KEY    = process.env.TMDB_API_KEY || '15d2ea6d0dc1d476efbca3eba2b9bbfb';
const REQ_TIMEOUT = 8_000;
const MAX_RETRIES = 2;
const BACKOFF     = 300;   // ms base for exponential back-off

// ── TTL per path prefix ──────────────────────────────────────────
const TTL_MAP = [
  ['/trending',  60_000],
  ['/search',    90_000],
  ['/discover',  3   * 60_000],
  ['/movie',     10  * 60_000],
  ['/tv',        10  * 60_000],
  ['/genre',     60  * 60_000],
  ['/person',    30  * 60_000],
];

function getTTL(p) {
  for (const [prefix, ttl] of TTL_MAP) if (p.startsWith(prefix)) return ttl;
  return 5 * 60_000;
}

// ── Circuit breaker ──────────────────────────────────────────────
const circuit = {
  failures  : 0,
  lastFail  : 0,
  threshold : 10,
  resetAfter: 60_000,

  isOpen() {
    if (this.failures < this.threshold) return false;
    if (Date.now() - this.lastFail > this.resetAfter) { this.failures = 0; return false; }
    return true;
  },
  record(ok) {
    if (ok) { this.failures = 0; }
    else    { this.failures++; this.lastFail = Date.now(); }
  },
};

// ═══════════════════════════════════════════════════════════════════
//  Core HTTPS fetch with retry + back-off
// ═══════════════════════════════════════════════════════════════════
function tmdbFetch(rawPath, params = {}, attempt = 0) {
  return new Promise((resolve, reject) => {
    // Normalise path: strip leading slashes to avoid double-slash 404s
    const cleanPath = '/' + rawPath.replace(/^\/+/, '');
    const qs        = new URLSearchParams({ api_key: TMDB_KEY, ...params }).toString();
    const url       = `${TMDB_BASE}${cleanPath}?${qs}`;

    log.debug(`→ TMDB ${cleanPath}`, { attempt, params: Object.keys(params) });

    const req = https.get(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'BingeBox-Omega/3.0' },
      timeout: REQ_TIMEOUT,
    }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', d => { body += d; });
      res.on('end', () => {
        // Rate-limited → retry with back-off
        if (res.statusCode === 429 && attempt < MAX_RETRIES) {
          const wait = BACKOFF * Math.pow(2, attempt);
          log.warn(`TMDB 429 — retrying in ${wait}ms`, { path: cleanPath, attempt });
          return setTimeout(() => tmdbFetch(rawPath, params, attempt + 1).then(resolve).catch(reject), wait);
        }

        if (res.statusCode >= 400) {
          circuit.record(false);
          const err = Object.assign(new Error(`TMDB ${res.statusCode}: ${cleanPath}`), { status: res.statusCode });
          return reject(err);
        }

        try {
          const data = JSON.parse(body);
          circuit.record(true);
          resolve(data);
        } catch (e) {
          circuit.record(false);
          reject(Object.assign(new Error('TMDB JSON parse error'), { status: 502 }));
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      circuit.record(false);
      reject(Object.assign(new Error(`TMDB timeout: ${cleanPath}`), { status: 504 }));
    });

    req.on('error', err => {
      circuit.record(false);
      // Network blip — retry
      if ((err.code === 'ECONNRESET' || err.message === 'socket hang up') && attempt < MAX_RETRIES) {
        const wait = BACKOFF * Math.pow(2, attempt);
        return setTimeout(() => tmdbFetch(rawPath, params, attempt + 1).then(resolve).catch(reject), wait);
      }
      reject(Object.assign(err, { status: 502 }));
    });
  });
}

// ═══════════════════════════════════════════════════════════════════
//  Cached + circuit-protected fetch
// ═══════════════════════════════════════════════════════════════════
async function proxiedFetch(path, params = {}) {
  if (circuit.isOpen()) {
    const err = Object.assign(
      new Error('TMDB circuit breaker OPEN — service temporarily unavailable'),
      { status: 503 }
    );
    throw err;
  }

  const cacheKey = `tmdb:${path}:${new URLSearchParams(params).toString()}`;
  const ttl      = getTTL(path);

  return cache.getOrFetch(
    cacheKey,
    () => tmdbFetch(path, params),
    ttl,
    ['tmdb']
  );
}

// ═══════════════════════════════════════════════════════════════════
//  Routes
// ═══════════════════════════════════════════════════════════════════

// ── Proxy any TMDB path  ─────────────────────────────────────────
// Frontend calls: GET /api/v1/tmdb/movie/popular?language=en-US
router.get('/tmdb/*', async (req, res) => {
  const tmdbPath = '/' + req.params[0];
  const params   = { ...req.query };
  delete params.api_key;   // never let the key leak from the frontend

  try {
    const data     = await proxiedFetch(tmdbPath, params);
    const ttlSecs  = Math.floor(getTTL(tmdbPath) / 1000);
    const cacheKey = `tmdb:${tmdbPath}:${new URLSearchParams(params).toString()}`;
    const hit      = cache.get(cacheKey);

    res.setHeader('Cache-Control',    `public, max-age=${ttlSecs}`);
    res.setHeader('X-BingeBox-Cache', hit ? hit.source : 'FETCH');
    res.json(data);
  } catch (err) {
    log.error(`Proxy error ${tmdbPath}`, { msg: err.message, status: err.status });
    res.status(err.status || 502).json({
      error  : 'tmdb_error',
      message: err.message,
      path   : tmdbPath,
    });
  }
});

// ── Batch endpoint  ─────────────────────────────────────────────
// Body: { requests: [{ path, params }, …] }  (max 10)
router.post('/tmdb/batch', express.json({ limit: '64kb' }), async (req, res) => {
  const { requests } = req.body || {};

  if (!Array.isArray(requests) || !requests.length || requests.length > 10) {
    return res.status(400).json({ error: 'bad_request', message: 'Send 1–10 requests.' });
  }

  const settled = await Promise.allSettled(
    requests.map(({ path: p, params }) => proxiedFetch(p, params || {}))
  );

  res.json({
    results: settled.map((r, i) => ({
      path  : requests[i].path,
      status: r.status === 'fulfilled' ? 'ok' : 'error',
      data  : r.status === 'fulfilled' ? r.value : null,
      error : r.status === 'rejected'  ? r.reason.message : null,
    })),
  });
});

// ── Cache + circuit info  ────────────────────────────────────────
router.get('/tmdb/cache-info', (req, res) => {
  res.json({
    cache  : { l1: cache.L1.info(), l2: cache.L2.info() },
    circuit: {
      failures : circuit.failures,
      threshold: circuit.threshold,
      isOpen   : circuit.isOpen(),
      resetIn  : circuit.isOpen()
        ? Math.max(0, circuit.resetAfter - (Date.now() - circuit.lastFail)) + 'ms'
        : null,
    },
  });
});

// ── Flush TMDB cache entries  ────────────────────────────────────
router.delete('/tmdb/cache', (req, res) => {
  const n = cache.invalidateTag('tmdb');
  log.info('TMDB cache flushed', { invalidated: n });
  res.json({ invalidated: n, message: 'TMDB cache flushed' });
});

module.exports        = router;
module.exports.circuit = circuit;
module.exports.proxiedFetch = proxiedFetch;
