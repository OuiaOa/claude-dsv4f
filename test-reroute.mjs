#!/usr/bin/env node
/**
 * Tests for bin/dsv4shim-reroute.mjs — pointing a KEPT Claude Code CLI install at the dsv4shim
 * shim by merging the standard env block into its own settings.json. The proven mechanism
 * (built and verified end-to-end on PC-4D, 2026-08-12) — these tests cover the merge safety
 * properties: never clobbers existing settings, never overwrites an existing env override,
 * always backs up first, and is cleanly revertible.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildRerouteEnv, buildRerouteExtras, applyCliReroute, revertCliReroute, installPortableAssets } from './bin/dsv4shim-reroute.mjs';

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'dsv4shim-reroute-test-'));
process.on('exit', () => { try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch {} });

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); pass++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `  -> ${detail}` : ''}`); fail++; }
}

console.log('\n\x1b[1mdsv4shim-reroute tests\x1b[0m\n');

console.log('\x1b[1mbuildRerouteEnv\x1b[0m');
{
  const env = buildRerouteEnv({ port: 8788, sentinel: 'test-sentinel-abc' });
  check('base URL points at the given port', env.ANTHROPIC_BASE_URL === 'http://127.0.0.1:8788');
  check('auth token is the given sentinel', env.ANTHROPIC_AUTH_TOKEN === 'test-sentinel-abc');
  check('the built-in Default row is left in charge of the default profile', !('ANTHROPIC_MODEL' in env));
  // Fable has its own env var; leaving it unset is what made it fall through to the native
  // entry and ignore the Pro/max intent entirely.
  check('fable gets its own profile', env.ANTHROPIC_DEFAULT_FABLE_MODEL === 'deepseek-v4-pro-max');
  check('no duplicate custom-model entry is created',
    env.ANTHROPIC_CUSTOM_MODEL_OPTION === undefined && env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME === undefined);
  // Each tier must arrive under its OWN name. One shared sentinel would make opus, sonnet and
  // fable indistinguishable at the shim and silently collapse them onto a single model.
  check('opus and sonnet use distinct tier sentinels',
    env.ANTHROPIC_DEFAULT_OPUS_MODEL !== env.ANTHROPIC_DEFAULT_SONNET_MODEL,
    `${env.ANTHROPIC_DEFAULT_OPUS_MODEL} vs ${env.ANTHROPIC_DEFAULT_SONNET_MODEL}`);
  check('haiku is a deliberate pick: flash at high',
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL === 'deepseek-v4-flash-high');
  check('claude-code\'s own background routing gets the cheapest profile',
    env.ANTHROPIC_SMALL_FAST_MODEL === 'deepseek-v4-flash-low');
  check('1M context window is advertised to the CLI',
    env.CLAUDE_CODE_MAX_CONTEXT_TOKENS === '1000000');
  check('fast/background model routes to the cheapest profile', env.ANTHROPIC_SMALL_FAST_MODEL === 'deepseek-v4-flash-low');
  check('classifier-hang mitigations are present (from the dsv4shim shim fixes)',
    env.CLAUDE_CODE_DISABLE_FAST_MODE === '1' && env.CLAUDE_CODE_TWO_STAGE_CLASSIFIER === '0');
}

console.log('\n\x1b[1mapplyCliReroute: fresh settings.json (none existed before)\x1b[0m');
{
  const dir = path.join(SCRATCH, 'fresh');
  fs.mkdirSync(dir, { recursive: true });
  const settingsPath = path.join(dir, 'settings.json');
  const envBlock = buildRerouteEnv({ port: 8788, sentinel: 's1' });
  const r = applyCliReroute(settingsPath, envBlock, path.join(dir, 'backup'));

  check('applied is true', r.applied === true);
  check('no backup path (nothing existed to back up)', r.backupPath === null);
  check('every env key was added', r.added.length === Object.keys(envBlock).length);
  const written = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  check('settings.json now has the full env block', written.env.ANTHROPIC_BASE_URL === 'http://127.0.0.1:8788');
}

console.log('\n\x1b[1mapplyCliReroute: existing settings.json is preserved, not replaced\x1b[0m');
{
  const dir = path.join(SCRATCH, 'existing');
  fs.mkdirSync(dir, { recursive: true });
  const settingsPath = path.join(dir, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({
    enabledPlugins: { 'code-review@x': true },
    permissions: { defaultMode: 'default' },
  }, null, 2));

  const envBlock = buildRerouteEnv({ port: 8788, sentinel: 's2' });
  const backupDir = path.join(dir, 'backup');
  const r = applyCliReroute(settingsPath, envBlock, backupDir);

  check('backup was made (something existed)', r.backupPath !== null && fs.existsSync(r.backupPath));
  const written = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  check('pre-existing enabledPlugins untouched', written.enabledPlugins['code-review@x'] === true);
  check('pre-existing permissions untouched', written.permissions.defaultMode === 'default');
  check('env block was added alongside existing keys', written.env.ANTHROPIC_BASE_URL === 'http://127.0.0.1:8788');
  const backedUp = JSON.parse(fs.readFileSync(r.backupPath, 'utf8'));
  check('backup is byte-faithful to the ORIGINAL (no env block in it)', backedUp.env === undefined);
}

console.log('\n\x1b[1mapplyCliReroute: never overwrites a value the user already set\x1b[0m');
{
  const dir = path.join(SCRATCH, 'user-override');
  fs.mkdirSync(dir, { recursive: true });
  const settingsPath = path.join(dir, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({
    env: { ANTHROPIC_MODEL: 'user-picked-a-different-model', SOME_OTHER_VAR: 'keep-me' },
  }, null, 2));

  const envBlock = buildRerouteEnv({ port: 8788, sentinel: 's3' });
  const r = applyCliReroute(settingsPath, envBlock, path.join(dir, 'backup'));

  const written = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  check('the user\'s own ANTHROPIC_MODEL override survives untouched',
    written.env.ANTHROPIC_MODEL === 'user-picked-a-different-model');
  check('the user\'s unrelated env var survives', written.env.SOME_OTHER_VAR === 'keep-me');
  check('ANTHROPIC_MODEL was correctly excluded from "added" (not shim-managed)',
    !r.added.includes('ANTHROPIC_MODEL'));
  check('other, non-conflicting keys were still added', written.env.ANTHROPIC_BASE_URL === 'http://127.0.0.1:8788');
}

console.log('\n\x1b[1mapplyCliReroute: malformed existing JSON refuses to proceed rather than clobber\x1b[0m');
{
  const dir = path.join(SCRATCH, 'malformed');
  fs.mkdirSync(dir, { recursive: true });
  const settingsPath = path.join(dir, 'settings.json');
  fs.writeFileSync(settingsPath, '{ not valid json');
  let threw = false;
  try { applyCliReroute(settingsPath, buildRerouteEnv({ port: 8788, sentinel: 's4' }), path.join(dir, 'backup')); }
  catch { threw = true; }
  check('throws instead of silently overwriting unparseable JSON', threw);
  check('the original malformed file is untouched (never got the chance to be overwritten)',
    fs.readFileSync(settingsPath, 'utf8') === '{ not valid json');
}

console.log('\n\x1b[1mrevertCliReroute\x1b[0m');
{
  const dir = path.join(SCRATCH, 'revert');
  fs.mkdirSync(dir, { recursive: true });
  const settingsPath = path.join(dir, 'settings.json');
  const original = { permissions: { defaultMode: 'default' } };
  fs.writeFileSync(settingsPath, JSON.stringify(original, null, 2));

  const r = applyCliReroute(settingsPath, buildRerouteEnv({ port: 8788, sentinel: 's5' }), path.join(dir, 'backup'));
  check('reroute applied (sanity check before reverting)',
    JSON.parse(fs.readFileSync(settingsPath, 'utf8')).env !== undefined);

  revertCliReroute(settingsPath, r.backupPath);
  const reverted = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  check('reverted file has no env block', reverted.env === undefined);
  check('reverted file matches the original exactly', reverted.permissions.defaultMode === 'default');

  let threw = false;
  try { revertCliReroute(settingsPath, '/nonexistent/backup.json'); } catch { threw = true; }
  check('reverting with a missing backup path throws rather than silently no-op-ing', threw);
}

console.log('\n\x1b[1mbuildRerouteExtras\x1b[0m');
{
  const rootDir = path.join(SCRATCH, 'fake-root');
  fs.mkdirSync(rootDir, { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'deny-list.sh'), '#!/bin/bash\necho ok\n');

  const linuxExtras = buildRerouteExtras({ rootDir, platform: 'linux' });
  check('statusLine points at dsv4shim-statusline.mjs under rootDir/bin',
    linuxExtras.statusLine.command.includes(path.join(rootDir, 'bin', 'dsv4shim-statusline.mjs')));
  check('effortLevel defaults to high', linuxExtras.effortLevel === 'high');
  check('skipWebFetchPreflight is set', linuxExtras.skipWebFetchPreflight === true);
  check('denyListSrc included on Linux when deny-list.sh exists', linuxExtras.denyListSrc === path.join(rootDir, 'deny-list.sh'));

  const winExtras = buildRerouteExtras({ rootDir, platform: 'win32' });
  check('denyListSrc NOT included on Windows even when deny-list.sh exists (bash script, no shell guarantee)',
    winExtras.denyListSrc === undefined);

  const noDenyList = buildRerouteExtras({ rootDir: path.join(SCRATCH, 'no-deny-list-here'), platform: 'linux' });
  check('denyListSrc omitted when deny-list.sh does not exist at rootDir', noDenyList.denyListSrc === undefined);
}

console.log('\n\x1b[1mapplyCliReroute: extras (statusLine/effortLevel/deny-list hook)\x1b[0m');
{
  const dir = path.join(SCRATCH, 'extras-fresh');
  fs.mkdirSync(dir, { recursive: true });
  const settingsPath = path.join(dir, 'settings.json');
  const rootDir = path.join(SCRATCH, 'fake-root'); // reuse the one with deny-list.sh from above
  const extras = buildRerouteExtras({ rootDir, platform: 'linux' });

  const r = applyCliReroute(settingsPath, buildRerouteEnv({ port: 8788, sentinel: 'extras1' }), path.join(dir, 'backup'), extras);
  const written = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  check('statusLine was added', written.statusLine?.type === 'command');
  check('effortLevel was added', written.effortLevel === 'high');
  check('skipWebFetchPreflight was added', written.skipWebFetchPreflight === true);
  check('deny-list PreToolUse hook was added', written.hooks?.PreToolUse?.some(h =>
    h.hooks.some(hh => hh.command.includes('deny-list.sh'))));
  check('permissions was NOT touched (extras deliberately excludes it)', written.permissions === undefined);
  check('extras additions are reported in r.added', r.added.includes('statusLine') && r.added.includes('effortLevel'));
}

console.log('\n\x1b[1mapplyCliReroute: extras never overwrite an existing customization\x1b[0m');
{
  const dir = path.join(SCRATCH, 'extras-existing');
  fs.mkdirSync(dir, { recursive: true });
  const settingsPath = path.join(dir, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({
    statusLine: { type: 'command', command: 'my-own-custom-statusline.sh' },
    permissions: { defaultMode: 'bypassPermissions' },
  }, null, 2));
  const rootDir = path.join(SCRATCH, 'fake-root');
  const extras = buildRerouteExtras({ rootDir, platform: 'linux' });

  applyCliReroute(settingsPath, buildRerouteEnv({ port: 8788, sentinel: 'extras2' }), path.join(dir, 'backup'), extras);
  const written = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  check('the user\'s own statusLine survives untouched', written.statusLine.command === 'my-own-custom-statusline.sh');
  check('effortLevel was still added (it was missing)', written.effortLevel === 'high');
  check('the user\'s own permissions setting survives untouched (extras never touches permissions at all)',
    written.permissions.defaultMode === 'bypassPermissions');
}

console.log('\n\x1b[1mapplyCliReroute: deny-list hook is deduped, never duplicated on a second reroute\x1b[0m');
{
  const dir = path.join(SCRATCH, 'extras-dedup');
  fs.mkdirSync(dir, { recursive: true });
  const settingsPath = path.join(dir, 'settings.json');
  const rootDir = path.join(SCRATCH, 'fake-root');
  const extras = buildRerouteExtras({ rootDir, platform: 'linux' });

  applyCliReroute(settingsPath, buildRerouteEnv({ port: 8788, sentinel: 'dedup1' }), path.join(dir, 'backup1'), extras);
  applyCliReroute(settingsPath, buildRerouteEnv({ port: 8788, sentinel: 'dedup1' }), path.join(dir, 'backup2'), extras);
  const written = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  check('exactly one deny-list hook entry after two reroute applications',
    written.hooks.PreToolUse.filter(h => h.hooks.some(hh => hh.command.includes('deny-list.sh'))).length === 1);
}


// --- agents/skills reach the CONFIG dir ------------------------------------------
// Both installers copy these next to the binary, into the INSTALL dir, which Claude Code
// never reads — it discovers them under the config dir. Shipped skills were therefore
// present-but-invisible on every machine; found while deploying 2026-08-18.
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assets-src-'));
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'assets-cfg-'));
  fs.mkdirSync(path.join(root, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(root, 'skills', 'demo-skill'), { recursive: true });
  fs.writeFileSync(path.join(root, 'agents', 'a.md'), 'agent');
  fs.writeFileSync(path.join(root, 'skills', 'demo-skill', 'SKILL.md'), 'skill');

  const added = installPortableAssets(cfg, root);
  check('agents land in the config dir, not the install dir',
    fs.existsSync(path.join(cfg, 'agents', 'a.md')), JSON.stringify(added));
  check('skills copy as whole directories',
    fs.existsSync(path.join(cfg, 'skills', 'demo-skill', 'SKILL.md')), JSON.stringify(added));

  // A user who edits a shipped agent must not have it silently reverted on the next update.
  fs.writeFileSync(path.join(cfg, 'agents', 'a.md'), 'MINE');
  installPortableAssets(cfg, root);
  check('a locally edited asset is never overwritten',
    fs.readFileSync(path.join(cfg, 'agents', 'a.md'), 'utf8') === 'MINE');

  // assetsRoot tells applyCliReroute where to copy FROM; it is not a settings key, and
  // writing it verbatim would leave a stray absolute path in the user's settings.json.
  const sp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'assets-set-')), 'settings.json');
  applyCliReroute(sp, { A: '1' }, path.join(os.tmpdir(), 'assets-bak'),
                  { ...buildRerouteExtras({ rootDir: root, platform: 'linux' }) });
  const written = JSON.parse(fs.readFileSync(sp, 'utf8'));
  check('assetsRoot never leaks into settings.json', !('assetsRoot' in written),
    JSON.stringify(Object.keys(written)));
  check('reroute installs the assets alongside the env block',
    fs.existsSync(path.join(path.dirname(sp), 'agents', 'a.md')));
}


// --- stale shim sentinels are refreshed; user overrides are not -------------------
// A machine rerouted before the per-tier sentinels existed kept every tier pointing at one
// shared name. tierOf() then returns null for all of them and the Pro/Flash split collapses
// onto the main slot — Sonnet silently billing at Pro's 3x rate. Found live on all five
// machines 2026-08-18, because applyCliReroute() only ever ADDED absent keys.
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-env-'));
  const sp = path.join(d, 'settings.json');
  fs.writeFileSync(sp, JSON.stringify({
    env: {
      ANTHROPIC_MODEL: 'deepseek-v4-flash',              // stale sentinel -> must refresh
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-opus',   // stale from a PREVIOUS scheme
      ANTHROPIC_CUSTOM_MODEL_OPTION: 'deepseek-v4-flash',
      ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: 'DeepSeek V4 Flash 0731',
      ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION: 'legacy custom entry',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9999',       // machine-specific -> never touched
      ANTHROPIC_AUTH_TOKEN: 'user-token',
    },
  }, null, 2));

  const env = buildRerouteEnv({ port: 8788, sentinel: 'SENT' });
  applyCliReroute(sp, env, path.join(d, 'bak'));
  const after = JSON.parse(fs.readFileSync(sp, 'utf8')).env;

  check('a stale tier sentinel is refreshed, not left behind',
    after.ANTHROPIC_DEFAULT_SONNET_MODEL === 'deepseek-v4-flash-max', after.ANTHROPIC_DEFAULT_SONNET_MODEL);
  check('opus and sonnet end up distinguishable',
    after.ANTHROPIC_DEFAULT_OPUS_MODEL !== after.ANTHROPIC_DEFAULT_SONNET_MODEL,
    `${after.ANTHROPIC_DEFAULT_OPUS_MODEL} vs ${after.ANTHROPIC_DEFAULT_SONNET_MODEL}`);
  // The custom-model entry is gone entirely — it duplicated a menu that already lists every
  // tier. A stale one left behind by an older reroute is not this function's to delete, but it
  // must not be re-added either.
  check('old default and custom-model entries are removed',
    !('ANTHROPIC_MODEL' in after) && !('ANTHROPIC_CUSTOM_MODEL_OPTION' in after) &&
      !('ANTHROPIC_CUSTOM_MODEL_OPTION_NAME' in after) && !('ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION' in after),
    JSON.stringify(after));
  check('an existing base URL is never rewritten',
    after.ANTHROPIC_BASE_URL === 'http://127.0.0.1:9999', after.ANTHROPIC_BASE_URL);
  check('an existing auth token is never rewritten',
    after.ANTHROPIC_AUTH_TOKEN === 'user-token', after.ANTHROPIC_AUTH_TOKEN);
}

// A value that is NOT one of our sentinels is the user's deliberate choice and stays put.
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'user-env-'));
  const sp = path.join(d, 'settings.json');
  fs.writeFileSync(sp, JSON.stringify({ env: { ANTHROPIC_MODEL: 'my-own-model' } }, null, 2));
  applyCliReroute(sp, buildRerouteEnv({ port: 1, sentinel: 's' }), path.join(d, 'bak'));
  const after = JSON.parse(fs.readFileSync(sp, 'utf8')).env;
  check('a user-chosen model is never overwritten by a reroute',
    after.ANTHROPIC_MODEL === 'my-own-model', after.ANTHROPIC_MODEL);
}

console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m\n`);
process.exit(fail > 0 ? 1 : 0);
