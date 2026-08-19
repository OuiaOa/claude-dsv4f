#!/usr/bin/env node
/**
 * Tests for bin/dsv4shim-lib.mjs — the small helper layer exported for testability.
 *
 * Currently covers resolveClaude(): the Windows PATH-resolver that picks between
 * 'claude' (no extension, lets cmd.exe apply PATHEXT) and an absolute fallback path.
 * The current dsv4shim.mjs hardcodes the literal string 'claude.cmd' and never falls
 * back, which is the bug these tests will fail against.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { resolveClaude } from './bin/dsv4shim-lib.mjs';

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log(`  \x1b[32m✓\x1b[0m ${name}`); pass++; }
  catch (e) { console.log(`  \x1b[31m✗\x1b[0m ${name}  -> ${e.message}`); fail++; }
}

// All four test cases inject stubs via the dependency-injection signature, so the
// suite is identical on Linux, macOS and Windows.
const okWhere = { status: 0, stdout: Buffer.from('C:\\Users\\User\\.local\\bin\\claude.exe\n') };
const missWhere = { status: 1, stdout: Buffer.from('') };
const throwingExec = () => { throw new Error('spawn failed'); };
const fsAllow = (paths) => ({ existsSync: (p) => paths.includes(p) });
const envOf = (o) => o;

console.log('\n\x1b[1mdsv4shim CLI tests\x1b[0m\n');
console.log('\x1b[1mresolveClaude()\x1b[0m');

check('non-Windows: returns "claude" without touching fs or where', () => {
  const r = resolveClaude({
    platform: 'linux',
    exec: throwingExec,
    fsSync: fsAllow([]),
    env: envOf({}),
    home: '/tmp',
  });
  assert.equal(r, 'claude');
});

check('Windows + where.exe finds claude: returns "claude" (no extension)', () => {
  // The whole point: cmd.exe with shell:true treats "claude.cmd" as fully-qualified
  // and skips PATHEXT. Returning "claude" lets PATHEXT resolve it to claude.exe.
  const r = resolveClaude({
    platform: 'win32',
    exec: (cmd, args) => cmd === 'where.exe' && args[0] === 'claude' ? okWhere : missWhere,
    fsSync: fsAllow([]),
    env: envOf({}),
    home: '/tmp/empty',
  });
  assert.equal(r, 'claude');
});

check('Windows + where.exe miss + ~/.local/bin/claude.exe exists: returns that path', () => {
  const home = path.join(path.parse(os.tmpdir()).root, 'fakehome');
  const candidate = path.join(home, '.local', 'bin', 'claude.exe');
  const r = resolveClaude({
    platform: 'win32',
    exec: () => missWhere,
    fsSync: fsAllow([candidate]),
    env: envOf({}),
    home,
  });
  assert.equal(r, candidate);
});

check('Windows + where.exe miss + APPDATA\\npm\\claude.cmd exists: returns that path', () => {
  // PRE-EXISTING BUG in this test, fixed 2026-08-13: path.join() uses the RUNTIME os's
  // separator, not the simulated `platform` param — on a Linux/Mac dev machine that means
  // POSIX '/' even while testing 'win32' behavior. A hardcoded all-backslash expected
  // string could therefore never match the implementation's actual path.join() output
  // except when this suite happened to run ON Windows. Build the expectation the same way
  // the implementation does, so the test is meaningful on every dev platform.
  const appdata = 'C:\\Users\\Test\\AppData\\Roaming';
  const expected = path.join(appdata, 'npm', 'claude.cmd');
  const r = resolveClaude({
    platform: 'win32',
    exec: () => missWhere,
    fsSync: fsAllow([expected]),
    env: envOf({ APPDATA: appdata }),
    home: '/tmp/empty',
  });
  assert.equal(r, expected);
});

check('Windows + nothing found: throws with an actionable message', () => {
  assert.throws(() => resolveClaude({
    platform: 'win32',
    exec: () => missWhere,
    fsSync: fsAllow([]),
    env: envOf({}),
    home: '/tmp/empty',
  }), (err) => /Claude Code CLI not found/.test(err.message) && /--use-existing-claude/.test(err.message));
});

check('Windows + where.exe throws (sandboxed env): falls through to fallback paths', () => {
  const home = path.join(path.parse(os.tmpdir()).root, 'fakehome');
  const candidate = path.join(home, '.local', 'bin', 'claude.exe');
  const r = resolveClaude({
    platform: 'win32',
    exec: throwingExec,
    fsSync: fsAllow([candidate]),
    env: envOf({}),
    home,
  });
  assert.equal(r, candidate);
});

check('Windows + DSV4SHIM_DATA_DIR/bin/claude.exe bundled: returned first (PATH bypassed)', () => {
  const home = path.join(path.parse(os.tmpdir()).root, 'fakehome');
  const bundled = path.join(home, '.local', 'share', 'dsv4shim', 'bin', 'claude.exe');
  const r = resolveClaude({
    platform: 'win32',
    // where.exe finds something on PATH — but bundled should still win
    exec: () => okWhere,
    fsSync: fsAllow([bundled]),
    env: envOf({ DSV4SHIM_DATA_DIR: path.join(home, '.local', 'share', 'dsv4shim') }),
    home,
  });
  assert.equal(r, bundled);
});

check('Windows + DSV4SHIM_DATA_DIR set but no bundled copy: falls through to PATH/lookup', () => {
  const home = path.join(path.parse(os.tmpdir()).root, 'fakehome');
  const r = resolveClaude({
    platform: 'win32',
    exec: () => okWhere,
    fsSync: fsAllow([]),
    env: envOf({ DSV4SHIM_DATA_DIR: path.join(home, '.local', 'share', 'dsv4shim') }),
    home,
  });
  assert.equal(r, 'claude');
});

// -------------------------------------------------------------------------------------
// Two real, confirmed bugs fixed 2026-08-13 in the same change:
//   1. The bundled-copy check used to live entirely inside `if (platform !== 'win32')
//      return 'claude'` -- i.e. it only ran on Windows. `install.sh --bundle` on Linux/Mac
//      copied a binary to a path resolveClaude() would NEVER look at, making --bundle
//      silently inert everywhere except Windows.
//   2. Even fixed for #1, the check only fired when the caller had explicitly set
//      DSV4SHIM_DATA_DIR in env -- which dsv4shim.mjs's own cmdRun() never does (it computes
//      DATA_DIR locally with a fallback default but doesn't export it back into
//      process.env before calling resolveClaude()). So in EVERY real, non-test call site,
//      the bundled check would never have fired even on Windows, despite test #7 above
//      (which hand-supplies DSV4SHIM_DATA_DIR) appearing to prove it worked.
console.log('\n\x1b[1mresolveClaude() -- 2026-08-13 bundled-copy bug fixes\x1b[0m');

check('non-Windows: a bundled copy IS now checked and preferred over bare "claude"', () => {
  const home = '/home/fakeuser';
  const bundled = path.join(home, '.local', 'share', 'dsv4shim', 'bin', 'claude');
  const r = resolveClaude({
    platform: 'linux',
    exec: throwingExec, // must never even get this far -- bundled wins first
    fsSync: fsAllow([bundled]),
    env: envOf({}),
    home,
  });
  assert.equal(r, bundled);
});

check('non-Windows: no bundled copy present still falls back to bare "claude" (unaffected)', () => {
  const r = resolveClaude({
    platform: 'linux',
    exec: throwingExec,
    fsSync: fsAllow([]),
    env: envOf({}),
    home: '/home/fakeuser',
  });
  assert.equal(r, 'claude');
});

check('macOS: bundled copy is also checked (not just win32/linux)', () => {
  const home = '/Users/fakeuser';
  const bundled = path.join(home, '.local', 'share', 'dsv4shim', 'bin', 'claude');
  const r = resolveClaude({
    platform: 'darwin',
    exec: throwingExec,
    fsSync: fsAllow([bundled]),
    env: envOf({}),
    home,
  });
  assert.equal(r, bundled);
});

check('Windows: bundled copy found WITHOUT explicitly setting DSV4SHIM_DATA_DIR (the real-world case)', () => {
  // This is the scenario that matters: dsv4shim.mjs's cmdRun() never sets DSV4SHIM_DATA_DIR in
  // the environment resolveClaude() sees -- it only has a LOCAL variable with the same
  // fallback logic. Passing env: {} here (no DSV4SHIM_DATA_DIR key at all) is the honest
  // simulation of that; the fix means resolveClaude() must derive the same default path
  // itself rather than requiring the caller to have already done so.
  const home = path.join(path.parse(os.tmpdir()).root, 'realisticfakehome');
  const bundled = path.join(home, '.local', 'share', 'dsv4shim', 'bin', 'claude.exe');
  const r = resolveClaude({
    platform: 'win32',
    exec: () => okWhere, // PATH also has a claude -- bundled must still win
    fsSync: fsAllow([bundled]),
    env: envOf({}), // deliberately no DSV4SHIM_DATA_DIR
    home,
  });
  assert.equal(r, bundled);
});

check('an explicit dataDir override takes precedence over the computed default', () => {
  const explicitDir = '/opt/custom-dsv4shim-location';
  const bundled = path.join(explicitDir, 'bin', 'claude');
  const r = resolveClaude({
    platform: 'linux',
    exec: throwingExec,
    fsSync: fsAllow([bundled]),
    env: envOf({}),
    home: '/home/fakeuser',
    dataDir: explicitDir,
  });
  assert.equal(r, bundled);
});


// --- config three-way merge -------------------------------------------------------
// Add-only merging meant a CHANGED shipped default never reached an existing install: the
// update reported success and the stale value stayed live. Three separate bugs shipped that
// way in one night — stale prices, one shared model sentinel per tier, and a denyModelPatterns
// entry that refused every new pro profile — each silent, each found by accident.
{
  const { threeWayMerge } = await import('./bin/dsv4shim-lib.mjs');
  const eq = (a, b, msg) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: ${JSON.stringify(a)}`); };
  const prev = { denyModelPatterns: ['deepseek-v4-pro', 'x'], model: 'old', cap: { dailyUsd: 5 }, gone: { a: 1 } };
  const base = { denyModelPatterns: ['x'], model: 'new', cap: { dailyUsd: 5 } };

  const untouched = structuredClone(prev);
  const r1 = threeWayMerge(untouched, base, prev);
  check('a stale default the user never touched is updated', () => eq(untouched.model, 'new', 'model'));
  check('an array is replaced whole, not merged element-wise',
    () => eq(untouched.denyModelPatterns, ['x'], 'deny'));
  check('a key the shipped default dropped is removed',
    () => { if ('gone' in untouched) throw new Error(JSON.stringify(r1.removed)); });

  const customised = { ...structuredClone(prev), model: 'MINE', cap: { dailyUsd: 25 } };
  threeWayMerge(customised, base, prev);
  check('a user-changed value is kept', () => eq(customised.model, 'MINE', 'model'));
  check('a user-changed nested value is kept', () => eq(customised.cap.dailyUsd, 25, 'cap'));

  const noBase = structuredClone(prev);
  const r3 = threeWayMerge(noBase, base, undefined);
  check('with no base it degrades to add-only rather than guessing',
    () => { if (noBase.model !== 'old' || r3.updated.length) throw new Error(JSON.stringify(r3)); });

  const fresh = { model: 'old' };
  threeWayMerge(fresh, { model: 'old', brandNew: 1 }, { model: 'old' });
  check('a genuinely new key is still added', () => eq(fresh.brandNew, 1, 'brandNew'));
}

console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m\n`);
process.exit(fail > 0 ? 1 : 0);
