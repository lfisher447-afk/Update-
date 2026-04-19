'use strict';

// ═══════════════════════════════════════════════════════════════════
//  BingeBox Omega — server.js  v3.0 (Monolithic Core)
//  Main Railway entry point.
// ═══════════════════════════════════════════════════════════════════

const fs          = require('fs');
const path        = require('path');
const os          = require('os');
const https       = require('https');
const zlib        = require('zlib');
const express     = require('express');
const helmet      = require('helmet');
const cors        = require('cors');
const compression = require('compression');

// ═══════════════════════════════════════════════════════════════════
//  1. LOGGER MODULE
// ═══════════════════════════════════════════════════════════════════
const Logger = (() => {
  const IS_PROD   = (process.env.NODE_ENV || 'production') === 'production';
  const LOG_DIR   = process.env.LOG_DIR || path.join(process.cwd(), 'logs');
  const MIN_LEVEL = (process.env.LOG_LEVEL || (IS_PROD ? 'INFO' : 'DEBUG')).toUpperCase();
  const RING_MAX  = 300;

  const LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3, FATAL: 4 };

  const C = IS_PROD ? {} : {
    RESET: '\x1b[0m', BOLD: '\x1b[1m', DIM: '\x1b[2m',
    DEBUG: '\x1b[36m', INFO: '\x1b[32m', WARN: '\x1b[33m',
    ERROR: '\x1b[31m', FATAL: '\x1b[35m',
  };
  const c = k => C[k] || '';

  const SENSITIVE = new Set([
    'api_key', 'apikey', 'authorization', 'password',
    'token', 'secret', 'cookie', 'x-api-key',
  ]);

  function redact(obj, depth = 0) {
    if (depth > 5 || !obj || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(v => redact(v, depth + 1));
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = SENSITIVE.has(k.toLowerCase()) ? '[REDACTED]' : redact(v, depth + 1);
    }
    return out;
  }

  const ring =[];
  function pushRing(entry) {
    ring.push(entry);
    if (ring.length > RING_MAX) ring.shift();
  }

  let _stream = null;
  let _day    = '';

  function fileStream() {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== _day || !_stream) {
      try { _stream?.end(); } catch (_) {}
      _day = today;
      try {
        fs.mkdirSync(LOG_DIR, { recursive: true });
        _stream = fs.createWriteStream(
          path.join(LOG_DIR, `bingebox-${today}.log`),
          { flags: 'a', encoding: 'utf8' }
        );
      } catch (_) { _stream = null; }
    }
    return _stream;
  }

  function pruneOldLogs() {
    try {
      if (!fs.existsSync(LOG_DIR)) return;
      const cutoff = Date.now() - 14 * 86_400_000;
      fs.readdirSync(LOG_DIR)
        .filter(f => f.endsWith('.log'))
        .map(f => path.join(LOG_DIR, f))
        .filter(fp => fs.statSync(fp).mtimeMs < cutoff)
        .forEach(fp => fs.unlinkSync(fp));
    } catch (_) {}
  }
  setInterval(pruneOldLogs, 6 * 3_600_000);
  pruneOldLogs();

  function write(level, ctx, msg, meta) {
    if ((LEVELS[level] ?? 0) < (LEVELS[MIN_LEVEL] ?? 0)) return;

    const entry = {
      level, ts: new Date().toISOString(),
      context: ctx, message: msg, pid: process.pid,
      host: os.hostname(),
      ...(meta ? { meta: redact(meta) } : {}),
    };

    pushRing(entry);

    const line = JSON.stringify(entry) + '\n';
    if (IS_PROD) {
      process.stdout.write(line);
    } else {
      const col   = c(level);
      const reset = c('RESET');
      const dim   = c('DIM');
      const bold  = c('BOLD');
      const metaStr = meta
        ? `\n  ${dim}${JSON.stringify(redact(meta), null, 2).replace(/\n/g, '\n  ')}${reset}`
        : '';
      process.stdout.write(
        `${dim}${entry.ts}${reset} ${col}${bold}[${level.padEnd(5)}]${reset} ` +
        `${dim}[${ctx}]${reset} ${msg}${metaStr}\n`
      );
    }
    fileStream()?.write(line);
  }

  function createLogger(context = 'APP') {
    return {
      debug : (msg, meta) => write('DEBUG', context, msg, meta),
      info  : (msg, meta) => write('INFO',  context, msg, meta),
      warn  : (msg, meta) => write('WARN',  context, msg, meta),
      error : (msg, meta) => write('ERROR', context, msg, meta),
      fatal : (msg, meta) => write('FATAL', context, msg, meta),
      time(label) {
        const t0 = process.hrtime.bigint();
        return (extra = {}) => {
          const ms = Number(process.hrtime.bigint() - t0) / 1e6;
          write('DEBUG', context, `${label} — ${ms.toFixed(2)}ms`, extra);
          return ms;
        };
      },
      child(sub) { return createLogger(`${context}:${sub}`); },
    };
  }

  const root = createLogger('BingeBox');

  function requestLogger(options = {}) {
    const skip   = options.skip || (req => /^\/(health|favicon\.ico|robots\.txt)/.test(req.path));
    const httpLog = createLogger('HTTP');
    return function logRequest(req, res, next) {
      if (skip(req)) return next();
      const t0 = process.hrtime.bigint();
      const id = req.headers['x-request-id'] || '-';
      httpLog.debug(`→ ${req.method} ${req.path}`, {
        id, ip : req.ip,
        ua : (req.headers['user-agent'] || '').slice(0, 80),
        q  : Object.keys(req.query).length ? redact(req.query) : undefined,
      });

      res.on('finish', () => {
        const ms    = Number(process.hrtime.bigint() - t0) / 1e6;
        const level = res.statusCode >= 500 ? 'ERROR' : res.statusCode >= 400 ? 'WARN' : 'INFO';
        write(level, 'HTTP', `${req.method} ${req.path} ${res.statusCode} ${ms.toFixed(0)}ms`, {
          id, status: res.statusCode,
          ms: parseFloat(ms.toFixed(2)),
          ip: req.ip,
          bytes: parseInt(res.getHeader('content-length') || '0', 10) || undefined,
        });
      });
      next();
    };
  }

  function logsHandler(req, res) {
    if (IS_PROD && req.ip !== '127.0.0.1' && req.ip !== '::1') {
      return res.status(403).json({ error: 'forbidden' });
    }
    const filterLevel = (req.query.level || '').toUpperCase();
    const limit       = Math.min(parseInt(req.query.limit || '100', 10), RING_MAX);
    const entries     = filterLevel && LEVELS[filterLevel] != null
      ? ring.filter(e => LEVELS[e.level] >= LEVELS[filterLevel])
      : ring;
    const slice = entries.slice(-limit);
    res.json({ total: ring.length, returned: slice.length, entries: slice });
  }

  process.on('unhandledRejection', reason => root.error('Unhandled Promise Rejection', { reason: String(reason) }));
  process.on('uncaughtException', err => {
    root.fatal('Uncaught Exception', { message: err.message, stack: err.stack?.split('\n').slice(0, 4).join(' ← ') });
    setTimeout(() => process.exit(1), 500);
  });

  return { createLogger, root, requestLogger, logsHandler, getBuffer: () =>[...ring] };
})();

const createLogger  = Logger.createLogger;
const requestLogger = Logger.requestLogger;
const logsHandler   = Logger.logsHandler;
const log           = createLogger('Server');


// ═══════════════════════════════════════════════════════════════════
//  2. CACHE MANAGER MODULE
// ═══════════════════════════════════════════════════════════════════
const CacheManager = (() => {
  const cacheLog = createLogger('Cache');

  const CFG = {
    L1_MAX         : 300,
    L2_MAX         : 2_000,
    DEFAULT_TTL    : 5   * 60_000,
    MAX_TTL        : 60  * 60_000,
    MIN_TTL        : 30  * 1_000,
    COMPRESS_BYTES : 4_096,
    MEM_THRESHOLD  : 0.85,
    SWR_WINDOW     : 30  * 1_000,
    METRICS_RESET  : 60  * 60_000,
    ADAPTIVE_CAP   : 8,
  };

  const m = {
    hits: 0, misses: 0, staleHits: 0, evictions: 0,
    compressions: 0, decompressions: 0, errors: 0, inflight: 0,
    reset() { this.hits = this.misses = this.staleHits = this.evictions = this.compressions = this.decompressions = this.errors = this.inflight = 0; },
    snapshot() { const total = this.hits + this.misses; return { ...this, hitRate: total ? +(this.hits / total).toFixed(4) : 0, total }; },
  };
  setInterval(() => m.reset(), CFG.METRICS_RESET);

  function tryCompress(str) {
    if (!str || str.length < CFG.COMPRESS_BYTES) return { raw: str, compressed: false };
    try { const buf = zlib.gzipSync(Buffer.from(str, 'utf8')); m.compressions++; return { raw: buf, compressed: true }; } 
    catch (_) { return { raw: str, compressed: false }; }
  }

  function tryDecompress(entry) {
    if (!entry.compressed) return entry.raw;
    try { m.decompressions++; return zlib.gunzipSync(entry.raw).toString('utf8'); } 
    catch (_) { return null; }
  }

  class LRUTier {
    constructor(maxSize, name) { this._map = new Map(); this._max = maxSize; this.name = name; this.evictions = 0; }
    _evictOldest() { const key = this._map.keys().next().value; if (key !== undefined) { this._map.delete(key); this.evictions++; m.evictions++; } }
    get(key) {
      const entry = this._map.get(key);
      if (!entry) return null;
      this._map.delete(key); this._map.set(key, entry);
      const now = Date.now(), expired = now > entry.expires, stale = !expired && now > (entry.expires - CFG.SWR_WINDOW);
      if (expired && !entry.allowStale) return null;
      try {
        const raw = tryDecompress(entry);
        if (raw === null) { this._map.delete(key); return null; }
        return { value: JSON.parse(raw), stale: expired || stale, ttlMs: Math.max(0, entry.expires - now) };
      } catch (_) { this._map.delete(key); return null; }
    }
    set(key, value, ttlMs, tags =[]) {
      if (this._map.size >= this._max) this._evictOldest();
      const { raw, compressed } = tryCompress(JSON.stringify(value));
      this._map.set(key, { raw, compressed, expires: Date.now() + ttlMs, ttlMs, tags, allowStale: true, setAt: Date.now() });
      return true;
    }
    delete(key) { return this._map.delete(key); }
    clear() { const n = this._map.size; this._map.clear(); return n; }
    get size() { return this._map.size; }
    keys() { return[...this._map.keys()]; }
    invalidateByTag(tag) { let n = 0; for (const [k, v] of this._map) { if (v.tags?.includes(tag)) { this._map.delete(k); n++; } } return n; }
    info() { return { name: this.name, size: this._map.size, maxSize: this._max, evictions: this.evictions, utilization: +((this._map.size / this._max) * 100).toFixed(1) + '%' }; }
  }

  const L1 = new LRUTier(CFG.L1_MAX, 'L1-Hot');
  const L2 = new LRUTier(CFG.L2_MAX, 'L2-Warm');
  const _hitCount = new Map();
  setInterval(() => _hitCount.clear(), CFG.METRICS_RESET);

  function adaptiveTTL(key, baseTTL) {
    const hits = (_hitCount.get(key) || 0) + 1; _hitCount.set(key, hits);
    return Math.min(Math.max(baseTTL * Math.pow(1.3, Math.min(hits - 1, CFG.ADAPTIVE_CAP)), CFG.MIN_TTL), CFG.MAX_TTL);
  }

  function get(key) {
    const l1 = L1.get(key);
    if (l1) { m.hits++; if (l1.stale) m.staleHits++; return { ...l1, source: 'L1' }; }
    const l2 = L2.get(key);
    if (l2) { m.hits++; if (l2.stale) m.staleHits++; L1.set(key, l2.value, Math.min(l2.ttlMs, CFG.DEFAULT_TTL * 2)); return { ...l2, source: 'L2' }; }
    m.misses++; return null;
  }

  function set(key, value, baseTTL = CFG.DEFAULT_TTL, tags =[]) {
    const ttl = adaptiveTTL(key, baseTTL);
    L1.set(key, value, Math.min(ttl, CFG.DEFAULT_TTL * 2), tags); L2.set(key, value, ttl, tags);
  }

  function del(key) { L1.delete(key); L2.delete(key); }
  function invalidateTag(tag) { const n = L1.invalidateByTag(tag) + L2.invalidateByTag(tag); cacheLog.info(`Tag invalidation: "${tag}" — ${n} entries removed`); return n; }

  const inflight = new Map();
  async function getOrFetch(key, fetcher, baseTTL = CFG.DEFAULT_TTL, tags =[]) {
    const cached = get(key);
    if (cached && !cached.stale) return cached.value;
    if (cached && cached.stale) {
      if (!inflight.has(key)) {
        m.inflight++;
        const p = fetcher().then(fresh => { set(key, fresh, baseTTL, tags); return fresh; }).catch(err => { m.errors++; cacheLog.warn(`BG refresh failed: ${key}`, { msg: err.message }); }).finally(() => { inflight.delete(key); m.inflight--; });
        inflight.set(key, p);
      }
      return cached.value;
    }
    if (inflight.has(key)) return inflight.get(key);
    m.inflight++;
    const p = fetcher().then(fresh => { set(key, fresh, baseTTL, tags); return fresh; }).catch(err => { m.errors++; inflight.delete(key); m.inflight--; throw err; }).finally(() => { inflight.delete(key); m.inflight--; });
    inflight.set(key, p); return p;
  }

  setInterval(() => {
    const ratio = process.memoryUsage().rss / os.totalmem();
    if (ratio > CFG.MEM_THRESHOLD) { const evictN = Math.ceil(L2.size * 0.20); L2.keys().slice(0, evictN).forEach(k => L2.delete(k)); cacheLog.warn(`Memory pressure (${(ratio * 100).toFixed(1)}%) — evicted ${evictN} L2 entries`); }
  }, 30_000);

  const router = express.Router();
  router.get('/stats', (req, res) => {
    const mem = process.memoryUsage();
    res.json({ metrics: m.snapshot(), l1: L1.info(), l2: L2.info(), inflight: inflight.size, memory: { rssMB: +(mem.rss/1048576).toFixed(1), heapMB: +(mem.heapUsed/1048576).toFixed(1), totalMB: +(os.totalmem()/1048576).toFixed(0), pressure: +((mem.rss / os.totalmem()) * 100).toFixed(1) + '%' }, config: CFG });
  });
  router.delete('/all', (req, res) => { const l1 = L1.clear(), l2 = L2.clear(); inflight.clear(); _hitCount.clear(); cacheLog.info('Full cache clear', { l1, l2 }); res.json({ cleared: { l1, l2 }, message: 'Cache cleared' }); });
  router.delete('/tag/:tag', (req, res) => res.json({ invalidated: invalidateTag(req.params.tag), tag: req.params.tag }));
  router.delete('/key/:key', (req, res) => { del(decodeURIComponent(req.params.key)); res.json({ deleted: req.params.key }); });
  router.get('/keys', (req, res) => { const limit = Math.min(parseInt(req.query.limit || '50', 10), 500); res.json({ l1: L1.keys().slice(0, limit), l2: L2.keys().slice(0, limit) }); });

  return { get, set, del, invalidateTag, getOrFetch, router };
})();


// ═══════════════════════════════════════════════════════════════════
//  3. SECURITY CONFIG MODULE
// ═══════════════════════════════════════════════════════════════════
const SecurityConfig = (() => {
  const secLog = createLogger('Security');

  const EMBED_ORIGINS =[
    'vidsrc.pro', '*.vidsrc.pro', 'vidsrc.me', '*.vidsrc.me', 'vidsrc.cc', '*.vidsrc.cc',
    'vidsrc.icu', '*.vidsrc.icu', 'vidlink.pro', '*.vidlink.pro', 'videasy.net', 'player.videasy.net',
    'multiembed.mov', '*.multiembed.mov', 'autoembed.cc', '*.autoembed.cc', '2embed.cc', '*.2embed.cc',
    'embedrise.com', '*.embedrise.com', 'superembed.stream', '*.superembed.stream', 'smashystream.com', '*.smashystream.com',
    'blackbox.wtf', '*.blackbox.wtf', 'vidcloud.co', '*.vidcloud.co', 'www.youtube.com',
  ];

  const helmetMw = helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc        : ["'self'"],
        scriptSrc         :["'self'", 'cdn.tailwindcss.com', 'cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'unpkg.com', "'unsafe-eval'"],
        styleSrc          :["'self'", "'unsafe-inline'", 'fonts.googleapis.com', 'cdn.jsdelivr.net', 'cdnjs.cloudflare.com'],
        fontSrc           : ["'self'", 'fonts.gstatic.com', 'cdnjs.cloudflare.com', 'data:'],
        imgSrc            :["'self'", 'image.tmdb.org', 'media.themoviedb.org', 'api.dicebear.com', 'secure.gravatar.com', 'via.placeholder.com', 'data:', 'blob:'],
        mediaSrc          :["'self'", 'blob:', ...EMBED_ORIGINS],
        connectSrc        :["'self'", 'api.themoviedb.org', 'https://api.themoviedb.org', 'wss://echo.websocket.events'],
        frameSrc          :["'self'", ...EMBED_ORIGINS],
        frameAncestors    : ["'none'"],
        workerSrc         : ["'self'", 'blob:'],
        childSrc          :["'self'", 'blob:', ...EMBED_ORIGINS],
        objectSrc         : ["'none'"],
        manifestSrc       :["'self'"],
        baseUri           : ["'self'"],
        formAction        :["'self'"],
        upgradeInsecureRequests:[],
      },
    },
    strictTransportSecurity: { maxAge: 31_536_000, includeSubDomains: true, preload: true },
    referrerPolicy       : { policy: 'strict-origin-when-cross-origin' },
    frameguard           : { action: 'deny' },
    hidePoweredBy        : true,
    noSniff              : true,
    ieNoOpen             : true,
    xssFilter            : true,
    dnsPrefetchControl   : { allow: true },
    crossOriginEmbedderPolicy: false,
  });

  function additionalHeaders(req, res, next) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-BingeBox-Server', `Omega/${process.env.npm_package_version || '3.0.0'}`);
    if (!res.getHeader('X-BingeBox-Cache')) res.setHeader('X-BingeBox-Cache', 'MISS');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(self), geolocation=(), payment=(), usb=(), bluetooth=(), fullscreen=(self), picture-in-picture=(self), autoplay=(self), encrypted-media=(self)');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.removeHeader('X-Powered-By'); res.removeHeader('Server');
    next();
  }

  const BOT_RX =[/scrapy/i, /python-requests/i, /go-http-client/i, /java\//i, /zgrab/i, /masscan/i, /nmap/i];
  function botDetection(req, res, next) {
    const ua = (req.headers['user-agent'] || '').trim();
    if (!ua) { res.setHeader('X-BingeBox-Client-Type', 'headless'); return next(); }
    if (BOT_RX.some(rx => rx.test(ua))) {
      secLog.warn('Bot blocked', { ip: req.ip, ua: ua.slice(0, 100) });
      return res.status(403).json({ error: 'forbidden', message: 'Automated clients are not permitted.' });
    }
    next();
  }

  const RATE = { windowMs: 60_000, maxHits: 200, blockMs: 5 * 60_000, skip: new Set(['/health', '/health/ready', '/favicon.ico', '/robots.txt']) };
  const _store = new Map();
  setInterval(() => { const now = Date.now(); for (const [ip, e] of _store) { if (!e.hits.length || now - e.hits[e.hits.length - 1] > RATE.blockMs * 2) _store.delete(ip); } }, 10 * 60_000);

  function rateLimiter(req, res, next) {
    if (RATE.skip.has(req.path)) return next();
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const now = Date.now();
    let e = _store.get(ip);
    if (!e) { e = { hits:[], blocked: false, blockedUntil: 0 }; _store.set(ip, e); }
    if (e.blocked) {
      if (now < e.blockedUntil) {
        const retryAfter = Math.ceil((e.blockedUntil - now) / 1000);
        res.setHeader('Retry-After', retryAfter);
        return res.status(429).json({ error: 'rate_limited', message: 'Too many requests — please slow down.', retryAfter });
      }
      e.blocked = false; e.blockedUntil = 0; e.hits =[];
    }
    e.hits = e.hits.filter(t => now - t < RATE.windowMs); e.hits.push(now);
    const remaining = Math.max(0, RATE.maxHits - e.hits.length);
    res.setHeader('X-RateLimit-Limit', RATE.maxHits); res.setHeader('X-RateLimit-Remaining', remaining); res.setHeader('X-RateLimit-Reset', Math.ceil((now + RATE.windowMs) / 1000));
    if (e.hits.length > RATE.maxHits) {
      e.blocked = true; e.blockedUntil = now + RATE.blockMs;
      secLog.warn('Rate limit exceeded', { ip, hits: e.hits.length });
      return res.status(429).json({ error: 'rate_limited', message: 'Rate limit exceeded.', retryAfter: RATE.blockMs / 1000 });
    }
    next();
  }

  return[helmetMw, additionalHeaders, botDetection, rateLimiter];
})();


// ═══════════════════════════════════════════════════════════════════
//  4. CORS CONFIG MODULE
// ═══════════════════════════════════════════════════════════════════
const CorsConfig = (() => {
  const corsLog = createLogger('CORS');
  const IS_DEV = process.env.NODE_ENV !== 'production';
  const STATIC_ORIGINS =['http://localhost:3000', 'http://localhost:5000', 'http://127.0.0.1:3000', 'http://127.0.0.1:5000'];

  function buildAllowList() {
    const env =[];
    if (process.env.CLIENT_URL) env.push(...process.env.CLIENT_URL.split(',').map(s => s.trim()).filter(Boolean));
    if (process.env.STAGING_URL) env.push(process.env.STAGING_URL.trim());
    if (process.env.PREVIEW_URL) env.push(process.env.PREVIEW_URL.trim());
    return [...new Set([...STATIC_ORIGINS, ...env])];
  }

  const TRUSTED_PATTERNS = [
    /^https:\/\/([\w-]+\.)?bingebox\.(tv|app|io)$/,
    /^https:\/\/[\w-]+-bingebox\.vercel\.app$/,
    /^https:\/\/[\w-]+-bingebox\.netlify\.app$/,
    /^https:\/\/[\w-]+\.up\.railway\.app$/,
    /^https:\/\/[\w-]+\.railway\.app$/,
  ];

  const _rejected = new Map();
  function trackRejection(origin) {
    if (_rejected.size > 200) return;
    const e = _rejected.get(origin) || { count: 0, first: Date.now() }; e.count++; _rejected.set(origin, e);
  }

  function isAllowed(origin) {
    if (!origin) return true;
    if (buildAllowList().includes(origin)) return true;
    if (TRUSTED_PATTERNS.some(rx => rx.test(origin))) return true;
    return false;
  }

  const corsOptions = {
    origin(origin, cb) {
      if (isAllowed(origin)) { if (IS_DEV) corsLog.debug('ALLOW', { origin: origin || '<same-origin>' }); cb(null, true); } 
      else { trackRejection(origin); corsLog.warn('BLOCK', { origin, rejections: _rejected.get(origin)?.count }); cb(new Error(`CORS: origin "${origin}" is not permitted`)); }
    },
    methods:['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
    allowedHeaders:['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Accept-Language', 'Cache-Control', 'X-BingeBox-Client', 'X-BingeBox-Version'],
    exposedHeaders:['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset', 'X-BingeBox-Cache', 'X-BingeBox-Server', 'Content-Length', 'Content-Range', 'ETag'],
    credentials: true, maxAge: 7_200, optionsSuccessStatus: 204, preflightContinue: false,
  };

  const _corsHandler = cors(corsOptions);
  function safeCors(req, res, next) {
    _corsHandler(req, res, err => {
      if (!err) return next();
      corsLog.error('CORS middleware error', { message: err.message, origin: req.headers.origin });
      res.setHeader('Content-Type', 'application/json');
      res.status(403).json({ error: 'cors_blocked', message: err.message, origin: req.headers.origin || null });
    });
  }

  return { safeCors, getCorsStats: () => ({ allowList: buildAllowList(), trustedPatterns: TRUSTED_PATTERNS.map(rx => rx.source), rejections: Object.fromEntries(_rejected) }) };
})();


// ═══════════════════════════════════════════════════════════════════
//  5. API PROXY MODULE
// ═══════════════════════════════════════════════════════════════════
const ApiProxy = (() => {
  const router = express.Router();
  const proxyLog = createLogger('Proxy');
  
  const TMDB_BASE   = 'https://api.themoviedb.org/3';
  const TMDB_KEY    = process.env.TMDB_API_KEY || '15d2ea6d0dc1d476efbca3eba2b9bbfb';
  const REQ_TIMEOUT = 8_000;
  const MAX_RETRIES = 2;
  const BACKOFF     = 300;

  const TTL_MAP = [['/trending', 60_000], ['/search', 90_000],['/discover', 3*60_000], ['/movie', 10*60_000],['/tv', 10*60_000],['/genre', 60*60_000], ['/person', 30*60_000]];
  function getTTL(p) { for (const [prefix, ttl] of TTL_MAP) if (p.startsWith(prefix)) return ttl; return 5 * 60_000; }

  const circuit = {
    failures: 0, lastFail: 0, threshold: 10, resetAfter: 60_000,
    isOpen() { if (this.failures < this.threshold) return false; if (Date.now() - this.lastFail > this.resetAfter) { this.failures = 0; return false; } return true; },
    record(ok) { if (ok) { this.failures = 0; } else { this.failures++; this.lastFail = Date.now(); } },
  };

  function tmdbFetch(rawPath, params = {}, attempt = 0) {
    return new Promise((resolve, reject) => {
      const cleanPath = '/' + rawPath.replace(/^\/+/, '');
      const qs = new URLSearchParams({ api_key: TMDB_KEY, ...params }).toString();
      const url = `${TMDB_BASE}${cleanPath}?${qs}`;

      proxyLog.debug(`→ TMDB ${cleanPath}`, { attempt, params: Object.keys(params) });

      const req = https.get(url, { headers: { Accept: 'application/json', 'User-Agent': 'BingeBox-Omega/3.0' }, timeout: REQ_TIMEOUT }, res => {
        let body = ''; res.setEncoding('utf8');
        res.on('data', d => { body += d; });
        res.on('end', () => {
          if (res.statusCode === 429 && attempt < MAX_RETRIES) {
            const wait = BACKOFF * Math.pow(2, attempt);
            proxyLog.warn(`TMDB 429 — retrying in ${wait}ms`, { path: cleanPath, attempt });
            return setTimeout(() => tmdbFetch(rawPath, params, attempt + 1).then(resolve).catch(reject), wait);
          }
          if (res.statusCode >= 400) { circuit.record(false); return reject(Object.assign(new Error(`TMDB ${res.statusCode}: ${cleanPath}`), { status: res.statusCode })); }
          try { const data = JSON.parse(body); circuit.record(true); resolve(data); } 
          catch (e) { circuit.record(false); reject(Object.assign(new Error('TMDB JSON parse error'), { status: 502 })); }
        });
      });
      req.on('timeout', () => { req.destroy(); circuit.record(false); reject(Object.assign(new Error(`TMDB timeout: ${cleanPath}`), { status: 504 })); });
      req.on('error', err => {
        circuit.record(false);
        if ((err.code === 'ECONNRESET' || err.message === 'socket hang up') && attempt < MAX_RETRIES) {
          const wait = BACKOFF * Math.pow(2, attempt);
          return setTimeout(() => tmdbFetch(rawPath, params, attempt + 1).then(resolve).catch(reject), wait);
        }
        reject(Object.assign(err, { status: 502 }));
      });
    });
  }

  async function proxiedFetch(path, params = {}) {
    if (circuit.isOpen()) throw Object.assign(new Error('TMDB circuit breaker OPEN — service temporarily unavailable'), { status: 503 });
    const cacheKey = `tmdb:${path}:${new URLSearchParams(params).toString()}`;
    return CacheManager.getOrFetch(cacheKey, () => tmdbFetch(path, params), getTTL(path), ['tmdb']);
  }

  router.get('/tmdb/*', async (req, res) => {
    const tmdbPath = '/' + req.params[0], params = { ...req.query };
    delete params.api_key;
    try {
      const data = await proxiedFetch(tmdbPath, params);
      const ttlSecs = Math.floor(getTTL(tmdbPath) / 1000);
      const hit = CacheManager.get(`tmdb:${tmdbPath}:${new URLSearchParams(params).toString()}`);
      res.setHeader('Cache-Control', `public, max-age=${ttlSecs}`); res.setHeader('X-BingeBox-Cache', hit ? hit.source : 'FETCH');
      res.json(data);
    } catch (err) {
      proxyLog.error(`Proxy error ${tmdbPath}`, { msg: err.message, status: err.status });
      res.status(err.status || 502).json({ error: 'tmdb_error', message: err.message, path: tmdbPath });
    }
  });

  router.post('/tmdb/batch', express.json({ limit: '64kb' }), async (req, res) => {
    const { requests } = req.body || {};
    if (!Array.isArray(requests) || !requests.length || requests.length > 10) return res.status(400).json({ error: 'bad_request', message: 'Send 1–10 requests.' });
    const settled = await Promise.allSettled(requests.map(({ path: p, params }) => proxiedFetch(p, params || {})));
    res.json({ results: settled.map((r, i) => ({ path: requests[i].path, status: r.status === 'fulfilled' ? 'ok' : 'error', data: r.status === 'fulfilled' ? r.value : null, error: r.status === 'rejected' ? r.reason.message : null })) });
  });

  router.get('/tmdb/cache-info', (req, res) => {
    res.json({ cache: { l1: CacheManager.L1?.info() || {}, l2: CacheManager.L2?.info() || {} }, circuit: { failures: circuit.failures, threshold: circuit.threshold, isOpen: circuit.isOpen() } });
  });

  router.delete('/tmdb/cache', (req, res) => {
    const n = CacheManager.invalidateTag('tmdb');
    proxyLog.info('TMDB cache flushed', { invalidated: n });
    res.json({ invalidated: n, message: 'TMDB cache flushed' });
  });

  return router;
})();


// ═══════════════════════════════════════════════════════════════════
//  6. HEALTH MONITOR MODULE
// ═══════════════════════════════════════════════════════════════════
const HealthMonitor = (() => {
  const router = express.Router();
  const healthLog = createLogger('Health');

  const BOOT_TIME  = Date.now();
  const TMDB_PROBE = 'https://api.themoviedb.org/3/configuration';
  const TMDB_KEY   = process.env.TMDB_API_KEY || '15d2ea6d0dc1d476efbca3eba2b9bbfb';
  const PUBLIC_DIR = path.join(__dirname, 'public');

  let VERSION = '3.0.0';

  const THRESH = { CPU_WARN: 70, CPU_CRIT: 90, MEM_WARN: 75, MEM_CRIT: 90, HEAP_WARN_MB: 400, HEAP_CRIT_MB: 700, EL_WARN_MS: 50, EL_CRIT_MS: 200, PROBE_TIMEOUT: 5_000 };
  const state = { cpu: { current: 0, avg5s: 0, samples:[] }, memory: {}, heap: { usedMB: 0, totalMB: 0, externalMB: 0, rssMB: 0 }, eventLoop: { lagMs: 0, samples:[] }, checks: new Map(), incidents:[], sla: { downtimeMs: 0, lastDown: null } };

  let _overallStatus = 'ok', _lastCpuSamples = os.cpus() ||[];
  
  function sampleMetrics() {
    const cpus = os.cpus() ||[];
    if (cpus.length) {
      const deltas = cpus.map((cpu, i) => {
        const prev = _lastCpuSamples[i] || cpu, idle = cpu.times.idle - (prev.times?.idle || 0);
        const total = Object.values(cpu.times).reduce((a, b) => a + b, 0) - Object.values(prev.times || {}).reduce((a, b) => a + b, 0);
        return total > 0 ? (1 - idle / total) * 100 : 0;
      });
      _lastCpuSamples = cpus;
      const avg = deltas.reduce((a, b) => a + b, 0) / deltas.length;
      state.cpu.current = +avg.toFixed(1); state.cpu.samples.push(avg);
      if (state.cpu.samples.length > 30) state.cpu.samples.shift();
      state.cpu.avg5s = +(state.cpu.samples.reduce((a, b) => a + b, 0) / state.cpu.samples.length).toFixed(1);
    }
    const mem = process.memoryUsage(), total = os.totalmem(), free = os.freemem(), used = total - free, pct = (used / total) * 100;
    state.memory = { usedMB: +(used/1048576).toFixed(1), freeMB: +(free/1048576).toFixed(1), totalMB: +(total/1048576).toFixed(0), pct: +pct.toFixed(1) };
    state.heap = { usedMB: +(mem.heapUsed/1048576).toFixed(1), totalMB: +(mem.heapTotal/1048576).toFixed(1), externalMB: +(mem.external/1048576).toFixed(1), rssMB: +(mem.rss/1048576).toFixed(1) };
    
    const start = process.hrtime.bigint();
    setImmediate(() => {
      const lag = Number(process.hrtime.bigint() - start) / 1e6;
      state.eventLoop.samples.push(lag);
      if (state.eventLoop.samples.length > 10) state.eventLoop.samples.shift();
      state.eventLoop.lagMs = +(state.eventLoop.samples.reduce((a, b) => a + b, 0) / state.eventLoop.samples.length).toFixed(2);
    });
  }
  setInterval(sampleMetrics, 1_000);

  function registerCheck(name, fn, intervalMs = 30_000) {
    const entry = { status: 'unknown', lastCheck: null, latencyMs: 0, message: '', history:[] };
    state.checks.set(name, entry);
    async function run() {
      const t0 = Date.now();
      try {
        const r = await fn();
        entry.latencyMs = Date.now() - t0; entry.status = r.status || 'ok'; entry.message = r.message || ''; entry.lastCheck = new Date().toISOString();
      } catch (err) {
        entry.latencyMs = Date.now() - t0; entry.status = 'error'; entry.message = err.message; entry.lastCheck = new Date().toISOString();
        state.incidents.push({ ts: entry.lastCheck, check: name, message: err.message });
        if (state.incidents.length > 50) state.incidents.shift();
        healthLog.warn(`Health check FAIL: ${name}`, { msg: err.message });
      }
      entry.history.push(entry.status); if (entry.history.length > 10) entry.history.shift();
    }
    run(); setInterval(run, intervalMs);
  }

  registerCheck('tmdb-api', () => new Promise((resolve, reject) => {
    const req = https.get(`${TMDB_PROBE}?api_key=${TMDB_KEY}`, { timeout: THRESH.PROBE_TIMEOUT }, res => { const ok = res.statusCode === 200; resolve({ status: ok ? 'ok' : 'degraded', message: `HTTP ${res.statusCode}` }); res.resume(); });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('Probe timeout')));
  }), 60_000);

  registerCheck('static-files', async () => {
    const idx = path.join(PUBLIC_DIR, 'index.html');
    if (!fs.existsSync(idx)) throw new Error('public/index.html missing');
    return { status: 'ok', message: `${(fs.statSync(idx).size / 1024).toFixed(0)}KB` };
  }, 120_000);

  function calcStatus() {
    let status = 'ok';
    for (const [, c] of state.checks) { if (c.status === 'error') { status = 'down'; break; } if (c.status === 'degraded') status = 'degraded'; }
    if (state.cpu.avg5s > THRESH.CPU_CRIT || state.memory.pct > THRESH.MEM_CRIT || state.heap.usedMB > THRESH.HEAP_CRIT_MB || state.eventLoop.lagMs > THRESH.EL_CRIT_MS) status = 'degraded';
    if (status !== 'ok' && _overallStatus === 'ok') state.sla.lastDown = Date.now();
    if (status === 'ok' && _overallStatus !== 'ok' && state.sla.lastDown) { state.sla.downtimeMs += Date.now() - state.sla.lastDown; state.sla.lastDown = null; }
    _overallStatus = status; return status;
  }

  function formatUptime(ms) { const s = Math.floor(ms / 1000); return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h ${Math.floor((s % 3600) / 60)}m ${s % 60}s`; }

  router.get('/', (req, res) => { const status = calcStatus(); res.status(status === 'down' ? 503 : 200).json({ status, version: VERSION, uptime: formatUptime(Date.now() - BOOT_TIME) }); });
  router.get('/ready', (req, res) => { let ready = true; for (const [, c] of state.checks) if (c.status === 'error') { ready = false; break; } res.status(ready ? 200 : 503).json({ ready, ts: new Date().toISOString() }); });
  router.get('/detailed', (req, res) => { res.json({ status: calcStatus(), version: VERSION, uptime: { ms: Date.now() - BOOT_TIME, human: formatUptime(Date.now() - BOOT_TIME) }, cpu: state.cpu, memory: state.memory, heap: state.heap, eventLoop: state.eventLoop, checks: Object.fromEntries(state.checks) }); });

  return router;
})();


// ═══════════════════════════════════════════════════════════════════
//  7. EXPRESS APP SETUP
// ═══════════════════════════════════════════════════════════════════

const app        = express();
const PORT       = parseInt(process.env.PORT || '3000', 10);
const IS_PROD    = (process.env.NODE_ENV || 'production') === 'production';
const PUBLIC_DIR = path.join(__dirname, 'public');

app.set('trust proxy', 1);

// Middleware Stack
app.use(SecurityConfig);
app.use(CorsConfig.safeCors);
app.use(compression({
  threshold: 1024,
  filter   : (req, res) => {
    if (req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  },
}));
app.use(requestLogger());

// Static Files Serve
app.use(express.static(PUBLIC_DIR, {
  maxAge    : IS_PROD ? '1d' : 0,
  etag      : true,
  lastModified: true,
  index     : 'index.html',
  redirect  : false,
}));

// Route Assignments
app.use('/health', HealthMonitor);
app.use('/api/v1', ApiProxy);
app.use('/api/v1/cache', CacheManager.router);
app.get('/api/v1/logs', logsHandler);
app.get('/api/v1/cors-stats', (req, res) => res.json(CorsConfig.getCorsStats()));

// Catch-all SPA Route
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/health')) return next();
  const indexFile = path.join(PUBLIC_DIR, 'index.html');
  res.sendFile(indexFile, err => { if (err) next(err); });
});

// 404 & Global Error Handling
app.use((req, res) => res.status(404).json({ error: 'not_found', message: `${req.method} ${req.path} does not exist`, ts: new Date().toISOString() }));
app.use((err, req, res, next) => {
  const status  = err.status || err.statusCode || 500;
  const message = IS_PROD && status === 500 ? 'Internal server error' : err.message;
  log.error(`Unhandled error: ${req.method} ${req.path}`, { status, message: err.message, stack: err.stack?.split('\n').slice(0, 3).join(' ← ') });
  if (!res.headersSent) res.status(status).json({ error: 'server_error', message, ts: new Date().toISOString() });
});

// Boot the Server
const server = app.listen(PORT, '0.0.0.0', () => {
  log.info(`BingeBox Omega server started`, {
    port     : PORT,
    env      : process.env.NODE_ENV || 'production',
    public   : PUBLIC_DIR,
    pid      : process.pid,
    node     : process.version,
  });
  if (!process.env.TMDB_API_KEY) {
    log.warn('TMDB_API_KEY not set — using fallback key. Set it in Railway env vars.');
  }
});

function shutdown(signal) {
  log.info(`${signal} received — shutting down gracefully`);
  server.close(() => { log.info('HTTP server closed'); process.exit(0); });
  setTimeout(() => { log.warn('Forced exit after timeout'); process.exit(1); }, 10_000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

module.exports = app;
