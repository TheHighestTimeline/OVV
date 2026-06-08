'use strict';
/**
 * supabase_client.js — OPTIONAL analytics sink for the Mode 4a live bot.
 *
 * If SUPABASE_URL and SUPABASE_KEY are not set, every export is a no-op
 * that resolves to null, so the bot runs fine for users who haven't set
 * up Supabase. All writes are best-effort and fire-and-forget at the
 * call sites (wrapped in .catch), so a Supabase outage never blocks or
 * crashes live trading.
 *
 *   SUPABASE_URL = https://<project>.supabase.co
 *   SUPABASE_KEY = service-role (write) key, set as a GitHub Action secret
 *
 * ── Schema (create these two tables in Supabase) ─────────────────────
 * Designed to capture EVERYTHING a future Mode 4a backtest needs, with
 * the minimum number of rows (one per scan + one per trade).
 *
 * scans  — one row every scan (~30s). Market + indicator context even
 *          when we DON'T trade, so a backtest can ask "should we have?".
 *   ts timestamptz, btc int, r1 int, r5 int, r1h int,      (RSI ×10)
 *   tf text,            -- 7-char dir string e.g. "UUDDU-D" (1m→4h)
 *   conf_score int, conf_dir text,
 *   bank numeric, open_n int, n_mkts int
 *
 * positions — one row per trade. INSERTed on entry, PATCHed on resolve.
 *   id bigint pk, ticker text, mode int, side text,
 *   px numeric, cost numeric, count int, payout numeric, btc int,
 *   conf_score int, conf_dir text, tf text,
 *   dir30m text, dir1h text, r1 int, r5 int, r1h int, slope numeric,
 *   tier numeric, recovery bool, bet_multi int,
 *   mins_left numeric, close_ts timestamptz, entered_ts timestamptz, live bool,
 *   -- resolution (patched in):
 *   won bool, pnl numeric, actual_cost numeric, revenue numeric,
 *   source text, exit_reason text, resolved_ts timestamptz, price_ticks jsonb
 */

const https = require('https');

const SB_URL  = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY  = process.env.SUPABASE_KEY || '';
const ENABLED = !!(SB_URL && SB_KEY);

if (!ENABLED) {
  console.log('[supabase] disabled (SUPABASE_URL / SUPABASE_KEY not set) — analytics writes will be skipped');
}

const API = ENABLED ? SB_URL + '/rest/v1' : null;
const TFS = ['1m', '3m', '5m', '15m', '30m', '1h', '4h'];

// mode4a → 41, mode4b → 42, anything else → null (NOT recursive).
function modeInt(modeKey) {
  if (modeKey === 'mode4a') return 41;
  if (modeKey === 'mode4b') return 42;
  return null;
}

// RSI stored ×10 as an int to keep rows compact. null-safe.
const r10 = v => (v != null && Number.isFinite(+v)) ? Math.round(+v * 10) : null;
// Turn a {tf: 'UP'|'DOWN'|null} breakdown into a 7-char string "UUDDU-D".
function tfString(breakdown) {
  if (!breakdown) return null;
  return TFS.map(tf => { const d = breakdown[tf]; return d ? d[0] : '-'; }).join('');
}

function sbReq(method, tablePath, body, extraHeaders) {
  return new Promise(function (resolve, reject) {
    if (!ENABLED) return resolve(null);
    const bodyStr = body != null ? JSON.stringify(body) : null;
    const url     = new URL(API + tablePath);
    const headers = Object.assign({
      'apikey':        SB_KEY,
      'Authorization': 'Bearer ' + SB_KEY,
      'Content-Type':  'application/json',
    }, extraHeaders || {});
    if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);

    const req = https.request({
      hostname: url.hostname,
      path:     url.pathname + (url.search || ''),
      method:   method,
      headers:  headers,
    }, function (res) {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', function () {
        if (res.statusCode >= 400) {
          return reject(new Error('sb ' + method + ' ' + tablePath + ' → ' + res.statusCode + ': ' + raw.slice(0, 200)));
        }
        try { resolve(raw ? JSON.parse(raw) : null); } catch (_) { resolve(null); }
      });
    });
    req.on('error', reject);
    req.setTimeout(12000, function () { req.destroy(); reject(new Error('sb timeout')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function sbPost(table, data, returning) {
  if (!ENABLED) return Promise.resolve(null);
  const rows = Array.isArray(data) ? data : [data];
  return sbReq('POST', '/' + table, rows, returning ? { Prefer: 'return=representation' } : {});
}

function sbPatch(table, id, data) {
  if (!ENABLED) return Promise.resolve(null);
  return sbReq('PATCH', '/' + table + '?id=eq.' + id, data, {});
}

// ────────────────────────────────────────────────────────────────────
// Exported writers. Each is a no-op (resolves null) when disabled, so
// callers can fire-and-forget without branching on ENABLED.
// ────────────────────────────────────────────────────────────────────

/**
 * One compact row per scan. `snap` is the same object the bot already
 * builds for its local confluenceLog: { ts, btc, tf, r1, r5, r1h }.
 * `extra` carries scan-wide context: { confScore, confDir, bank, openN, nMkts }.
 */
async function insertScan(snap, extra) {
  if (!ENABLED || !snap) return null;
  extra = extra || {};
  return sbPost('scans', {
    ts:         snap.ts,
    btc:        snap.btc != null ? Math.round(snap.btc) : null,
    r1:         r10(snap.r1),
    r5:         r10(snap.r5),
    r1h:        r10(snap.r1h),
    tf:         snap.tf || null,
    conf_score: extra.confScore != null ? extra.confScore : null,
    conf_dir:   extra.confDir   != null ? extra.confDir   : null,
    bank:       extra.bank      != null ? extra.bank      : null,
    open_n:     extra.openN     != null ? extra.openN     : null,
    n_mkts:     extra.nMkts     != null ? extra.nMkts     : null,
  }, false).catch(() => null);
}

/**
 * One row per trade at entry. Returns the new row id (for the later
 * resolvePosition PATCH) or null. Reads the full Mode 4a signal that
 * the bot already attaches to the entry object.
 */
async function insertPosition(entry, modeKey, rsi1m, rsi5m) {
  if (!ENABLED) return null;
  const count = Math.max(1, Math.floor(entry.cost / entry.contractPx));
  const rows = await sbPost('positions', {
    ticker:     entry.ticker,
    mode:       modeInt(modeKey),
    side:       entry.side,
    px:         entry.contractPx,
    cost:       entry.cost,
    count:      count,
    payout:     entry.payout != null ? entry.payout : null,
    btc:        entry.btcPrice != null ? Math.round(entry.btcPrice) : null,
    conf_score: entry.confluenceScore != null ? entry.confluenceScore : null,
    conf_dir:   entry.confluenceDir   || null,
    tf:         tfString(entry.tfBreakdown),
    dir30m:     entry.dir30m || null,
    dir1h:      entry.dir1h  || null,
    r1:         r10(rsi1m),
    r5:         r10(rsi5m),
    r1h:        r10(entry.rsi1h),
    slope:      entry.slope != null ? entry.slope : null,
    tier:       entry.tier  != null ? entry.tier  : null,
    recovery:   !!entry.recovery,
    bet_multi:  entry.betMulti != null ? entry.betMulti : null,
    mins_left:  entry.minutesLeft != null ? entry.minutesLeft : null,
    close_ts:   entry.close_time || null,
    entered_ts: new Date().toISOString(),
    live:       !!entry.live,
  }, true);
  const pos = Array.isArray(rows) ? rows[0] : rows;
  return (pos && pos.id) ? pos.id : null;
}

/**
 * PATCH a position row with its outcome. `res` carries everything the
 * bot learns at resolution: { won, pnl, actualCost, revenue, source,
 * exitReason, priceTicks }.
 */
async function resolvePosition(sbId, res) {
  if (!ENABLED || !sbId) return null;
  res = res || {};
  return sbPatch('positions', sbId, {
    won:         res.won != null ? res.won : null,
    pnl:         res.pnl != null ? res.pnl : null,
    actual_cost: res.actualCost != null ? res.actualCost : null,
    revenue:     res.revenue    != null ? res.revenue    : null,
    source:      res.source     || null,
    exit_reason: res.exitReason || null,
    resolved_ts: new Date().toISOString(),
    price_ticks: res.priceTicks || null,
  }).catch(() => null);
}

module.exports = { ENABLED, insertScan, insertPosition, resolvePosition };
