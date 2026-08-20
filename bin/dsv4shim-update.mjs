#!/usr/bin/env node
/**
 * dsv4shim-update.mjs — pull the latest shim from GitHub over the installed copy.
 *
 *   node bin/dsv4shim-update.mjs           apply if there is anything new
 *   node bin/dsv4shim-update.mjs --check   report only (exit 10 = update available)
 *   node bin/dsv4shim-update.mjs --force   reapply even when already current
 *   node bin/dsv4shim-update.mjs --no-restart
 *
 * The install directory deliberately is NOT a git working tree: it mixes shipped
 * code with runtime state (usage.jsonl, balance history, vision-cache, shim.pid),
 * and a working tree there would keep trying to reconcile files that are none of
 * git's business. Instead the repo is kept in a cache clone and only files that
 * git actually tracks are copied out of it.
 *
 * That inverts the usual risk. Rather than listing what to protect and hoping the
 * list is complete, nothing is copied unless the repo tracks it — so a state file
 * cannot be clobbered by an update that forgot about it. ~/.config/dsv4shim,
 * which holds your API keys, caps and probe results, is never written at all
 * except to add newly-introduced config keys.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

// The repository was renamed claude-dsv4f -> dsv4shim on 2026-08-18, so this now matches it.
// Installs that predate the rename keep working regardless: GitHub permanently redirects the
// old path, and each machine's existing `.update-cache` clone still has the old URL in its own
// remote until it is re-cloned. Verify against the live repo before editing this — a URL that
// 404s here breaks self-update on every machine at once, silently, until someone deploys.
const REPO_URL = 'https://github.com/OuiaOa/dsv4shim.git';
const DATA = process.env.DSV4SHIM_DATA_DIR || join(homedir(), '.local', 'share', 'dsv4shim');
const CONFIG = process.env.DSV4SHIM_CONFIG_DIR || join(homedir(), '.config', 'dsv4shim');
import { threeWayMerge } from './dsv4shim-lib.mjs';
import { configuredPort } from './dsv4shim-port-manager.mjs';
import { installPortableAssets } from './dsv4shim-reroute.mjs';

const CACHE = join(DATA, '.update-cache');
const args = process.argv.slice(2);
const CHECK_ONLY = args.includes('--check');
const FORCE = args.includes('--force');
const NO_RESTART = args.includes('--no-restart');

const log = (m) => console.log(m);
const warn = (m) => console.log(`  ! ${m}`);

function run(cmd, argv, cwd, timeout = 180000) {
  try {
    return { ok: true, out: execFileSync(cmd, argv, { cwd, encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] }).trim() };
  } catch (e) {
    return { ok: false, out: (String(e.stdout || '') + String(e.stderr || e.message)).trim() };
  }
}
const git = (argv, cwd = CACHE) => run('git', argv, cwd);

// --------------------------------------------------------------- cache clone
if (!existsSync(join(CACHE, '.git'))) {
  mkdirSync(dirname(CACHE), { recursive: true });
  rmSync(CACHE, { recursive: true, force: true });
  log('creating update cache…');
  const c = run('git', ['clone', '--quiet', REPO_URL, CACHE], DATA);
  if (!c.ok) { log(`could not clone (offline?): ${c.out.split('\n')[0]}`); process.exit(0); }
}

const fetched = git(['fetch', '--quiet', 'origin']);
if (!fetched.ok) { log(`offline or fetch failed; keeping the installed version.`); process.exit(0); }

const remote = git(['rev-parse', 'origin/main']).out;
const markerPath = join(DATA, '.installed-commit');
const installed = existsSync(markerPath) ? readFileSync(markerPath, 'utf8').trim() : null;

if (installed === remote && !FORCE) {
  log(`already current (${remote.slice(0, 7)})`);
  syncClaudeProfile();
  writeResult({ outcome: 'current', from: installed, to: remote });
  process.exit(0);
}

log(`update available: ${installed ? installed.slice(0, 7) : '(unknown)'} -> ${remote.slice(0, 7)}`);
if (installed) {
  const l = git(['log', '--oneline', `${installed}..${remote}`]);
  if (l.ok) for (const line of l.out.split('\n').filter(Boolean)) log(`    ${line}`);
}
if (CHECK_ONLY) process.exit(installed === remote ? 0 : 10);

git(['reset', '--hard', '--quiet', remote]);
installPrePushHook();   // .git/hooks/ is untracked, so `reset --hard` cannot restore it

// ------------------------------------------------------------------- apply
// Only what git tracks. A runtime file is untracked by construction, so it is not
// in this list and therefore cannot be overwritten.
const tracked = git(['ls-files']).out.split('\n').map(s => s.trim()).filter(Boolean);
if (!tracked.length) { console.error('FATAL: repo lists no tracked files — refusing to wipe the install.'); process.exit(1); }

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = join(DATA, 'backups', `update-${stamp}`);
mkdirSync(backup, { recursive: true });

const changed = [];
for (const rel of tracked) {
  const src = join(CACHE, rel);
  const dst = join(DATA, rel);
  if (!existsSync(src)) continue;
  if (existsSync(dst)) {
    if (readFileSync(src).equals(readFileSync(dst))) continue;   // identical, skip
    const b = join(backup, rel);
    mkdirSync(dirname(b), { recursive: true });
    cpSync(dst, b);
  }
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(src, dst, { force: true });
  changed.push(rel);
}
log(`updated ${changed.length} file(s)`);

function rollback(why) {
  warn(`rolling back: ${why}`);
  for (const rel of changed) {
    const b = join(backup, rel);
    if (existsSync(b)) cpSync(b, join(DATA, rel), { force: true });
  }
  warn(`restored the previous files from ${backup}`);
}

// New config keys only — your keys, caps and model choices are never rewritten.
mergeConfig();
syncClaudeProfile();

// ------------------------------------------------------------------ verify
let failed = null;
for (const f of ['shim.mjs', 'probe.mjs']) {
  const p = join(DATA, f);
  if (!existsSync(p)) continue;
  const r = run(process.execPath, ['--check', p], DATA);
  if (!r.ok) failed = `${f} failed syntax check: ${r.out.split('\n')[0]}`;
}
if (!failed && existsSync(join(DATA, 'test-shim.mjs'))) {
  const r = run(process.execPath, [join(DATA, 'test-shim.mjs')], DATA, 600000);
  const tail = r.out.split('\n').filter(Boolean).slice(-1)[0] || '';
  log(`  tests: ${r.ok ? tail : 'FAIL'}`);
  if (!r.ok) failed = `test-shim.mjs failed:\n${r.out.split('\n').slice(-12).join('\n')}`;
}

if (failed) {
  console.error(`\nVERIFICATION FAILED — ${failed}`);
  rollback('verification failed');
  writeResult({ outcome: 'rolled-back', from: installed, to: remote, error: failed, backup });
  process.exit(1);
}

writeFileSync(markerPath, remote + '\n');
if (!NO_RESTART) restartShim();

log(`\nupdated to ${remote.slice(0, 7)} — backup at ${backup}`);
writeResult({ outcome: 'success', from: installed, to: remote, backup, files: changed.length });

// ------------------------------------------------------------------ helpers

/** Add keys the new version introduced; never overwrite a value already set. */
function mergeConfig() {
  const livePath = join(CONFIG, 'config.json');
  const basePath = join(DATA, 'config.default.json');
  if (!existsSync(basePath)) return;
  if (!existsSync(livePath)) {
    mkdirSync(CONFIG, { recursive: true });
    cpSync(basePath, livePath);
    log('config.json created from the shipped default');
    return;
  }
  let live, base;
  // Strip a UTF-8 BOM before parsing — a config.json written by PowerShell's
  // `Set-Content -Encoding utf8` carries one and is unparseable to JSON.parse even
  // though it looks perfectly valid in an editor.
  const readJson = (p) => JSON.parse(readFileSync(p, 'utf8').replace(/^﻿/, ''));
  try {
    live = readJson(livePath);
    base = readJson(basePath);
  } catch (e) { warn(`config merge skipped (unparseable JSON): ${e.message}`); return; }
  // THREE-WAY MERGE. Adding only absent keys — the old behaviour — meant a CHANGED default
  // never reached an existing install: the update reported success and the stale value stayed
  // live. That shipped three separate bugs in one night (stale prices, one shared model
  // sentinel per tier, and a denyModelPatterns entry that refused every new pro profile),
  // each silent, each found only by accident.
  //
  // The old shipped default is the base: if the live value still equals it, the user never
  // touched that key and the new default is safe to apply. If it differs, it is the user's
  // and is left alone. This needs no list of "owned" keys to drift out of date.
  const oldBase = (() => {
    if (!installed) return null;
    const r = git(['show', `${installed}:config.default.json`]);
    if (!r.ok) return null;
    try { return JSON.parse(r.out.replace(/^\uFEFF/, '')); } catch { return null; }
  })();
  if (!oldBase) log('config.json: no previous default available — adding new keys only');

  const { added, updated, kept, removed } = threeWayMerge(live, base, oldBase || undefined);

  if (added.length || updated.length || removed.length) {
    writeFileSync(livePath, JSON.stringify(live, null, 2) + '\n');
    if (added.length) log(`config.json: added ${added.length} key(s): ${added.join(', ')}`);
    if (updated.length) log(`config.json: updated ${updated.length} stale default(s): ${updated.join(', ')}`);
    if (removed.length) log(`config.json: removed ${removed.length} superseded key(s): ${removed.join(', ')}`);
  }
  if (kept.length) log(`config.json: kept ${kept.length} local customisation(s): ${kept.join(', ')}`);
}

/**
 * Keep an already-installed Claude profile aligned with the shim's model picker policy.
 * Updating the runtime files alone is not enough: Claude reads these env values from the
 * profile's settings.json, so an old profile can keep showing the removed custom/default rows
 * forever. Only values recognisably written by dsv4shim are migrated; user-selected model names
 * remain untouched.
 */
function syncClaudeProfile() {
  const profile = process.env.DSV4SHIM_PROFILE_DIR || join(homedir(), '.dsv4shim');
  const settingsPath = join(profile, 'settings.json');
  const desired = {
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4-pro-high',
    ANTHROPIC_DEFAULT_FABLE_MODEL: 'deepseek-v4-pro-max',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-flash-max',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash-high',
    ANTHROPIC_SMALL_FAST_MODEL: 'deepseek-v4-flash-low',
    CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek-v4-flash-sub',
    CLAUDE_CODE_BG_CLASSIFIER_MODEL: 'deepseek-v4-flash-low',
  };
  const ownProfile = value => typeof value === 'string' && /^deepseek-v4-/i.test(value);
  let changed = false;

  if (existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf8').replace(/^﻿/, ''));
      settings.env ??= {};
      if (ownProfile(settings.env.ANTHROPIC_MODEL)) {
        delete settings.env.ANTHROPIC_MODEL;
        changed = true;
      }
      if (ownProfile(settings.env.ANTHROPIC_CUSTOM_MODEL_OPTION) ||
          /^DeepSeek V4 Flash 0731$/i.test(String(settings.env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME || ''))) {
        for (const key of ['ANTHROPIC_CUSTOM_MODEL_OPTION', 'ANTHROPIC_CUSTOM_MODEL_OPTION_NAME', 'ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION']) {
          if (key in settings.env) { delete settings.env[key]; changed = true; }
        }
      }
      for (const [key, value] of Object.entries(desired)) {
        if (!(key in settings.env) || (ownProfile(settings.env[key]) && settings.env[key] !== value)) {
          settings.env[key] = value;
          changed = true;
        }
      }
      if (changed) {
        writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
        log(`Claude profile model picker migrated: ${settingsPath}`);
      }
    } catch (e) {
      warn(`Claude profile migration skipped: ${e.message}`);
    }
  }

  try {
    const assets = installPortableAssets(profile, DATA);
    if (assets.length) log(`portable assets synced: ${assets.join(', ')}`);
  } catch (e) {
    warn(`portable asset sync skipped: ${e.message}`);
  }
}

/**
 * Replace the running shim with the just-deployed code.
 *
 * The shim's own SIGTERM handler exits 0 (server.close then process.exit(0)) — correct
 * behavior for a well-behaved service, but it means systemd sees ANY SIGTERM, whoever sent
 * it, as a clean stop. Restart=on-failure therefore never fires for a bare `kill`: this used
 * to leave the OLD process (and OLD code, permanently, until something else restarted it —
 * e.g. a reboot) still bound to the port while this function logged a false "restarts on next
 * use". Going through `systemctl --user restart` sidesteps that entirely — it performs its
 * own stop+start regardless of exit status, so it always actually replaces the process.
 *
 * The previous fallback (`lsof -ti tcp:$port | xargs kill`) also killed EVERY process with a
 * socket on that port, not just the listener — including a live `claude` client mid-session
 * (lsof -i matches ESTABLISHED connections too, not only LISTEN). Restricted to the listening
 * socket only, below, for installs without the systemd unit.
 */
function restartShim() {
  const config = (() => { try { return JSON.parse(readFileSync(join(CONFIG, 'config.json'), 'utf8')); } catch { return {}; } })();
  const port = configuredPort({ envVar: 'DSV4SHIM_PORT', dataDir: DATA, app: 'dsv4shim', configPort: config.port, defaultPort: 8788 });
  const probe = run(process.execPath, ['-e',
    `fetch('http://127.0.0.1:${port}/_dsv4shim/health').then(r=>console.log(r.status)).catch(()=>process.exit(3))`], DATA, 15000);
  if (!probe.ok) { log('shim not running — it starts on the new code next time'); return; }

  if (process.platform !== 'win32') {
    const unit = run('systemctl', ['--user', 'list-unit-files', 'dsv4shim-shim.service'], DATA);
    if (unit.ok && unit.out.includes('dsv4shim-shim.service')) {
      const r = run('systemctl', ['--user', 'restart', 'dsv4shim-shim.service'], DATA);
      log(r.ok ? 'shim restarted via systemd — running the new code' : `systemctl restart failed: ${r.out}`);
      return;
    }
  }

  if (process.platform === 'win32') {
    // CONFIRMED LIVE BUG, fixed 2026-08-13: this used to just kill the shim and stop, same
    // as the generic non-systemd fallback below -- but on Windows that leaves it down
    // indefinitely rather than "restarting on next use". A detached `dsv4shim start` spawned
    // over an SSH exec session gets killed the moment that SSH session ends (confirmed
    // live on PC-4D: Windows OpenSSH tears down the whole job object, even a Node child
    // spawned with detached:true) -- and even run locally, nothing guarantees the NEXT
    // "use" is `dsv4shim run`/`dsv4shim start` specifically rather than an already-running
    // `claude` session just making requests into a now-dead shim. The scheduled-task
    // launcher (`dsv4shim-shim`, set up specifically because of Windows autostart
    // unreliability -- see machine-inventory memory) is immune to both problems, since a
    // scheduled task runs outside any interactive session's job object. Use it the same
    // way the systemd branch above does: stop, then immediately bring it back up in one step.
    const killResult = run('powershell.exe', ['-NoProfile', '-Command',
      `Get-NetTCPConnection -LocalPort ${port} -State Listen -EA SilentlyContinue | Select-Object -Expand OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -EA SilentlyContinue }`], DATA);
    if (!killResult.ok) { log('could not stop the shim; restart it yourself'); return; }
    const task = run('schtasks', ['/query', '/tn', 'dsv4shim-shim'], DATA);
    if (task.ok) {
      const restart = run('schtasks', ['/run', '/tn', 'dsv4shim-shim'], DATA);
      log(restart.ok ? 'shim restarted via scheduled task — running the new code'
        : 'shim stopped, but the scheduled task failed to restart it — restart it yourself');
    } else {
      log('shim stopped — no scheduled-task launcher found; it restarts on the new code next time `dsv4shim start`/`dsv4shim run` is used');
    }
    return;
  }
  const kill = run('sh', ['-c', `lsof -ti tcp:${port} -sTCP:LISTEN | xargs -r kill`], DATA);
  log(kill.ok ? 'shim stopped — it restarts on the new code on next use' : 'could not stop the shim; restart it yourself');
}

/**
 * Installs the pre-push guard into the CACHE clone itself — CACHE is the repo
 * this project pushes from, so this is the only .git/hooks/ that matters. Runs
 * from CACHE's own bin/pre-push-hook.sh (present after the reset above), so
 * there is no dependency on any other clone existing on the machine.
 */
function installPrePushHook() {
  const src = join(CACHE, 'bin', 'pre-push-hook.sh');
  if (!existsSync(src)) return;
  const dst = join(CACHE, '.git', 'hooks', 'pre-push');
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(src, dst, { force: true });
  try { chmodSync(dst, 0o755); } catch { /* no-op on Windows filesystems */ }
  log('pre-push guard (re)installed');
}

function writeResult(o) {
  try {
    writeFileSync(join(DATA, '.last-update.json'),
      JSON.stringify({ timestamp: new Date().toISOString(), ...o }, null, 2) + '\n');
  } catch { /* reporting must not fail the update */ }
}
