'use strict';
/**
 * github_state.js — commit bot state back to the bot's own repo.
 *
 * Used by the bot when running inside GitHub Actions so the dashboard
 * can read dashboard/btc_paper_state.json via the GitHub Contents API.
 *
 * Strategy: keep a single "rolling" commit on `main` instead of one
 * commit per event, so we don't fill the user's history with thousands
 * of state-update commits. The bot:
 *   1) `git stash` any unrelated changes (none expected in CI)
 *   2) `git commit --amend` the previous state commit if its message
 *      starts with the BOT_COMMIT_PREFIX, otherwise creates a new one
 *   3) `git push --force-with-lease` only that file
 *
 * Disabled outside CI (when GITHUB_ACTIONS env var is missing) so local
 * runs don't touch your git history.
 *
 * Security: all git invocations use spawnSync with an argv array, not
 * a shell string. The `label` parameter never reaches a shell, so even
 * a future caller that passes user-controlled text cannot trigger
 * command injection.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');

const BOT_COMMIT_PREFIX = 'bot: state update';
const STATE_FILE_REL    = 'dashboard/btc_paper_state.json';
// Append-only backtest archive (full per-trade + per-scan history). Pushed
// alongside the live state file so no data is ever left only on the
// ephemeral runner. Only the changed (today's) files re-upload.
const ARCHIVE_DIR_REL   = 'dashboard/archive';
const COMMIT_PATHS      = [STATE_FILE_REL, ARCHIVE_DIR_REL];
const ENABLED = !!process.env.GITHUB_ACTIONS;

let _configured  = false;
let _coolingUntil = 0;     // brief backoff after a push failure
let _lastTickPush = 0;     // throttle routine 'tick' pushes
const TICK_PUSH_INTERVAL_MS = 90 * 1000;  // routine push at most every 90s

// Allow only short alphanumeric labels in the commit message — defence in
// depth. Today's callers pass only 'tick', 'entry', 'resolution'.
function _safeLabel(label) {
  const s = String(label || 'tick');
  return /^[a-z0-9_-]{1,32}$/i.test(s) ? s : 'tick';
}

function _git(args) {
  return spawnSync('git', args, { stdio: ['ignore', 'pipe', 'pipe'] });
}

function _ensureConfigured() {
  if (_configured) return;
  _git(['config', 'user.email', 'bot@kalshi-paper-bot.local']);
  _git(['config', 'user.name',  'kalshi-paper-bot']);
  _configured = true;
}

/**
 * Commit + push the current state file.
 * Resolves on success or graceful skip. Never throws (best-effort).
 */
async function pushState(label) {
  if (!ENABLED) return false;
  if (Date.now() < _coolingUntil) return false;

  const safeLabel = _safeLabel(label);

  // Throttle routine tick pushes so we're not force-pushing every 30s.
  // Always push immediately for meaningful events (entry, resolution, etc.).
  if (safeLabel === 'tick') {
    if (Date.now() - _lastTickPush < TICK_PUSH_INTERVAL_MS) return false;
  }
  _ensureConfigured();

  try {
    if (!fs.existsSync(STATE_FILE_REL)) return false;

    // Any staged/unstaged changes to the state file or archive?
    const status = _git(['status', '--porcelain', '--', ...COMMIT_PATHS]);
    if (status.status !== 0) throw new Error('git status failed: ' + status.stderr);
    if (!status.stdout.toString().trim()) return false;

    const msg = `${BOT_COMMIT_PREFIX} (${safeLabel}) [skip ci]`;

    // Build our state commit DIRECTLY on top of the freshly-fetched remote
    // tip, every push. This is the safety property that prevents a state
    // commit from ever orphaning a code commit that landed on main during
    // the run:
    //   1) fetch origin/main
    //   2) reset --mixed to origin/main → HEAD AND index match the exact
    //      remote tip (so any code commit that landed is kept), while our
    //      modified state/archive files stay in the working tree
    //   3) re-stage our files on top of that clean remote tree
    //   4) if the remote tip is itself a bot-state commit, --amend it
    //      (keeps the single rolling commit, parent = whatever came
    //      before, including code commits); otherwise commit fresh on top
    //   5) push --force-with-lease (safe: our parent IS the current tip)
    // A bare force-with-lease without this rebuild could, once its lease
    // was refreshed by an unrelated fetch, force-push a local HEAD/index
    // that did NOT contain a newly-landed code commit — silently wiping it.
    const attempt = () => {
      const f = _git(['fetch', 'origin', 'main']);
      if (f.status !== 0) return { ok: false, err: 'fetch: ' + f.stderr };

      let r = _git(['reset', '--mixed', 'origin/main']);
      if (r.status !== 0) return { ok: false, err: 'reset: ' + r.stderr };

      r = _git(['add', '--', ...COMMIT_PATHS]);
      if (r.status !== 0) return { ok: false, err: 'add: ' + r.stderr };

      // Nothing staged vs the remote tip (our content already there)? Skip.
      if (_git(['diff', '--cached', '--quiet']).status === 0) {
        return { ok: true, noop: true, err: '' };
      }

      const tipMsg = _git(['log', '-1', '--pretty=%s']);
      const isAmend = tipMsg.status === 0 &&
                      tipMsg.stdout.toString().trim().startsWith(BOT_COMMIT_PREFIX);

      r = isAmend ? _git(['commit', '--amend', '-m', msg])
                  : _git(['commit', '-m', msg]);
      if (r.status !== 0) return { ok: false, err: 'commit: ' + r.stderr };

      const p = _git(['push', '--force-with-lease', 'origin', 'HEAD:main']);
      return { ok: p.status === 0, err: p.status === 0 ? '' : 'push: ' + p.stderr };
    };

    let res = attempt();
    if (!res.ok) {
      // A concurrent push may have landed between our fetch and push; the
      // next attempt re-fetches the new tip and rebuilds on top of it.
      res = attempt();
      if (!res.ok) throw new Error('git state push failed after retry: ' + res.err);
      console.log('  ↻ github_state recovered from concurrent push (rebuilt on new tip)');
    }

    if (safeLabel === 'tick') _lastTickPush = Date.now();
    return true;
  } catch (e) {
    // Include 2 lines of stderr context so a future failure is debuggable.
    const msg = (e && e.message) ? String(e.message).split('\n').slice(0, 2).join(' | ') : String(e);
    console.log(`  !! github_state push failed (${msg}) — backing off 5 min`);
    _coolingUntil = Date.now() + 5 * 60 * 1000;
    return false;
  }
}

module.exports = { ENABLED, pushState };
