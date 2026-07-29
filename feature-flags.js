#!/usr/bin/env node
/**
 * feature-flags.js
 *
 * Lightweight feature flag engine — zero dependencies.
 * Demonstrates the concepts behind tools like LaunchDarkly / Unleash / Statsig.
 *
 * Features:
 *   - Deterministic percentage rollout  (same user always gets the same value)
 *   - Boolean kill switches             (globally enable/disable a flag)
 *   - User allowlists                   (internal testers always get new features)
 *   - Stale flag detection              (warns about overdue cleanup)
 *   - User-context snapshot             (bootstrap a frontend with all flag values)
 *
 * Run:
 *   node feature-flags.js
 */

'use strict';

// ── Deterministic hash ────────────────────────────────────────────────────────
// FNV-1a 32-bit: fast, no crypto, no deps.
// Combining flagName + userId means each flag has an independent assignment per user.
// Without this, if two flags both use 10% rollout, the same 10% of users would
// always get both — which skews your data.
function fnv1a32(str) {
  let hash = 2166136261; // FNV offset basis
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0; // FNV prime, keep as uint32
  }
  return hash;
}

function bucketForUser(flagName, userId) {
  // Returns a stable integer in [0, 99] for this (flag, user) pair
  return fnv1a32(`${flagName}::${userId}`) % 100;
}

// ── Flag store ────────────────────────────────────────────────────────────────
// In production this comes from a DB / Redis / config service.
// Each flag has:
//   enabled         — master kill switch (false = off for everyone, no exceptions)
//   rolloutPercent  — 0–100, percentage of users who get this flag
//   allowlist       — user IDs that always get the flag (regardless of rollout %)
//   description     — required: forces you to articulate the flag's purpose
//   addedAt         — audit trail
//   cleanupBy       — stale flag detection; overdue ones emit warnings
const FLAG_STORE = {
  new_checkout_flow: {
    enabled: true,
    rolloutPercent: 20,
    allowlist: ['user_001', 'user_002'],   // internal testers
    description: 'New 3-step checkout replacing the legacy single-page form',
    addedAt: '2024-11-01',
    cleanupBy: '2025-04-01',
  },
  dark_mode: {
    enabled: true,
    rolloutPercent: 100,   // fully shipped
    allowlist: [],
    description: 'Dark mode UI toggle — fully rolled out, pending code cleanup',
    addedAt: '2024-09-01',
    cleanupBy: '2025-01-15',   // overdue — will warn
  },
  ml_search: {
    enabled: false,            // kill switch: regression found, turned off globally
    rolloutPercent: 50,
    allowlist: [],
    description: 'ML-powered search (disabled: p99 latency regression in prod)',
    addedAt: '2025-01-10',
    cleanupBy: '2025-06-01',
  },
  new_dashboard: {
    enabled: true,
    rolloutPercent: 5,         // early canary, just 5%
    allowlist: ['user_001'],
    description: 'Redesigned analytics dashboard',
    addedAt: '2025-02-01',
    cleanupBy: '2025-07-01',
  },
};

// ── FeatureFlagService ────────────────────────────────────────────────────────
class FeatureFlagService {
  constructor(store) {
    this._store = store;
    this._accessLog = []; // lightweight audit log
    this._checkForStaleFlags();
  }

  /**
   * Returns true if `flagName` is active for `userId`.
   * Decision order:
   *   1. Unknown flag          → false (with warning)
   *   2. Kill switch off       → false
   *   3. User on allowlist     → true
   *   4. Percentage rollout    → deterministic bucket check
   */
  isEnabled(flagName, userId) {
    const flag = this._store[flagName];

    if (!flag) {
      console.warn(`[flags] ⚠️  Unknown flag "${flagName}" — returning false`);
      return false;
    }

    // 1. Kill switch
    if (!flag.enabled) {
      this._log(flagName, userId, false, 'kill_switch');
      return false;
    }

    // 2. Allowlist
    if (flag.allowlist.includes(String(userId))) {
      this._log(flagName, userId, true, 'allowlist');
      return true;
    }

    // 3. Percentage rollout
    const bucket = bucketForUser(flagName, String(userId));
    const result = bucket < flag.rolloutPercent;
    this._log(flagName, userId, result, `bucket:${bucket}`);
    return result;
  }

  /**
   * Returns all flags resolved for a given user.
   * Use this to bootstrap your frontend so it doesn't need individual flag calls.
   */
  getAll(userId) {
    return Object.fromEntries(
      Object.keys(this._store).map(name => [name, this.isEnabled(name, userId)])
    );
  }

  /** Returns a summary of flag config (useful for admin dashboards). */
  listFlags() {
    return Object.entries(this._store).map(([name, f]) => ({
      name,
      enabled: f.enabled,
      rolloutPercent: f.rolloutPercent,
      allowlistSize: f.allowlist.length,
      cleanupBy: f.cleanupBy,
      description: f.description,
    }));
  }

  /** Returns recent access log entries. */
  getAccessLog(limit = 20) {
    return this._accessLog.slice(-limit);
  }

  // ── Private ────────────────────────────────────────────────────────────────
  _log(flagName, userId, result, reason) {
    this._accessLog.push({ flagName, userId, result, reason, ts: Date.now() });
  }

  _checkForStaleFlags() {
    const today = new Date();
    for (const [name, flag] of Object.entries(this._store)) {
      if (flag.cleanupBy && new Date(flag.cleanupBy) < today) {
        const daysOverdue = Math.floor((today - new Date(flag.cleanupBy)) / 86400000);
        console.warn(
          `[flags] 🕰️  Flag "${name}" passed its cleanup date ` +
          `(${flag.cleanupBy}, ${daysOverdue}d overdue). Flag debt accumulating.`
        );
      }
    }
  }
}

// ── Demo ──────────────────────────────────────────────────────────────────────
const flags = new FeatureFlagService(FLAG_STORE);
const hr = '─'.repeat(60);

console.log(`\n${hr}`);
console.log(' Feature Flag Demo');
console.log(hr);

// Show rollout distribution across 20 users
const users = Array.from({ length: 20 }, (_, i) => `user_${String(i + 1).padStart(3, '0')}`);

console.log('\n📊  new_checkout_flow  (20% rollout, user_001 + user_002 on allowlist)');
console.log(hr);
let newFlowCount = 0;
for (const userId of users) {
  const on = flags.isEnabled('new_checkout_flow', userId);
  if (on) newFlowCount++;
  const bar = on ? '██ NEW FLOW' : '░░ legacy  ';
  console.log(`  ${userId}  →  ${bar}`);
}
console.log(`\n  → ${newFlowCount}/${users.length} users on new flow (expected ~20% + allowlist)`);

// Kill switch demo
console.log(`\n🚫  ml_search  (kill switch OFF — no one gets it)`);
console.log(hr);
const mlResults = users.slice(0, 5).map(u => `${u}: ${flags.isEnabled('ml_search', u)}`);
console.log(' ', mlResults.join('  |  '));

// All flags for a specific user
console.log(`\n🎯  All flags for user_001 (on allowlist for new_checkout_flow)`);
console.log(hr);
console.log(flags.getAll('user_001'));

// Flag inventory
console.log(`\n📋  Flag inventory`);
console.log(hr);
console.table(flags.listFlags());

// Access log
console.log(`\n📝  Last 5 access log entries`);
console.log(hr);
console.table(flags.getAccessLog(5));
