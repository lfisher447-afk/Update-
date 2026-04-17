'use strict';
// ═══════════════════════════════════════════════════════════════════
//  BingeBox Omega — server.js  v3.0
//  Main Railway entry point.
//
//  Middleware order:
//    Security stack → CORS → Compression → Request logging
//    → Static files (public/)
//    → /health/*       (health-monitor)
//    → /api/v1/tmdb/*  (api-proxy → TMDB)
//    → /api/v1/cache/* (cache-manager admin)
//    → /api/v1/logs    (logger ring-buffer)
//    → 404 / Error handlers
// ═══════════════════════════════════════════════════════════════════

const path         = require('path');
const express      = require('express');
const compression  = require('compression');

// ── Internal modules ─────────────────────────────────────────────
const createLogger  = require('./logger');
const safeCors      = require('./cors-config');
const securityStack = require('./security-config');
const apiProxy      = require('./api-proxy');
const cacheManager  = require('./cache-manager');
const healthMonitor = require('./health-monitor');
const { requestLogger, logsHandler } = require('./logger');

const log = createLogger('Server');
const app = express();

// ── Runtime config ────────────────────────────────────────────────
const PORT       = parseInt(process.env.PORT || '3000', 10);
const IS_PROD    = (process.env.NODE_ENV || 'production') === 'production';
const PUBLIC_DIR = path.join(__dirname, 'public');

// ═══════════════════════════════════════════════════════════════════
//  Trust proxy (Railway sits behind a reverse proxy)
// ═══════════════════════════════════════════════════════════════════
app.set('trust proxy', 1);

// ═══════════════════════════════════════════════════════════════════
//  Global middleware stack
// ═══════════════════════════════════════════════════════════════════

// 1. Security headers + rate limiting
app.use(securityStack);

// 2. CORS
app.use(safeCors);

// 3. Gzip compression (skip small responses)
app.use(compression({
  threshold: 1024,
  filter   : (req, res) => {
    if (req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  },
}));

// 4. Request logging (skips /health, /favicon, /robots)
app.use(requestLogger());

// ═══════════════════════════════════════════════════════════════════
//  Static files  →  serves index.html + bingebox_omega_v3.js etc.
// ═══════════════════════════════════════════════════════════════════
app.use(express.static(PUBLIC_DIR, {
  maxAge    : IS_PROD ? '1d' : 0,
  etag      : true,
  lastModified: true,
  index     : 'index.html',
  // Prevent directory listing
  redirect  : false,
}));

// ═══════════════════════════════════════════════════════════════════
//  API routes
// ═══════════════════════════════════════════════════════════════════

// Health checks
//  GET /health              → quick liveness
//  GET /health/ready        → Railway readiness probe
//  GET /health/detailed     → full system report
//  GET /health/metrics      → Prometheus text output
app.use('/health', healthMonitor);

// TMDB proxy + cache admin
//  GET  /api/v1/tmdb/*
//  POST /api/v1/tmdb/batch
//  GET  /api/v1/tmdb/cache-info
//  DEL  /api/v1/tmdb/cache
app.use('/api/v1', apiProxy);

// Cache admin
//  GET    /api/v1/cache/stats
//  DELETE /api/v1/cache/all
//  DELETE /api/v1/cache/tag/:tag
//  DELETE /api/v1/cache/key/:key
//  GET    /api/v1/cache/keys
app.use('/api/v1/cache', cacheManager.router);

// Log ring-buffer  (localhost only in prod)
app.get('/api/v1/logs', logsHandler);

// CORS stats (useful for debugging Railway deploy)
app.get('/api/v1/cors-stats', (req, res) => {
  const { getCorsStats } = require('./cors-config');
  res.json(getCorsStats());
});

// ═══════════════════════════════════════════════════════════════════
//  SPA fallback — return index.html for any unmatched GET
//  (deep-link support: e.g. user navigates to /#movie/12345)
// ═══════════════════════════════════════════════════════════════════
app.get('*', (req, res, next) => {
  // Only serve index.html for browser navigation requests
  if (req.path.startsWith('/api/') || req.path.startsWith('/health')) return next();
  const indexFile = path.join(PUBLIC_DIR, 'index.html');
  res.sendFile(indexFile, err => {
    if (err) next(err);
  });
});

// ═══════════════════════════════════════════════════════════════════
//  404 handler
// ═══════════════════════════════════════════════════════════════════
app.use((req, res) => {
  res.status(404).json({
    error  : 'not_found',
    message: `${req.method} ${req.path} does not exist`,
    ts     : new Date().toISOString(),
  });
});

// ═══════════════════════════════════════════════════════════════════
//  Global error handler
// ═══════════════════════════════════════════════════════════════════
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status  = err.status || err.statusCode || 500;
  const message = IS_PROD && status === 500 ? 'Internal server error' : err.message;

  log.error(`Unhandled error: ${req.method} ${req.path}`, {
    status,
    message: err.message,
    stack  : err.stack?.split('\n').slice(0, 3).join(' ← '),
  });

  if (!res.headersSent) {
    res.status(status).json({
      error  : 'server_error',
      message,
      ts     : new Date().toISOString(),
    });
  }
});

// ═══════════════════════════════════════════════════════════════════
//  Startup
// ═══════════════════════════════════════════════════════════════════
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

// ── Graceful shutdown ────────────────────────────────────────────
function shutdown(signal) {
  log.info(`${signal} received — shutting down gracefully`);
  server.close(() => {
    log.info('HTTP server closed');
    process.exit(0);
  });
  // Force exit if drain takes too long
  setTimeout(() => { log.warn('Forced exit after timeout'); process.exit(1); }, 10_000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

module.exports = app; // For testing
