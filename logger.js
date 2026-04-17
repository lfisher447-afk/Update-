'use strict';
// ═══════════════════════════════════════════════════════════════════
//  BingeBox Omega — logger.js  v3.0
//  Structured JSON in production, ANSI colour in dev.
//  All server modules import from here — single source of truth.
// ═══════════════════════════════════════════════════════════════════

const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ── Runtime constants ────────────────────────────────────────────
const IS_PROD   = (process.env.NODE_ENV || 'production') === 'production';
const LOG_DIR   = process.env.LOG_DIR || path.join(process.cwd(), 'logs');
const MIN_LEVEL = (process.env.LOG_LEVEL || (IS_PROD ? 'INFO' : 'DEBUG')).toUpperCase();
const RING_MAX  = 300;   // entries kept in memory for the /logs API

const LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3, FATAL: 4 };

// ── ANSI colour codes (dev only) ─────────────────────────────────
const C = IS_PROD ? {} : {
  RESET: '\x1b[0m', BOLD: '\x1b[1m', DIM: '\x1b[2m',
  DEBUG: '\x1b[36m', INFO: '\x1b[32m', WARN: '\x1b[33m',
  ERROR: '\x1b[31m', FATAL: '\x1b[35m',
};
const c = k => C[k] || '';

// ── Sensitive-key redaction ──────────────────────────────────────
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

// ── Ring buffer ──────────────────────────────────────────────────
const ring = [];
function pushRing(entry) {
  ring.push(entry);
  if (ring.length > RING_MAX) ring.shift();
}

// ── File writer with daily rotation ─────────────────────────────
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

// Prune log files older than 14 days — runs every 6 h
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

// ── Core write ───────────────────────────────────────────────────
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

// ═══════════════════════════════════════════════════════════════════
//  Logger factory — each module gets its own context
// ═══════════════════════════════════════════════════════════════════
function createLogger(context = 'APP') {
  const logger = {
    debug : (msg, meta) => write('DEBUG', context, msg, meta),
    info  : (msg, meta) => write('INFO',  context, msg, meta),
    warn  : (msg, meta) => write('WARN',  context, msg, meta),
    error : (msg, meta) => write('ERROR', context, msg, meta),
    fatal : (msg, meta) => write('FATAL', context, msg, meta),

    /** Returns a done() that logs elapsed milliseconds */
    time(label) {
      const t0 = process.hrtime.bigint();
      return (extra = {}) => {
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        write('DEBUG', context, `${label} — ${ms.toFixed(2)}ms`, extra);
        return ms;
      };
    },

    /** Create a child logger with a nested context label */
    child(sub) { return createLogger(`${context}:${sub}`); },
  };
  return logger;
}

// ── Root app logger ──────────────────────────────────────────────
const root = createLogger('BingeBox');

// ═══════════════════════════════════════════════════════════════════
//  Express request-logging middleware
// ═══════════════════════════════════════════════════════════════════
function requestLogger(options = {}) {
  const skip   = options.skip || (req => /^\/(health|favicon\.ico|robots\.txt)/.test(req.path));
  const httpLog = createLogger('HTTP');

  return function logRequest(req, res, next) {
    if (skip(req)) return next();

    const t0 = process.hrtime.bigint();
    const id = req.headers['x-request-id'] || '-';

    httpLog.debug(`→ ${req.method} ${req.path}`, {
      id,
      ip : req.ip,
      ua : (req.headers['user-agent'] || '').slice(0, 80),
      q  : Object.keys(req.query).length ? redact(req.query) : undefined,
    });

    res.on('finish', () => {
      const ms    = Number(process.hrtime.bigint() - t0) / 1e6;
      const level = res.statusCode >= 500 ? 'ERROR'
                  : res.statusCode >= 400 ? 'WARN'
                  : 'INFO';
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

// ═══════════════════════════════════════════════════════════════════
//  /api/v1/logs endpoint — localhost only in production
// ═══════════════════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════════════════
//  Global process error capture
// ═══════════════════════════════════════════════════════════════════
process.on('unhandledRejection', reason => {
  root.error('Unhandled Promise Rejection', { reason: String(reason) });
});
process.on('uncaughtException', err => {
  root.fatal('Uncaught Exception', {
    message: err.message,
    stack  : err.stack?.split('\n').slice(0, 4).join(' ← '),
  });
  // Give logger time to flush before process exit
  setTimeout(() => process.exit(1), 500);
});

// ═══════════════════════════════════════════════════════════════════
//  Exports
// ═══════════════════════════════════════════════════════════════════
module.exports               = createLogger;
module.exports.root          = root;
module.exports.createLogger  = createLogger;
module.exports.requestLogger = requestLogger;
module.exports.logsHandler   = logsHandler;
module.exports.getBuffer     = () => [...ring];
