#!/usr/bin/env node
/**
 * graceful-shutdown.js
 *
 * Demonstrates zero-downtime deployment fundamentals:
 *   - Separate /health/live  (liveness probe  — Kubernetes restarts on failure)
 *   - Separate /health/ready (readiness probe — Kubernetes removes from LB on failure)
 *   - SIGTERM handler that drains in-flight requests before exiting
 *   - Active connection tracking
 *
 * Run:
 *   node graceful-shutdown.js
 *
 * Test graceful drain (run in separate terminals):
 *   curl http://localhost:3000/api/slow          # start a slow request (5 s)
 *   kill -TERM $(lsof -ti:3000)                  # send SIGTERM while it runs
 *   # → process waits for the slow request to finish, then exits cleanly
 *
 * Test readiness on startup:
 *   curl -i http://localhost:3000/health/ready   # returns 503 for first 2 s
 */

'use strict';

const http = require('http');

const PORT            = parseInt(process.env.PORT || '3000');
const STARTUP_DELAY   = parseInt(process.env.STARTUP_DELAY_MS || '2000');   // warm-up time
const DRAIN_TIMEOUT   = parseInt(process.env.DRAIN_TIMEOUT_MS || '10000');  // hard exit ceiling

// ── App state ─────────────────────────────────────────────────────────────────
let isReady        = false;   // flips true after simulated warm-up
let isShuttingDown = false;   // flips true on SIGTERM
let activeRequests = 0;       // in-flight request counter

// ── Simulate startup warm-up (DB connection, cache prime, etc.) ───────────────
setTimeout(() => {
  isReady = true;
  console.log('[startup] Ready. Readiness probe will now return 200.');
}, STARTUP_DELAY);

console.log(`[startup] PID ${process.pid} — warming up for ${STARTUP_DELAY}ms ...`);

// ── Request handler ───────────────────────────────────────────────────────────
function handleRequest(req, res) {
  const url = new URL(req.url, `http://localhost`);

  // ── /health/live  ────────────────────────────────────────────────────────────
  // Returns 200 as long as the process is alive.
  // Kubernetes kills + restarts the pod only if THIS fails.
  if (url.pathname === '/health/live') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'alive', pid: process.pid }));
    return;
  }

  // ── /health/ready  ───────────────────────────────────────────────────────────
  // Returns 503 during startup or shutdown — signals the LB to stop sending traffic.
  // Kubernetes removes the pod from rotation if THIS fails (but doesn't restart it).
  if (url.pathname === '/health/ready') {
    if (!isReady || isShuttingDown) {
      const reason = isShuttingDown ? 'shutting_down' : 'starting_up';
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ready: false, reason }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ready: true, activeRequests }));
    return;
  }

  // ── Reject new requests once shutdown begins ──────────────────────────────────
  // The readiness probe should have stopped the LB from sending new requests,
  // but this is a safety net for any requests already in-flight at the LB level.
  if (isShuttingDown) {
    res.writeHead(503, { 'Connection': 'close', 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Service is shutting down. Please retry.' }));
    return;
  }

  // ── Track in-flight requests ──────────────────────────────────────────────────
  activeRequests++;
  res.on('finish', () => {
    activeRequests--;
    if (isShuttingDown && activeRequests === 0) {
      console.log('[shutdown] Last in-flight request finished. Exiting cleanly.');
      process.exit(0);
    }
  });

  // ── /api/slow — simulates a long-running request ──────────────────────────────
  // Use this to test graceful drain: start a slow request, then SIGTERM the process.
  if (url.pathname === '/api/slow') {
    const delay = Math.min(parseInt(url.searchParams.get('ms') || '5000'), 30000);
    console.log(`[request] /api/slow started (${delay}ms) — activeRequests=${activeRequests}`);
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ done: true, delayMs: delay }));
      console.log(`[request] /api/slow finished — activeRequests=${activeRequests - 1}`);
    }, delay);
    return;
  }

  // ── Default ───────────────────────────────────────────────────────────────────
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    message: 'Hello from v2',
    pid: process.pid,
    activeRequests,
    routes: ['/health/live', '/health/ready', '/api/slow?ms=5000'],
  }));
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const server = http.createServer(handleRequest);

server.listen(PORT, () => {
  console.log(`[startup] Listening on http://localhost:${PORT}`);
});

// ── Graceful shutdown on SIGTERM (sent by Kubernetes / orchestrators) ─────────
function gracefulShutdown(signal) {
  if (isShuttingDown) return; // already shutting down, ignore duplicate signal
  console.log(`\n[shutdown] ${signal} received — stopping new traffic...`);
  isShuttingDown = true;

  // Stop accepting new TCP connections.
  // Existing keep-alive connections finish their current request, then close.
  server.close(() => console.log('[shutdown] Server closed (no new connections).'));

  if (activeRequests === 0) {
    console.log('[shutdown] No active requests. Exiting immediately.');
    process.exit(0);
  }

  console.log(`[shutdown] Draining ${activeRequests} active request(s) — max wait: ${DRAIN_TIMEOUT}ms`);

  // Failsafe: hard-exit if drain takes longer than DRAIN_TIMEOUT.
  // .unref() so this timer doesn't prevent the process from exiting sooner.
  const timer = setTimeout(() => {
    console.error('[shutdown] Drain timeout exceeded. Force-exiting (exit code 1).');
    process.exit(1);
  }, DRAIN_TIMEOUT);
  timer.unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));   // Ctrl-C in dev
