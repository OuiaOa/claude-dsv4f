#!/usr/bin/env node
/**
 * dsv4shim-reroute — point an EXISTING, kept-installed Claude Code CLI at the dsv4shim shim, by
 * adding the standard dsv4shim env block to that install's OWN settings.json.
 *
 * This is Axis 3 from the multi-source import design ("keep Claude Code CLI installed, but
 * stop paying Anthropic through it"). The technique is PROVEN — built and verified working
 * end-to-end on PC-4D on 2026-08-12 (a real request through the shim with the target's
 * sentinel returned a genuine DeepSeek reply), then deliberately reverted there once the
 * user decided against a full Desktop takeover. The mechanism itself was never in question;
 * only whether to point it at a shared config without being asked. Applied HERE, it always
 * is asked — this only ever runs as an explicit opt-in on a source disposition the user
 * picked as "leave" or "copy" (i.e. they are deliberately keeping the CLI usable).
 *
 * UNLIKE the scrub module, this never deletes anything — it only ADDS an env block to a
 * settings.json, merging with (never replacing) whatever is already there, after backing
 * the original up. Reverting is exactly "restore the backup."
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * Build the standard dsv4shim env block — the SAME keys dsv4shim-setup.mjs writes into dsv4shim's own
 * isolated profile, applied here to someone else's settings.json instead. Keeping this in
 * one place (rather than copy-pasted between dsv4shim-setup.mjs and here) means a future change
 * to the isolated profile's env doesn't quietly drift out of sync with the reroute path.
 */
export function buildRerouteEnv({ port, sentinel }) {
  return {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    ANTHROPIC_AUTH_TOKEN: sentinel,
    // Profile names, not opaque sentinels. The model picker displays these raw, so each one
    // states the real model AND its thinking level — that is the only way to tell from the menu
    // what an entry actually connects to. No ANTHROPIC_CUSTOM_MODEL_OPTION: it added a sixth,
    // duplicate entry to a menu that already lists every tier.
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4-pro-high',
    ANTHROPIC_DEFAULT_FABLE_MODEL: 'deepseek-v4-pro-max',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-flash-max',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash-high',
    // Whatever Claude Code routes background work to on its own — older Haiku generations,
    // titles, compaction. Cheapest model, lowest thinking that still thinks.
    ANTHROPIC_SMALL_FAST_MODEL: 'deepseek-v4-flash-low',
    CLAUDE_CODE_BG_CLASSIFIER_MODEL: 'deepseek-v4-flash-low',
    CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek-v4-flash-sub',
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
    CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK: '1',
    CLAUDE_CODE_DISABLE_FAST_MODE: '1',
    CLAUDE_CODE_TWO_STAGE_CLASSIFIER: '0',
    CLAUDE_CODE_SKIP_FAST_MODE_NETWORK_ERRORS: '1',
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: '384000',
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1000000',
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '600000',
    API_TIMEOUT_MS: '900000',
    CLAUDE_STREAM_IDLE_TIMEOUT_MS: '900000',
  };
}

/**
 * Build the non-env extras reroute can ALSO carry into a real install — the polish that
 * used to mean "you have to give up shared history with Desktop/opencode to get it" (only
 * the isolated profile got these). Deliberately does NOT include `permissions` — that's the
 * user's real, daily-driver install; silently changing how often it prompts them is a much
 * bigger behavioral call than "which model backend to use", and unlike env vars it isn't
 * reversible-by-inspection if they don't notice. Leave their own permission choice alone.
 *
 * denyListSrc is the dsv4shim install's own SHIPPED copy (ROOT/deny-list.sh) — reused directly
 * rather than copying it a second time into yet another location; it's already a stable
 * path dsv4shim itself manages, and only makes sense to wire up as a hook on non-Windows (it's
 * a bash script — no POSIX shell guaranteed on Windows, same reasoning as statusline.sh's
 * old platform gap that dsv4shim-statusline.mjs replaced).
 */
export function buildRerouteExtras({ rootDir, platform = process.platform }) {
  const extras = {
    statusLine: { type: 'command', command: `node "${path.join(rootDir, 'bin', 'dsv4shim-statusline.mjs')}"`, refreshInterval: 10 },
    effortLevel: 'high',
    skipWebFetchPreflight: true,
  };
  const denyListSrc = path.join(rootDir, 'deny-list.sh');
  if (platform !== 'win32' && fs.existsSync(denyListSrc)) extras.denyListSrc = denyListSrc;
  // Where applyCliReroute() should copy agents/ and skills/ FROM. Carried as an extra so the
  // caller does not need to know the layout of the install directory.
  extras.assetsRoot = rootDir;
  // Also carry the quality hooks into a rerouted real profile. They run local checks in the
  // background and add one SessionStart reminder; Claude's normal loop remains unchanged.
  extras.qualityRoot = rootDir;
  return extras;
}

/**
 * Copy the shipped agents/ and skills/ trees into a Claude Code CONFIG directory.
 *
 * Both installers copy these next to the binary, into the INSTALL directory — which Claude
 * Code never reads. It discovers them under its config dir (`~/.claude`, or the isolated
 * profile), so shipped skills have been present-but-invisible on every machine since they
 * were added, and the six subagents would have been too. Found while deploying 2026-08-18.
 *
 * Copied rather than symlinked on purpose: the config dir may sit on a different volume, and
 * Windows needs a privilege for symlinks that an ordinary install does not have.
 *
 * An existing destination entry is left alone, so an agent or skill the user edited in place
 * survives an update instead of being silently reverted.
 */
export function installPortableAssets(configDir, rootDir) {
  const installed = [];
  for (const kind of ['agents', 'skills']) {
    const src = path.join(rootDir, kind);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(configDir, kind);
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const to = path.join(dest, entry.name);
      if (fs.existsSync(to)) continue;
      fs.cpSync(path.join(src, entry.name), to, { recursive: true });
      installed.push(`${kind}/${entry.name}`);
    }
  }
  return installed;
}

function installQualityHooks(settings, rootDir) {
  const session = path.join(rootDir, 'bin', 'dsv4shim-quality-session.mjs');
  const check = path.join(rootDir, 'bin', 'dsv4shim-quality-check.mjs');
  if (!fs.existsSync(session) || !fs.existsSync(check)) return [];
  settings.hooks ??= {};
  const additions = [];
  const groups = {
    SessionStart: { hooks: [{ type: 'command', command: `node "${session}"`, timeout: 5 }] },
    PostToolUse: { matcher: 'Edit|Write|NotebookEdit', hooks: [{ type: 'command', command: `node "${check}"`, async: true, timeout: 120 }] },
  };
  for (const [event, group] of Object.entries(groups)) {
    settings.hooks[event] ??= [];
    const command = group.hooks[0].command;
    const already = settings.hooks[event].some(h =>
      Array.isArray(h?.hooks) && h.hooks.some(hh => String(hh?.command || '') === command));
    if (!already) { settings.hooks[event].push(group); additions.push(`hooks.${event}[quality]`); }
  }
  return additions;
}

/**
 * Apply the reroute to a settings.json, backing up the original first (or noting there was
 * nothing to back up, if the file didn't exist yet). Merges `env` key-by-key and each extras
 * top-level key individually — never touches anything the target already has a value for
 * (so a user's own deliberate customization always survives a reroute, consistent with how
 * dsv4shim-setup.mjs treats its own settings.json), and never overwrites an env var the target
 * file already set to something else.
 *
 * @param {string} settingsPath
 * @param {object} envBlock       from buildRerouteEnv()
 * @param {string} backupDir
 * @param {object} [extras]       from buildRerouteExtras() — statusLine/effortLevel/etc, and
 *                                 optionally denyListSrc to wire up the PreToolUse hook
 * @returns {{applied: boolean, added: string[], backupPath: string|null}}
 */
/**
 * Env keys whose value this tool owns and may therefore refresh in place, and the test for
 * "this value is still ours". Deliberately narrow: only the model-name keys, and only when the
 * value present looks like a sentinel we wrote. ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN are
 * machine-specific and are never rewritten here.
 */
const SHIM_OWNED_ENV = new Set([
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CODE_BG_CLASSIFIER_MODEL',
]);

const isShimSentinel = (v) =>
  typeof v === 'string' && (/^deepseek-v4-/.test(v) || /^DeepSeek V4 /.test(v));

export function applyCliReroute(settingsPath, envBlock, backupDir, extras = {}) {
  let live = {};
  let hadExisting = false;
  if (fs.existsSync(settingsPath)) {
    hadExisting = true;
    try { live = JSON.parse(fs.readFileSync(settingsPath, 'utf8').replace(/^﻿/, '')); }
    catch (e) { throw new Error(`${settingsPath} is not valid JSON — refusing to touch it: ${e.message}`); }
  }

  let backupPath = null;
  if (hadExisting) {
    fs.mkdirSync(backupDir, { recursive: true });
    backupPath = path.join(backupDir, path.basename(settingsPath));
    fs.copyFileSync(settingsPath, backupPath);
  }

  live.env ??= {};
  const added = [];
  const ownProfile = v => typeof v === 'string' && /^deepseek-v4-/i.test(v);
  if (ownProfile(live.env.ANTHROPIC_MODEL)) {
    delete live.env.ANTHROPIC_MODEL;
    added.push('ANTHROPIC_MODEL (restored Claude Default)');
  }
  if (['ANTHROPIC_CUSTOM_MODEL_OPTION', 'ANTHROPIC_CUSTOM_MODEL_OPTION_NAME', 'ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION']
      .some(k => k in live.env)) {
    for (const key of ['ANTHROPIC_CUSTOM_MODEL_OPTION', 'ANTHROPIC_CUSTOM_MODEL_OPTION_NAME', 'ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION']) {
      delete live.env[key];
    }
    added.push('custom model option (removed duplicate)');
  }
  for (const [k, v] of Object.entries(envBlock)) {
    if (!(k in live.env)) { live.env[k] = v; added.push(k); continue; }
    // A key already present is normally left alone, so a deliberate user override survives a
    // reroute. The exception is a key whose CURRENT value is one of our own sentinels: that is
    // this tool's value to maintain, not the user's, and refusing to update it is how a machine
    // rerouted before the per-tier sentinels existed kept pointing every tier at one shared
    // name — tierOf() then returns null for all of them and the Pro/Flash split silently
    // collapses onto the main slot, billing Sonnet at Pro's 3x rate. Anything that does not
    // look like our sentinel is still treated as the user's and never touched.
    if (SHIM_OWNED_ENV.has(k) && isShimSentinel(live.env[k]) && live.env[k] !== v) {
      live.env[k] = v;
      added.push(`${k} (updated)`);
    }
  }

  // assetsRoot and denyListSrc are instructions to THIS function, not settings keys — strip
  // them or they get written verbatim into the user's settings.json.
  const { denyListSrc, assetsRoot: _assetsRoot, qualityRoot: _qualityRoot, ...topLevelExtras } = extras;
  for (const [k, v] of Object.entries(topLevelExtras)) {
    if (!(k in live)) { live[k] = v; added.push(k); }
  }
  // hooks.PreToolUse is an array — a plain "add if key missing" check would silently skip
  // adding our entry to an ALREADY-populated array (the user's own hook, or a leftover from
  // an earlier reroute). Dedup by command string instead, same as dsv4shim-setup.mjs's own
  // isolated-profile logic, so re-running reroute never duplicates the hook.
  if (denyListSrc) {
    live.hooks ??= {};
    live.hooks.PreToolUse ??= [];
    const already = live.hooks.PreToolUse.some(h =>
      Array.isArray(h?.hooks) && h.hooks.some(hh => String(hh?.command || '').includes('deny-list.sh')));
    if (!already) {
      live.hooks.PreToolUse.push({ matcher: 'Bash', hooks: [{ type: 'command', command: `bash ${denyListSrc}`, timeout: 5 }] });
      added.push('hooks.PreToolUse[deny-list]');
    }
  }
  if (extras.qualityRoot) added.push(...installQualityHooks(live, extras.qualityRoot));

  // Agents and skills live in the CONFIG dir, which is the directory holding settings.json —
  // not the install dir the installers copy them to. Without this a rerouted machine has the
  // files on disk and Claude Code never sees them.
  if (extras.assetsRoot) {
    try {
      const assets = installPortableAssets(path.dirname(settingsPath), extras.assetsRoot);
      if (assets.length) added.push(...assets.map(a => `asset:${a}`));
    } catch (e) {
      // Never fail a reroute over optional extras — the env block is the part that matters.
      console.error(`  warning: could not install agents/skills: ${e.message}`);
    }
  }

  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(live, null, 2) + '\n');
  try { fs.chmodSync(settingsPath, 0o600); } catch { /* Windows */ } // now embeds the sentinel

  return { applied: added.length > 0, added, backupPath };
}

/** Reverse a reroute by restoring the exact backup applyCliReroute made. */
export function revertCliReroute(settingsPath, backupPath) {
  if (!backupPath || !fs.existsSync(backupPath)) {
    throw new Error(`No backup found at ${backupPath} — cannot safely revert.`);
  }
  fs.copyFileSync(backupPath, settingsPath);
}
