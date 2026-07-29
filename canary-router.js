#!/usr/bin/env node
/**
 * canary-router.js
 *
 * Minimal canary traffic router — pure Node.js, zero dependencies.
 * Routes CANARY_PERCENT% of traffic to v2 (canary), the rest to v1 (stable).
 * Tracks per-version metrics and warns when the canary is degraded.
 *
 * Usage:
 *   CANARY_PERCENT=10 node canary-router.js   # default: 10% to v2
 *   CANARY_PERCENT=25 node canary-router.js
 *
 * Quick test — run each line in a separate terminal:
 *
 *   # Terminal 1 — start the router
 *   node canary-router.js
 *
 *   # Terminal 2 — start v1 (stable) mock server on port 3001
 *   node -e "
 *     const http = require('http');
 *     http.createServer((req, res) => {
 *       setTimeout(() => res.end(JSON.stringify({ version: 'v1', url: req.url })), 20);
 *     }).listen(3001, () => console.log('v1 on :3001'));
 *   "
 *
 *   # Terminal 3 — start v2 (canary) mock server on port 3002
 *   node -e "
 *     const http = require('http');
 *     http.createServer((req, res) => {
 *       const fail = Math.random() < 0.15; // 15% error rate to trigger health warning
 *       setTimeout(() => {
 *         res.writeHead(fail ? 500 : 200);
 *         res.end(JSON.stringify({ version: 'v2', url: req.url, ok: !fail }));
 *       }, 60);
 *     }).listen(3002, () => console.log('v2 on :3002'));
 *   "
 *
 *   # Terminal 4 — fire 50 requests and watch the distribution
 *   for i in $(seq 1 50); do curl -s http://localhost:8080/ > /dev/null; done
 *   curl -s http://localhost:8080/_router/stats | node -e "
 *     process.stdin.setEncoding('utf8');
 *     let d=''; process.stdin.on('data',c=>d+=c);
 *     process.stdin.on('end',()=>console.log(JSON.parse(d)));
 *   "
 */

'use strict';

const http = require('http');

const ROUTER_PORT = parseInt(process.env.ROUTER_PORT   || '8080');
const V1_HOST     = process.env.V1_HOST                || '127.0.0.1';
const V1_PORT     = parseInt(process.env.V1_PORT       || '3001');
const V2_HOST     = process.env.V2_HOST                || '127.0.0.1';
const V2_PORT     = parseInt(process.env.V2_PORT       || '3002');
const CANARY_PCT  = Math.max(0, Math.min(100, parseInt(process.env.CANARY_PERCENT || '10')));

// Error-rate delta (v2 vs v1) that triggers a degradation warning
const DEGRADE_THRESHOLD_PCT = parseFloat(process.env.DEGRADE_THRESHOLD || '5');

// ── Metrics store ─────────────────────────────────────────────────────────────
const metrics = {
  v1: { requests: 0, errors: 0, latencyMs: 0 },
  v2: { requests: 0, errors: 0, latencyMs: 0 },
};

function record(version, latencyMs, statusCode) {
  metrics[version].requests++;
  metrics[version].latencyMs += latencyMs;
  if (statusCode >= 500) metrics[version].errors++;
}

function errorRate(v)   { const m = metrics[v]; return m.requests ? (m.errors / m.requests) * 100 : 0; }
function avgLatency(v)  { const m = metrics[v]; return m.requests ? m.latencyMs / m.requests : 0; }
function share(v) {
  const total = metrics.v1.requests + metrics.v2.requests;
  return total ? ((metrics[v].requests / total) * 100).toFixed(1) + '%' : '0%';
}

// ── Traffic decision ──────────────────────────────────────────────────────────
// Round-robin bucketing: more deterministic than Math.random() for low request counts.
let reqCounter = 0;

function pickVersion() {
  return (reqCounter++ % 100) < CANARY_PCT ? 'v2' : 'v1';
}

// ── Proxy ─────────────────────────────────────────────────────────────────────
function proxyRequest(clientReq, clientRes, version) {
  const host = version === 'v2' ? V2_HOST : V1_HOST;
  const port = version === 'v2' ? V2_PORT : V1_PORT;
  const start = Date.now();

  const upstreamOptions = {
    hostname: host,
    port,
    path:     clientReq.url,
    method:   clientReq.method,
    headers:  {
      ...clientReq.headers,
      host:              `${host}:${port}`,
      'x-routed-to':     version,     // visible downstream for debugging
      'x-canary-pct':    String(CANARY_PCT),
    },
  };

  const upstreamReq = http.request(upstreamOptions, (upstreamRes) => {
    const latency = Date.now() - start;
    record(version, latency, upstreamRes.statusCode);

    const degraded = errorRate('v2') - errorRate('v1') > DEGRADE_THRESHOLD_PCT
                     && metrics.v2.requests >= 10; // wait for enough samples

    if (degraded) {
      console.warn(
        `[router] ⚠️  CANARY DEGRADED — v2 error rate: ${errorRate('v2').toFixed(1)}% ` +
        `vs v1: ${errorRate('v1').toFixed(1)}%. Consider rolling back.`
      );
    }

    const label = upstreamRes.statusCode < 400 ? '✓' : '✗';
    console.log(
      `[${version}] ${label} ${clientReq.method} ${clientReq.url} ` +
      `→ ${upstreamRes.statusCode} (${latency}ms)`
    );

    clientRes.writeHead(upstreamRes.statusCode, {
      ...upstreamRes.headers,
      'x-served-by': version,
    });
    upstreamRes.pipe(clientRes);
  });

  upstreamReq.on('error', (err) => {
    const latency = Date.now() - start;
    record(version, latency, 502);
    console.error(`[${version}] upstream error: ${err.message}`);
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { 'Content-Type': 'application/json' });
      clientRes.end(JSON.stringify({ error: 'Bad Gateway', upstream: version, detail: err.message }));
    }
  });

  clientReq.pipe(upstreamReq);
}

// ── Stats endpoint ────────────────────────────────────────────────────────────
function serveStats(res) {
  const total = metrics.v1.requests + metrics.v2.requests;
  const v2ErrRate = errorRate('v2');
  const v1ErrRate = errorRate('v1');
  const canaryHealth = (v2ErrRate - v1ErrRate > DEGRADE_THRESHOLD_PCT && metrics.v2.requests >= 10)
    ? `DEGRADED — v2 error rate ${v2ErrRate.toFixed(1)}% exceeds v1 ${v1ErrRate.toFixed(1)}% by >${DEGRADE_THRESHOLD_PCT}%`
    : 'OK';

  const stats = {
    config: { canaryPercent: CANARY_PCT, degradeThresholdPct: DEGRADE_THRESHOLD_PCT },
    total: { requests: total },
    v1: {
      requests:   metrics.v1.requests,
      share:      share('v1'),
      errorRate:  v1ErrRate.toFixed(1) + '%',
      avgLatency: avgLatency('v1').toFixed(0) + 'ms',
    },
    v2: {
      requests:   metrics.v2.requests,
      share:      share('v2'),
      errorRate:  v2ErrRate.toFixed(1) + '%',
      avgLatency: avgLatency('v2').toFixed(0) + 'ms',
    },
    canaryHealth,
    recommendation: canaryHealth === 'OK'
      ? total > 100 ? 'Canary is healthy — consider increasing rollout %' : 'Not enough traffic yet to decide'
      : 'Roll back v2 or investigate errors before increasing rollout',
  };

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(stats, null, 2));
}

// ── Router ────────────────────────────────────────────────────────────────────
const router = http.createServer((req, res) => {
  if (req.url === '/_router/stats') return serveStats(res);

  if (req.url === '/_router/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime().toFixed(1) + 's' }));
    return;
  }

  proxyRequest(req, res, pickVersion());
});

router.listen(ROUTER_PORT, () => {
  console.log(`\n┌─ Canary Router ──────────────────────────────────────┐`);
  console.log(`│  Listening on          :${ROUTER_PORT}                          │`);
  console.log(`│  v1 (stable)    →  :${V1_PORT}  ${String(100 - CANARY_PCT).padStart(3)}% of traffic       │`);
  console.log(`│  v2 (canary)    →  :${V2_PORT}  ${String(CANARY_PCT).padStart(3)}% of traffic       │`);
  console.log(`│  Stats          →  http://localhost:${ROUTER_PORT}/_router/stats │`);
  console.log(`└──────────────────────────────────────────────────────┘\n`);
});

process.on('SIGINT',  () => { console.log('\n[router] Stopped.'); process.exit(0); });
process.on('SIGTERM', () => { console.log('\n[router] Stopped.'); process.exit(0); });
