'use strict';
// ═══════════════════════════════════════════════════════════════════
//  BingeBox Omega — health-monitor.js  v3.0
//  Routes mounted at /health by server.js.
//
//    GET /health              — quick liveness { status, version, uptime }
//    GET /health/detailed     — full system report (CPU, mem, heap, checks)
//    GET /health/ready        — readiness for Railway health-check probe
//    GET /health/metrics      — Prometheus-format text output
// ═══════════════════════════════════════════════════════════════════

const os           = require('os');
const https        = require('https');
const fs           = require('fs');
const path         = require('path');
const express      = require('express');
const createLogger = require('./logger');
const cache        = require('./cache-manager');

const router = express.Router();
const log    = createLogger('Health');

// ── Constants ────────────────────────────────────────────────────
const BOOT_TIME  = Date.now();
const TMDB_PROBE = 'https://api.themoviedb.org/3/configuration';
const TMDB_KEY   = process.env.TMDB_API_KEY || '15d2ea6d0dc1d476efbca3eba2b9bbfb';
const PUBLIC_DIR = path.join(__dirname, 'public');

let VERSION = '3.0.0';
try { VERSION = require('./package.json').version; } catch (_) {}

const THRESH = {
  CPU_WARN     : 70,
  CPU_CRIT     : 90,
  MEM_WARN     : 75,
  MEM_CRIT     : 90,
  HEAP_WARN_MB : 400,
  HEAP_CRIT_MB : 700,
  EL_WARN_MS   : 50,
  EL_CRIT_MS   : 200,
  PROBE_TIMEOUT: 5_000,
};

// ── Live state ───────────────────────────────────────────────────
const state = {
  cpu      : { current: 0, avg5s: 0, samples: [] },
  memory   : {},
  heap     : { usedMB: 0, totalMB: 0, externalMB: 0, rssMB: 0 },
  eventLoop: { lagMs: 0, samples: [] },
  checks   : new Map(),
  incidents: [],
  sla      : { downtimeMs: 0, lastDown: null },
};

let _overallStatus  = 'ok';
let _lastCpuSamples = os.cpus() || [];

// ── Samplers ─────────────────────────────────────────────────────
function sampleCPU() {
  const cpus = os.cpus() || [];
  if (!cpus.length) return;

  const deltas = cpus.map((cpu, i) => {
    const prev  = _lastCpuSamples[i] || cpu;
    const idle  = cpu.times.idle  - (prev.times?.idle  || 0);
    const total = Object.values(cpu.times).reduce((a, b) => a + b, 0)
                - Object.values(prev.times || {}).reduce((a, b) => a + b, 0);
    return total > 0 ? (1 - idle / total) * 100 : 0;
  });
  _lastCpuSamples = cpus;

  const avg = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  state.cpu.current = +avg.toFixed(1);
  state.cpu.samples.push(avg);
  if (state.cpu.samples.length > 30) state.cpu.samples.shift();
  state.cpu.avg5s = +(state.cpu.samples.reduce((a, b) => a + b, 0) / state.cpu.samples.length).toFixed(1);
}

function sampleMemory() {
  const total   = os.totalmem();
  const free    = os.freemem();
  const used    = total - free;
  const prevPct = state.memory.pct || 0;
  const pct     = (used / total) * 100;

  state.memory = {
    usedMB : +(used   / 1048576).toFixed(1),
    freeMB : +(free   / 1048576).toFixed(1),
    totalMB: +(total  / 1048576).toFixed(0),
    pct    : +pct.toFixed(1),
    trend  : pct > prevPct + 2 ? 'rising' : pct < prevPct - 2 ? 'falling' : 'stable',
  };
}

function sampleHeap() {
  const m = process.memoryUsage();
  state.heap = {
    usedMB    : +(m.heapUsed   / 1048576).toFixed(1),
    totalMB   : +(m.heapTotal  / 1048576).toFixed(1),
    externalMB: +(m.external   / 1048576).toFixed(1),
    rssMB     : +(m.rss        / 1048576).toFixed(1),
  };
}

function sampleEventLoop() {
  const start = process.hrtime.bigint();
  setImmediate(() => {
    const lag = Number(process.hrtime.bigint() - start) / 1e6;
    state.eventLoop.samples.push(lag);
    if (state.eventLoop.samples.length > 10) state.eventLoop.samples.shift();
    state.eventLoop.lagMs = +(
      state.eventLoop.samples.reduce((a, b) => a + b, 0) / state.eventLoop.samples.length
    ).toFixed(2);
  });
}

// Sample every second
setInterval(() => { sampleCPU(); sampleMemory(); sampleHeap(); sampleEventLoop(); }, 1_000);

// ── Dependency checks ─────────────────────────────────────────────
function registerCheck(name, fn, intervalMs = 30_000) {
  const entry = { status: 'unknown', lastCheck: null, latencyMs: 0, message: '', history: [] };
  state.checks.set(name, entry);

  async function run() {
    const t0 = Date.now();
    try {
      const r        = await fn();
      entry.latencyMs = Date.now() - t0;
      entry.status    = r.status || 'ok';
      entry.message   = r.message || '';
      entry.lastCheck = new Date().toISOString();
    } catch (err) {
      entry.latencyMs = Date.now() - t0;
      entry.status    = 'error';
      entry.message   = err.message;
      entry.lastCheck = new Date().toISOString();
      const incident  = { ts: entry.lastCheck, check: name, message: err.message };
      state.incidents.push(incident);
      if (state.incidents.length > 50) state.incidents.shift();
      log.warn(`Health check FAIL: ${name}`, { msg: err.message });
    }
    entry.history.push(entry.status);
    if (entry.history.length > 10) entry.history.shift();
  }

  run(); // immediate first run
  setInterval(run, intervalMs);
}

// TMDB API probe
registerCheck('tmdb-api', () => new Promise((resolve, reject) => {
  const url = `${TMDB_PROBE}?api_key=${TMDB_KEY}`;
  const req = https.get(url, { timeout: THRESH.PROBE_TIMEOUT }, res => {
    const ok = res.statusCode === 200;
    resolve({ status: ok ? 'ok' : 'degraded', message: `HTTP ${res.statusCode}` });
    res.resume();
  });
  req.on('error', reject);
  req.on('timeout', () => { req.destroy(new Error('Probe timeout')); });
}), 60_000);

// Static file presence
registerCheck('static-files', async () => {
  const idx = path.join(PUBLIC_DIR, 'index.html');
  if (!fs.existsSync(idx)) throw new Error('public/index.html missing');
  const { size } = fs.statSync(idx);
  return { status: 'ok', message: `${(size / 1024).toFixed(0)}KB` };
}, 120_000);

// Heap usage
registerCheck('process-memory', async () => {
  const { heapUsed, heapTotal } = process.memoryUsage();
  const usedMB = heapUsed / 1048576;
  if (usedMB > THRESH.HEAP_CRIT_MB) throw new Error(`Heap critical: ${usedMB.toFixed(0)}MB`);
  const pct = heapUsed / heapTotal;
  return {
    status : pct > 0.80 ? 'degraded' : 'ok',
    message: `${(pct * 100).toFixed(0)}% (${usedMB.toFixed(0)}MB)`,
  };
}, 15_000);

// Event-loop lag
registerCheck('event-loop', async () => {
  const lag = state.eventLoop.lagMs;
  if (lag > THRESH.EL_CRIT_MS) throw new Error(`Event-loop critically slow: ${lag}ms`);
  return { status: lag > THRESH.EL_WARN_MS ? 'degraded' : 'ok', message: `${lag}ms` };
}, 10_000);

// ── Overall status ────────────────────────────────────────────────
function calcStatus() {
  let status = 'ok';
  for (const [, c] of state.checks) {
    if (c.status === 'error')    { status = 'down';     break; }
    if (c.status === 'degraded') { status = 'degraded'; }
  }
  if (state.cpu.avg5s       > THRESH.CPU_CRIT)   status = 'degraded';
  if (state.memory.pct      > THRESH.MEM_CRIT)   status = 'degraded';
  if (state.heap.usedMB     > THRESH.HEAP_CRIT_MB) status = 'degraded';
  if (state.eventLoop.lagMs > THRESH.EL_CRIT_MS) status = 'degraded';

  // SLA tracking
  if (status !== 'ok' && _overallStatus === 'ok')  state.sla.lastDown = Date.now();
  if (status === 'ok'  && _overallStatus !== 'ok' && state.sla.lastDown) {
    state.sla.downtimeMs += Date.now() - state.sla.lastDown;
    state.sla.lastDown    = null;
  }
  _overallStatus = status;
  return status;
}

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h ` +
         `${Math.floor((s % 3600) / 60)}m ${s % 60}s`;
}

function buildReport() {
  const uptimeMs  = Date.now() - BOOT_TIME;
  const slaUptime = uptimeMs > 0
    ? ((1 - state.sla.downtimeMs / uptimeMs) * 100).toFixed(3)
    : '100.000';

  const checksObj = {};
  for (const [name, c] of state.checks) checksObj[name] = c;

  return {
    status  : calcStatus(),
    version : VERSION,
    uptime  : { ms: uptimeMs, human: formatUptime(uptimeMs) },
    sla     : { uptime: `${slaUptime}%`, downtimeMs: state.sla.downtimeMs },
    ts      : new Date().toISOString(),
    cpu     : {
      current: `${state.cpu.current}%`,
      avg5s  : `${state.cpu.avg5s}%`,
      warn   : state.cpu.avg5s > THRESH.CPU_WARN,
      cores  : (os.cpus() || []).length,
      load   : os.loadavg().map(l => +l.toFixed(2)),
    },
    memory   : state.memory,
    heap     : state.heap,
    eventLoop: state.eventLoop,
    node     : {
      version : process.version,
      pid     : process.pid,
      platform: os.platform(),
      arch    : os.arch(),
      hostname: os.hostname(),
    },
    cache : {
      l1: cache.L1.info(),
      l2: cache.L2.info(),
      metrics: cache.metrics.snapshot(),
    },
    checks    : checksObj,
    incidents : state.incidents.slice(-10),
    thresholds: THRESH,
  };
}

// ═══════════════════════════════════════════════════════════════════
//  Routes
// ═══════════════════════════════════════════════════════════════════

// Quick liveness — used by Railway health-check
router.get('/', (req, res) => {
  const status = calcStatus();
  res.status(status === 'down' ? 503 : 200).json({
    status,
    version: VERSION,
    uptime : formatUptime(Date.now() - BOOT_TIME),
  });
});

// Full diagnostic report
router.get('/detailed', (req, res) => res.json(buildReport()));

// Readiness — returns 503 if any check is hard-failing
router.get('/ready', (req, res) => {
  let ready = true;
  for (const [, c] of state.checks) if (c.status === 'error') { ready = false; break; }
  res.status(ready ? 200 : 503).json({ ready, ts: new Date().toISOString() });
});

// Prometheus-compatible text output
router.get('/metrics', (req, res) => {
  const r = buildReport();
  const lines = [
    `# HELP bb_uptime_seconds Total server uptime\n# TYPE bb_uptime_seconds gauge\nbb_uptime_seconds ${Math.floor(r.uptime.ms / 1000)}`,
    `# HELP bb_cpu_avg5s CPU 5s rolling average percent\n# TYPE bb_cpu_avg5s gauge\nbb_cpu_avg5s ${state.cpu.avg5s}`,
    `# HELP bb_memory_pct System memory used percent\n# TYPE bb_memory_pct gauge\nbb_memory_pct ${state.memory.pct}`,
    `# HELP bb_heap_used_mb Heap used MB\n# TYPE bb_heap_used_mb gauge\nbb_heap_used_mb ${state.heap.usedMB}`,
    `# HELP bb_eventloop_lag_ms Event loop lag ms\n# TYPE bb_eventloop_lag_ms gauge\nbb_eventloop_lag_ms ${state.eventLoop.lagMs}`,
    `# HELP bb_cache_hits Total cache hits\n# TYPE bb_cache_hits counter\nbb_cache_hits ${cache.metrics.hits}`,
    `# HELP bb_cache_misses Total cache misses\n# TYPE bb_cache_misses counter\nbb_cache_misses ${cache.metrics.misses}`,
    `# HELP bb_incidents_total Total health incidents\n# TYPE bb_incidents_total counter\nbb_incidents_total ${state.incidents.length}\n`,
  ];
  res.setHeader('Content-Type', 'text/plain; version=0.0.4');
  res.send(lines.join('\n'));
});

// ═══════════════════════════════════════════════════════════════════
//  Exports
// ═══════════════════════════════════════════════════════════════════
module.exports              = router;
module.exports.buildReport  = buildReport;
module.exports.calcStatus   = calcStatus;
module.exports.registerCheck = registerCheck;
module.exports.state        = state;
