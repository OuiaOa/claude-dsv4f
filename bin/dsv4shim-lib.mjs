#!/usr/bin/env node
/**
 * Side-effect-free helpers shared by bin/dsv4shim.mjs and the CLI tests.
 *
 * Kept separate so it can be imported from a test without triggering the
 * top-level dispatch in dsv4shim.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { findPrivateClaude } from './dsv4shim-claude.mjs';

/**
 * Recursively visit every FILE (not directory) under `root`, calling
 * `onFile(fullPath, relativePath)` for each. Shared by dsv4shim-sources.mjs and dsv4shim-scrub.mjs,
 * which each used to hand-roll their own near-identical recursive walk — five copies across
 * the two files, differing only in what they did per file. A missing/unreadable directory is
 * silently skipped (matches every original copy's behavior: detection/scrub must not crash
 * just because a source half-exists).
 *
 * Returning `false` from `onFile` stops the walk early (used by counters with a cap, so a
 * huge tree can't stall setup).
 *
 * @param {string} root
 * @param {(fullPath: string, relativePath: string) => (void|boolean)} onFile
 */
export function walkFiles(root, onFile) {
  let stopped = false;
  const walk = (dir, relBase) => {
    if (stopped) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (stopped) return;
      const full = path.join(dir, e.name);
      const rel = relBase ? path.join(relBase, e.name) : e.name;
      if (e.isDirectory()) walk(full, rel);
      else if (onFile(full, rel) === false) { stopped = true; return; }
    }
  };
  walk(root, '');
}

/**
 * Resolve the Claude Code CLI to invoke.
 *
 * On non-Windows, returns 'claude' (the standard PATH lookup finds it).
 *
 * On Windows, the bug this fixes: passing the literal string 'claude.cmd' to
 * `spawnSync(..., { shell: true })` hands the command line to
 * `cmd.exe /d /s /c "claude.cmd <args>"`. cmd.exe treats `claude.cmd` as a
 * fully-qualified filename and does NOT fall back to PATHEXT — so a real
 * `claude.exe` on PATH is never found. Returning 'claude' (no extension) lets
 * cmd.exe apply PATHEXT and find claude.exe / claude.cmd / claude.bat.
 *
 * If `where.exe claude` does not find anything, fall back to the common
 * install locations so PATH doesn't have to be set up for this tool to work.
 *
 * Dependency injection lets tests swap out spawnSync / fs / env without
 * monkey-patching globals.
 *
 * @param {object} [deps]
 * @param {NodeJS.Platform} [deps.platform]  defaults to process.platform
 * @param {string}           [deps.home]     defaults to os.homedir()
 * @param {object}           [deps.env]      defaults to process.env
 * @param {typeof fs}        [deps.fsSync]   defaults to node:fs
 * @param {typeof spawnSync} [deps.exec]     defaults to node:child_process.spawnSync
 * @returns {string} absolute path or bare command name to pass to spawn
 * @throws  if no candidate is found
 */
export function resolveClaude({ platform = process.platform,
                                home = os.homedir(),
                                env = process.env,
                                // Same fallback dsv4shim.mjs itself uses for DATA_DIR — kept as
                                // a real default (not just "read env.DSV4SHIM_DATA_DIR and give
                                // up if it's unset") because callers essentially never set
                                // that env var explicitly; the default install path IS the
                                // data dir on a normal install. Second bug found alongside
                                // the platform one below: without this default, the bundled
                                // check only ever fired for someone who'd hand-exported
                                // DSV4SHIM_DATA_DIR — i.e. never, in practice.
                                dataDir = env.DSV4SHIM_DATA_DIR || path.join(home, '.local', 'share', 'dsv4shim'),
                                fsSync = fs,
                                exec = spawnSync } = {}) {
  // Bundled copy wins on EVERY platform when present — "bundled-private" mode (install
  // --bundle, or the actual bundle-and-drop-credentials action a "remove Claude Code"
  // setup choice performs — see dsv4shim-scrub.mjs's performCliRemoval) copies the real
  // binary here specifically so dsv4shim never has to fall back to a system-wide `claude`
  // that might carry a real Anthropic login.
  //
  // CONFIRMED LIVE BUG, fixed 2026-08-13: this check used to live entirely inside the
  // `if (platform !== 'win32') return 'claude'` branch below — i.e. it ran ONLY on
  // Windows. On Linux/Mac this function unconditionally returned the bare string
  // 'claude' before ever looking at the data dir, so `install.sh --bundle` copied a
  // binary to a path nothing ever read: the bundle was silently inert on every platform
  // except Windows. Moved above the early return so it actually takes effect everywhere.
  const bundleDir = path.join(dataDir, 'bin');
  const bundleNames = platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude'];
  for (const name of bundleNames) {
    const p = path.join(bundleDir, name);
    try { if (fsSync.existsSync(p)) return p; } catch {}
  }

  const privateClaude = findPrivateClaude(dataDir, platform, fsSync);
  if (privateClaude) return privateClaude;

  if (platform !== 'win32') return 'claude';

  // Otherwise let cmd.exe's PATHEXT do its job: if 'claude' resolves on PATH
  //    (via where.exe), hand back the bare name with no extension.
  try {
    const r = exec('where.exe', ['claude'], { stdio: ['ignore', 'pipe', 'ignore'] });
    if (r && r.status === 0 && r.stdout && r.stdout.toString().trim()) return 'claude';
  } catch { /* fall through to path-based lookups below */ }

  // Final fallback: scan the few places Claude Code actually lands on Windows
  // when it's installed outside npm (e.g. direct download to ~/.local/bin).
  const candidates = [
    path.join(home, '.local', 'bin', 'claude.exe'),
    path.join(home, '.local', 'bin', 'claude.cmd'),
    env.APPDATA     ? path.join(env.APPDATA,     'npm', 'claude.cmd') : '',
    env.APPDATA     ? path.join(env.APPDATA,     'npm', 'claude')     : '',
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'npm', 'bin', 'claude.cmd') : '',
  ].filter(Boolean);

  for (const c of candidates) {
    try { if (fsSync.existsSync(c)) return c; } catch { /* unreadable FS — ignore */ }
  }

  throw new Error(
    `Claude Code CLI not found.\n` +
    `  Looked for a private runner under ${path.join(dataDir, 'claude-code')}, a bundled copy, 'claude' on PATH (via where.exe), and in: ${candidates.join(', ')}\n` +
    `  Re-run dsv4shim setup, or pass --use-existing-claude if you installed Claude Code elsewhere.`
  );
}

/**
 * Three-way merge of a shipped default into a live config, using the PREVIOUSLY shipped default
 * as the base. Mutates `live`.
 *
 * A live value that still equals the old default was never touched by the user, so the new
 * default applies. A value that differs is theirs and is kept. Arrays compare whole — merging
 * them element-wise silently retains a removed entry, which is precisely how a stale
 * `denyModelPatterns` entry survived and refused every new profile.
 *
 * With no `prev` (a first run, or an unreadable old default) this degrades to add-only, which
 * is the safe direction: it can leave a value stale, never clobber a deliberate one.
 *
 * Exported for tests: this rule decides whether a shipped change reaches five machines or
 * silently does not, and it had been wrong three separate times.
 */
export function threeWayMerge(live, base, prev) {
  const added = [], updated = [], kept = [], removed = [];
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const isPlain = (v) => v && typeof v === 'object' && !Array.isArray(v);
  (function merge(dst, src, pv, path = '') {
    for (const [k, v] of Object.entries(src)) {
      const here = path ? `${path}.${k}` : k;
      const was = pv ? pv[k] : undefined;
      if (!(k in dst)) { dst[k] = v; added.push(here); continue; }
      if (isPlain(v) && isPlain(dst[k])) { merge(dst[k], v, isPlain(was) ? was : undefined, here); continue; }
      if (same(dst[k], v)) continue;
      if (pv === undefined || was === undefined) continue;
      if (same(dst[k], was)) { dst[k] = v; updated.push(here); }
      else kept.push(here);
    }
    if (pv) {
      for (const k of Object.keys(pv)) {
        const here = path ? `${path}.${k}` : k;
        if (k in src || !(k in dst)) continue;
        if (same(dst[k], pv[k])) { delete dst[k]; removed.push(here); }
      }
    }
  })(live, base, prev);
  return { added, updated, kept, removed };
}
