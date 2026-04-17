'use strict';
// ═══════════════════════════════════════════════════════════════════
//  BingeBox Omega — security-config.js  v3.0
//  Exports an array of middleware applied globally by server.js:
//    [helmet, additionalHeaders, botDetection, rateLimiter]
// ═══════════════════════════════════════════════════════════════════

const helmet       = require('helmet');
const createLogger = require('./logger');

const log = createLogger('Security');

// ── Streaming embed sources (iframe / frame-src) ─────────────────
const EMBED_ORIGINS = [
  'vidsrc.pro',     '*.vidsrc.pro',
  'vidsrc.me',      '*.vidsrc.me',
  'vidsrc.cc',      '*.vidsrc.cc',
  'vidsrc.icu',     '*.vidsrc.icu',
  'vidlink.pro',    '*.vidlink.pro',
  'videasy.net',    'player.videasy.net',
  'multiembed.mov', '*.multiembed.mov',
  'autoembed.cc',   '*.autoembed.cc',
  '2embed.cc',      '*.2embed.cc',
  'embedrise.com',  '*.embedrise.com',
  'superembed.stream', '*.superembed.stream',
  'smashystream.com',  '*.smashystream.com',
  'blackbox.wtf',      '*.blackbox.wtf',
  'vidcloud.co',       '*.vidcloud.co',
  'www.youtube.com',
];

// ── CDN allowlists ────────────────────────────────────────────────
const CDN_SCRIPTS = [
  "'self'",
  'cdn.tailwindcss.com',
  'cdn.jsdelivr.net',
  'cdnjs.cloudflare.com',
  'unpkg.com',
];

const CDN_STYLES = [
  "'self'",
  "'unsafe-inline'",          // Tailwind utility classes need this
  'fonts.googleapis.com',
  'cdn.jsdelivr.net',
  'cdnjs.cloudflare.com',
];

const IMG_SRC = [
  "'self'",
  'image.tmdb.org',
  'media.themoviedb.org',
  'api.dicebear.com',
  'secure.gravatar.com',
  'via.placeholder.com',
  'data:',
  'blob:',
];

const CONNECT_SRC = [
  "'self'",
  'api.themoviedb.org',
  'https://api.themoviedb.org',
  'wss://echo.websocket.events',  // Watch Party WebSocket
];

// ── Helmet ────────────────────────────────────────────────────────
const helmetMw = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc        : ["'self'"],
      scriptSrc         : [...CDN_SCRIPTS, "'unsafe-eval'"],
      styleSrc          : CDN_STYLES,
      fontSrc           : ["'self'", 'fonts.gstatic.com', 'cdnjs.cloudflare.com', 'data:'],
      imgSrc            : IMG_SRC,
      mediaSrc          : ["'self'", 'blob:', ...EMBED_ORIGINS],
      connectSrc        : CONNECT_SRC,
      frameSrc          : ["'self'", ...EMBED_ORIGINS],
      frameAncestors    : ["'none'"],       // block clickjacking
      workerSrc         : ["'self'", 'blob:'],
      childSrc          : ["'self'", 'blob:', ...EMBED_ORIGINS],
      objectSrc         : ["'none'"],
      manifestSrc       : ["'self'"],
      baseUri           : ["'self'"],
      formAction        : ["'self'"],
      upgradeInsecureRequests: [],
    },
  },
  strictTransportSecurity: {
    maxAge           : 31_536_000,
    includeSubDomains: true,
    preload          : true,
  },
  referrerPolicy       : { policy: 'strict-origin-when-cross-origin' },
  frameguard           : { action: 'deny' },
  hidePoweredBy        : true,
  noSniff              : true,
  ieNoOpen             : true,
  xssFilter            : true,
  dnsPrefetchControl   : { allow: true },
  crossOriginEmbedderPolicy: false,   // Must be false to allow embed iframes
});

// ── Additional response headers ───────────────────────────────────
function additionalHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-BingeBox-Server', `Omega/${process.env.npm_package_version || '3.0.0'}`);
  // Default cache source marker (api-proxy will override with L1/L2/FETCH)
  if (!res.getHeader('X-BingeBox-Cache')) res.setHeader('X-BingeBox-Cache', 'MISS');

  res.setHeader('Permissions-Policy', [
    'camera=()', 'microphone=(self)', 'geolocation=()', 'payment=()',
    'usb=()', 'bluetooth=()', 'fullscreen=(self)',
    'picture-in-picture=(self)', 'autoplay=(self)', 'encrypted-media=(self)',
  ].join(', '));

  res.setHeader('Cross-Origin-Opener-Policy',   'same-origin-allow-popups');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');

  res.removeHeader('X-Powered-By');
  res.removeHeader('Server');
  next();
}

// ── Bot detection ─────────────────────────────────────────────────
const BOT_RX = [
  /scrapy/i, /python-requests/i, /go-http-client/i,
  /java\//i, /zgrab/i, /masscan/i, /nmap/i,
];

function botDetection(req, res, next) {
  const ua = (req.headers['user-agent'] || '').trim();
  if (!ua) {
    res.setHeader('X-BingeBox-Client-Type', 'headless');
    return next();
  }
  if (BOT_RX.some(rx => rx.test(ua))) {
    log.warn('Bot blocked', { ip: req.ip, ua: ua.slice(0, 100) });
    return res.status(403).json({ error: 'forbidden', message: 'Automated clients are not permitted.' });
  }
  next();
}

// ── Sliding-window rate limiter ───────────────────────────────────
const RATE = {
  windowMs : 60_000,
  maxHits  : 200,         // per IP per window
  blockMs  : 5 * 60_000,  // block duration when exceeded
  skip     : new Set(['/health', '/health/ready', '/favicon.ico', '/robots.txt']),
};

const _store = new Map();

// Prune stale IP entries every 10 min
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of _store) {
    if (!e.hits.length || now - e.hits[e.hits.length - 1] > RATE.blockMs * 2) {
      _store.delete(ip);
    }
  }
}, 10 * 60_000);

function rateLimiter(req, res, next) {
  if (RATE.skip.has(req.path)) return next();

  const ip  = req.ip || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  let e     = _store.get(ip);

  if (!e) { e = { hits: [], blocked: false, blockedUntil: 0 }; _store.set(ip, e); }

  // Currently blocked?
  if (e.blocked) {
    if (now < e.blockedUntil) {
      const retryAfter = Math.ceil((e.blockedUntil - now) / 1000);
      res.setHeader('Retry-After', retryAfter);
      return res.status(429).json({
        error     : 'rate_limited',
        message   : 'Too many requests — please slow down.',
        retryAfter,
      });
    }
    e.blocked = false; e.blockedUntil = 0; e.hits = [];
  }

  // Slide window
  e.hits = e.hits.filter(t => now - t < RATE.windowMs);
  e.hits.push(now);

  const remaining = Math.max(0, RATE.maxHits - e.hits.length);
  res.setHeader('X-RateLimit-Limit',     RATE.maxHits);
  res.setHeader('X-RateLimit-Remaining', remaining);
  res.setHeader('X-RateLimit-Reset',     Math.ceil((now + RATE.windowMs) / 1000));

  if (e.hits.length > RATE.maxHits) {
    e.blocked      = true;
    e.blockedUntil = now + RATE.blockMs;
    log.warn('Rate limit exceeded', { ip, hits: e.hits.length });
    return res.status(429).json({
      error     : 'rate_limited',
      message   : 'Rate limit exceeded.',
      retryAfter: RATE.blockMs / 1000,
    });
  }

  next();
}

// ── Compose middleware stack ──────────────────────────────────────
const securityStack = [
  helmetMw,
  additionalHeaders,
  botDetection,
  rateLimiter,
];

module.exports                    = securityStack;
module.exports.helmetMw           = helmetMw;
module.exports.additionalHeaders  = additionalHeaders;
module.exports.botDetection       = botDetection;
module.exports.rateLimiter        = rateLimiter;
module.exports.getRateLimitStore  = () => Object.fromEntries(_store);
module.exports.cspConfig          = EMBED_ORIGINS; // for inspection
