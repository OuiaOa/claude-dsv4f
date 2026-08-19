#!/usr/bin/env node
/**
 * dsv4shim-sources — detect the tools whose history can be brought into dsv4shim, and
 * describe what can be done with each.
 *
 * Three possible sources, any combination of which may be present:
 *
 *   claude-cli      The standalone Claude Code CLI. Its transcripts live in
 *                   ~/.claude/projects/<encoded-cwd>/<session>.jsonl, with memories in
 *                   <project>/memory/*.md and portable config (agents/skills/commands/
 *                   output-styles/CLAUDE.md) at the root of ~/.claude.
 *
 *   claude-desktop  The Claude Desktop app. VERIFIED 2026-08-12 against a real install:
 *                   its coding sessions are NOT a separate format — Desktop embeds the real
 *                   Claude Code CLI and writes to the SAME ~/.claude/projects/*.jsonl tree.
 *                   What is Desktop-specific is a set of small per-session UI sidecars at
 *                   <appdata>/Claude/claude-code-sessions/<workspace>/<account>/local_<uuid>.json
 *                   (title, cwd, model, and a cliSessionId pointing at the real transcript),
 *                   plus deleted_<uuid> tombstone files for soft-deleted ones. Those sidecars
 *                   are what Desktop's own session list reads — so removing them is how an
 *                   imported session disappears from Desktop without touching the transcript
 *                   that dsv4shim now shares with the CLI.
 *
 *   opencode        Stores everything in a SQLite database (~/.local/share/opencode/
 *                   opencode.db) — project/session/message/part tables. The older on-disk
 *                   JSON tree under storage/ is vestigial on current versions (it retains
 *                   only session_diff caches and a migration marker), so the database is the
 *                   only real source of truth. Read with node:sqlite (built in since Node
 *                   22.5) so this adds no dependency.
 *
 * Because claude-cli and claude-desktop SHARE ~/.claude/projects, they are deliberately
 * reported as separate sources with a shared `transcriptRoot`: importing from either brings
 * the same transcripts, and callers must not double-count them. What differs is the scrub
 * (Desktop has sidecars; the CLI does not) and the uninstall.
 *
 * Usage:
 *   dsv4shim-sources           human-readable report
 *   dsv4shim-sources --json    machine-readable, for the installer/setup to consume
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { walkFiles } from './dsv4shim-lib.mjs';

// require() shim so this ESM module can pull in node:sqlite lazily without a top-level
// import (which would hard-fail the whole module on Node < 22.5, breaking detection of the
// other two sources for no reason).
const require = createRequire(import.meta.url);

const HOME = os.homedir();
const WIN = process.platform === 'win32';
const MAC = process.platform === 'darwin';

function dirExists(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}
function fileExists(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/**
 * The shared Claude Code transcript root. Both the standalone CLI and Claude Desktop write
 * here — see the header note.
 */
export function claudeTranscriptRoot(home = HOME) {
  return path.join(home, '.claude', 'projects');
}

/** Locate a `claude` binary without requiring it to be on PATH. */
export function findClaudeBinary({ home = HOME, env = process.env, platform = process.platform } = {}) {
  const win = platform === 'win32';
  // PATH first — `where`/`which` reflect what the user would actually get by typing `claude`.
  // Explicitly pass `env` (rather than letting spawnSync default to this process's own
  // environment) so a caller-supplied PATH is actually respected, not silently ignored in
  // favor of whatever's really on THIS machine's PATH.
  try {
    const probe = win
      ? spawnSync('where.exe', ['claude'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env })
      : spawnSync('which', ['claude'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env });
    if (probe && probe.status === 0 && probe.stdout.trim()) {
      return { path: probe.stdout.trim().split(/\r?\n/)[0], onPath: true };
    }
  } catch { /* fall through */ }

  const candidates = win
    ? [
        path.join(home, '.local', 'bin', 'claude.exe'),
        path.join(home, '.local', 'bin', 'claude.cmd'),
        env.APPDATA ? path.join(env.APPDATA, 'npm', 'claude.cmd') : '',
        env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'npm', 'bin', 'claude.cmd') : '',
      ]
    : [
        path.join(home, '.local', 'bin', 'claude'),
        '/usr/local/bin/claude',
        '/opt/homebrew/bin/claude',
        path.join(home, '.npm-global', 'bin', 'claude'),
      ];
  for (const c of candidates.filter(Boolean)) {
    if (fileExists(c)) return { path: c, onPath: false };
  }
  return null;
}

/** Where Claude Desktop keeps its per-user application data, per platform. */
export function desktopDataDir({ home = HOME, env = process.env, platform = process.platform } = {}) {
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  if (platform === 'win32') {
    return env.APPDATA ? join(env.APPDATA, 'Claude') : join(home, 'AppData', 'Roaming', 'Claude');
  }
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Claude');
  return join(home, '.config', 'Claude');
}

/**
 * opencode's data directory. It uses the XDG layout on every platform — VERIFIED on Windows,
 * where it is ~/.local/share/opencode rather than %APPDATA%. The Electron desktop wrapper
 * (ai.opencode.desktop) stores only its own window/UI state and shares this same database,
 * so it needs no separate handling.
 */
export function opencodeDataDir({ home = HOME, env = process.env } = {}) {
  if (env.XDG_DATA_HOME) return path.join(env.XDG_DATA_HOME, 'opencode');
  return path.join(home, '.local', 'share', 'opencode');
}

/** Count sessions + memories in the shared Claude transcript tree, in a single bounded walk. */
function claudeStats(root, cap = 100000) {
  const stats = { sessions: 0, memories: 0 };
  if (!dirExists(root)) return stats;
  walkFiles(root, (full, rel) => {
    if (rel.endsWith('.jsonl')) stats.sessions++;
    else if (rel.endsWith('.md') && rel.split(path.sep).includes('memory')) stats.memories++;
    if (stats.sessions + stats.memories >= cap) return false;
  });
  return stats;
}

/** Enumerate Claude Desktop's per-session UI sidecar files. */
export function desktopSidecars({ home = HOME, env = process.env, platform = process.platform } = {}) {
  const base = path.join(desktopDataDir({ home, env, platform }), 'claude-code-sessions');
  const out = [];
  if (!dirExists(base)) return out;
  walkFiles(base, (p, rel) => {
    const name = path.basename(rel);
    if (!name.startsWith('local_') || !name.endsWith('.json')) return;
    let cliSessionId = null, title = null, cwd = null;
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      cliSessionId = j.cliSessionId || null;
      title = j.title || null;
      cwd = j.cwd || null;
    } catch { /* unreadable/malformed sidecar — still report the file so it can be scrubbed */ }
    out.push({ file: p, cliSessionId, title, cwd });
  });
  return out;
}

/**
 * Load node:sqlite lazily. It is built in from Node 22.5; on anything older this returns
 * null so the other two sources still detect normally instead of the whole module failing.
 */
export function loadSqlite() {
  try { return require('node:sqlite').DatabaseSync; } catch { return null; }
}

/** Read opencode's session/message/part counts without mutating the database. */
export function opencodeStats(dbPath) {
  if (!fileExists(dbPath)) return { sessions: 0, messages: 0, parts: 0, error: null };
  const DatabaseSync = loadSqlite();
  if (!DatabaseSync) {
    return { sessions: null, messages: null, parts: null, error: 'node:sqlite unavailable (need Node 22.5+)' };
  }
  let db;
  try {
    // readOnly so a running opencode is never disturbed by detection. DatabaseSync does NOT
    // throw on open for a non-database file (VERIFIED) — the error only surfaces on the
    // first query, so a file-corruption check has to happen there, not around the
    // constructor. sqlite_master exists in every valid SQLite file regardless of schema
    // version, so it doubles as a "is this actually a database" probe.
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.prepare('SELECT 1 FROM sqlite_master LIMIT 1').get();
  } catch (e) {
    try { db?.close(); } catch { /* already broken */ }
    return { sessions: null, messages: null, parts: null, error: e.message };
  }
  // Past this point the file is confirmed to be a real SQLite database. A specific table
  // missing (an older/newer opencode schema) is NOT the same failure — count it as 0 rather
  // than treating a schema difference as a corrupt-database error.
  const one = (sql) => { try { return db.prepare(sql).get()?.n ?? 0; } catch { return 0; } };
  const stats = {
    sessions: one('SELECT COUNT(*) AS n FROM session'),
    messages: one('SELECT COUNT(*) AS n FROM message'),
    parts: one('SELECT COUNT(*) AS n FROM part'),
    error: null,
  };
  db.close();
  return stats;
}

/**
 * Detect every importable source on this machine.
 * @returns {Array<object>} one descriptor per source, `present` true/false on each.
 */
export function detectSources({ home = HOME, env = process.env, platform = process.platform } = {}) {
  const transcriptRoot = claudeTranscriptRoot(home);
  const shared = claudeStats(transcriptRoot);

  const binary = findClaudeBinary({ home, env, platform });
  const claudeProfile = path.join(home, '.claude');
  const credentials = path.join(claudeProfile, '.credentials.json');

  const desktopDir = desktopDataDir({ home, env, platform });
  const sidecars = desktopSidecars({ home, env, platform });

  const ocDir = opencodeDataDir({ home, env });
  const ocDb = path.join(ocDir, 'opencode.db');
  const ocStats = opencodeStats(ocDb);

  return [
    {
      id: 'claude-cli',
      label: 'Claude Code CLI',
      // The CLI counts as present when its binary exists OR it left a profile behind. A
      // profile with no binary still holds importable history.
      present: !!binary || dirExists(transcriptRoot),
      binary: binary?.path ?? null,
      binaryOnPath: binary?.onPath ?? false,
      hasCredentials: fileExists(credentials),
      paths: {
        profile: claudeProfile,
        transcriptRoot,
        credentials,
      },
      // Shared with claude-desktop — do not add these to Desktop's counts as well.
      sharesTranscriptsWith: 'claude-desktop',
      stats: shared,
    },
    {
      id: 'claude-desktop',
      label: 'Claude Desktop',
      present: dirExists(desktopDir),
      paths: {
        dataDir: desktopDir,
        sessionSidecars: path.join(desktopDir, 'claude-code-sessions'),
        transcriptRoot,
      },
      sharesTranscriptsWith: 'claude-cli',
      // Desktop's OWN countable artifact is its sidecar list; the transcripts themselves are
      // the shared ones above.
      stats: { sidecars: sidecars.length, sessions: shared.sessions, memories: shared.memories },
      sidecars,
    },
    {
      id: 'opencode',
      label: 'opencode',
      present: fileExists(ocDb),
      paths: {
        dataDir: ocDir,
        db: ocDb,
      },
      stats: ocStats,
    },
  ];
}

// ------------------------------------------------------------------ CLI entry point

const isMain = (() => {
  try { return process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href; }
  catch { return false; }
})();

if (isMain) {
  const sources = detectSources();
  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify(sources, null, 2) + '\n');
  } else {
    const bold = s => `\x1b[1m${s}\x1b[0m`;
    const dim = s => `\x1b[2m${s}\x1b[0m`;
    const grn = s => `\x1b[32m${s}\x1b[0m`;
    console.log(`\n${bold('Importable sources on this machine')}\n`);
    for (const s of sources) {
      if (!s.present) { console.log(`  ${dim(s.label.padEnd(18))} not installed`); continue; }
      let detail;
      if (s.id === 'opencode') {
        detail = s.stats.error
          ? `${s.stats.error}`
          : `${s.stats.sessions} session(s), ${s.stats.messages} message(s)`;
      } else if (s.id === 'claude-desktop') {
        detail = `${s.stats.sidecars} session(s) in its list ${dim('(transcripts shared with the CLI)')}`;
      } else {
        detail = `${s.stats.sessions} transcript(s), ${s.stats.memories} memory file(s)`;
      }
      console.log(`  ${grn(s.label.padEnd(18))} ${detail}`);
      if (s.id === 'claude-cli') {
        console.log(`  ${''.padEnd(18)} ${dim(`binary: ${s.binary || 'not found'}${s.binary && !s.binaryOnPath ? ' (not on PATH)' : ''}`)}`);
        console.log(`  ${''.padEnd(18)} ${dim(`anthropic credentials: ${s.hasCredentials ? 'present' : 'none'}`)}`);
      }
    }
    const sharedNote = sources.find(s => s.id === 'claude-cli')?.present &&
                       sources.find(s => s.id === 'claude-desktop')?.present;
    if (sharedNote) {
      console.log(`\n  ${dim('Note: Claude Code CLI and Claude Desktop share the same transcripts')}`);
      console.log(`  ${dim('(~/.claude/projects) — importing from either brings the same history across.')}`);
    }
    console.log();
  }
}
