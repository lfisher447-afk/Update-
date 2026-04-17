'use strict';
// ═══════════════════════════════════════════════════════════════════
//  BingeBox Omega — cors-config.js  v3.0
//  • Static + env-driven origin allowlist
//  • Regex patterns for Railway preview URLs, custom domains
//  • Per-origin rejection tracking
//  • Dev mode logs every decision; production only logs blocks
// ═══════════════════════════════════════════════════════════════════

const cors         = require('cors');
const createLogger = require('./logger');

const log   = createLogger('CORS');
const IS_DEV = process.env.NODE_ENV !== 'production';

// ── Static dev-time origins ───────────────────────────────────────
const STATIC_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:5000',
  'http://localhost:8080',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5000',
];

/** Build the full allowlist at call-time so env changes are picked up */
function buildAllowList() {
  const env = [];
  if (process.env.CLIENT_URL) {
    env.push(...process.env.CLIENT_URL.split(',').map(s => s.trim()).filter(Boolean));
  }
  if (process.env.STAGING_URL) env.push(process.env.STAGING_URL.trim());
  if (process.env.PREVIEW_URL) env.push(process.env.PREVIEW_URL.trim());
  return [...new Set([...STATIC_ORIGINS, ...env])];
}

// ── Trusted wildcard patterns ─────────────────────────────────────
// Covers Railway deployment URLs and any custom domains listed here
const TRUSTED_PATTERNS = [
  /^https:\/\/([\w-]+\.)?bingebox\.(tv|app|io)$/,
  /^https:\/\/[\w-]+-bingebox\.vercel\.app$/,
  /^https:\/\/[\w-]+-bingebox\.netlify\.app$/,
  /^https:\/\/[\w-]+\.up\.railway\.app$/,
  /^https:\/\/[\w-]+\.railway\.app$/,
];

// ── Rejection tracker (capped at 200 unique IPs) ─────────────────
const _rejected = new Map();

function trackRejection(origin) {
  if (_rejected.size > 200) return;
  const e = _rejected.get(origin) || { count: 0, first: Date.now() };
  e.count++;
  _rejected.set(origin, e);
}

// ── Origin decision ───────────────────────────────────────────────
function isAllowed(origin) {
  if (!origin) return true;                                       // same-origin / curl
  if (buildAllowList().includes(origin)) return true;
  if (TRUSTED_PATTERNS.some(rx => rx.test(origin))) return true;
  return false;
}

// ── cors() options ────────────────────────────────────────────────
const corsOptions = {
  origin(origin, cb) {
    if (isAllowed(origin)) {
      if (IS_DEV) log.debug('ALLOW', { origin: origin || '<same-origin>' });
      cb(null, true);
    } else {
      trackRejection(origin);
      log.warn('BLOCK', { origin, rejections: _rejected.get(origin)?.count });
      cb(new Error(`CORS: origin "${origin}" is not permitted`));
    }
  },
  methods         : ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
  allowedHeaders  : [
    'Content-Type', 'Authorization', 'X-Requested-With',
    'Accept', 'Accept-Language', 'Cache-Control',
    'X-BingeBox-Client', 'X-BingeBox-Version',
  ],
  exposedHeaders  : [
    'X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset',
    'X-BingeBox-Cache', 'X-BingeBox-Server',
    'Content-Length', 'Content-Range', 'ETag',
  ],
  credentials          : true,
  maxAge               : 7_200,
  optionsSuccessStatus : 204,
  preflightContinue    : false,
};

const _corsHandler = cors(corsOptions);

/** Wraps cors() so CORS errors become clean 403 JSON responses */
function safeCors(req, res, next) {
  _corsHandler(req, res, err => {
    if (!err) return next();
    log.error('CORS middleware error', { message: err.message, origin: req.headers.origin });
    res.setHeader('Content-Type', 'application/json');
    res.status(403).json({
      error  : 'cors_blocked',
      message: err.message,
      origin : req.headers.origin || null,
    });
  });
}

/** Expose stats for health-monitor */
function getCorsStats() {
  return {
    allowList      : buildAllowList(),
    trustedPatterns: TRUSTED_PATTERNS.map(rx => rx.source),
    rejections     : Object.fromEntries(_rejected),
  };
}

module.exports              = safeCors;
module.exports.safeCors     = safeCors;
module.exports.isAllowed    = isAllowed;
module.exports.getCorsStats = getCorsStats;
