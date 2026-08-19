#!/usr/bin/env node
/**
 * dsv4shim-statusline — cross-platform port of the original statusline.sh.
 *
 * The bash version needed a real POSIX shell + curl, neither guaranteed on Windows — so
 * dsv4shim-setup.mjs never wired a statusLine at all there (`WIN ? undefined : {...}`), and every
 * Windows install silently missed the cost/context/burn-rate display under the prompt box.
 * Every dsv4shim install already requires Node itself, so a pure-Node implementation removes that
 * platform gap instead of trying to make bash+curl a dependency on Windows.
 *
 * Claude Code's own /cost computes from an embedded price table keyed on model name; a
 * deepseek-* id misses that lookup and silently reports $0. So spend comes from the shim's
 * own ledger (GET /_dsv4shim/usage) instead. Token counts in the stdin payload are accurate and
 * used as-is.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { configuredPort } from './dsv4shim-port-manager.mjs';

const CONFIG_DIR = process.env.DSV4SHIM_CONFIG_DIR || path.join(os.homedir(), '.config', 'dsv4shim');
const DATA_DIR = process.env.DSV4SHIM_DATA_DIR || path.join(os.homedir(), '.local', 'share', 'dsv4shim');

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

function readPort() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'config.json'), 'utf8'));
    return configuredPort({ envVar: 'DSV4SHIM_PORT', dataDir: DATA_DIR, app: 'dsv4shim', configPort: cfg.port, defaultPort: 8788 });
  } catch { return configuredPort({ envVar: 'DSV4SHIM_PORT', dataDir: DATA_DIR, app: 'dsv4shim', defaultPort: 8788 }); }
}

function readSentinel() {
  try { return fs.readFileSync(path.join(CONFIG_DIR, 'sentinel'), 'utf8').trim(); } catch { return ''; }
}

function fetchUsage(port, sentinel) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const req = http.get({
      host: '127.0.0.1', port, path: '/_dsv4shim/usage', timeout: 1000,
      headers: sentinel ? { Authorization: `Bearer ${sentinel}` } : {},
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { done(JSON.parse(body)); } catch { done({}); } });
    });
    req.on('timeout', () => { req.destroy(); done({}); });
    req.on('error', () => done({}));
  });
}

const s = (() => { try { return JSON.parse(readStdin() || '{}'); } catch { return {}; } })();
const l = await fetchUsage(readPort(), readSentinel());

const C = { dim: '\x1b[2m', r: '\x1b[0m', cyan: '\x1b[36m', grn: '\x1b[32m', yel: '\x1b[33m', orange: '\x1b[38;5;208m', red: '\x1b[31m', b: '\x1b[1m' };
const parts = [];

// model + effort
const effort = s.effort?.level ?? l.lastEffort ?? '?';
const eColor = effort === 'max' ? C.red : (effort === 'none' || effort === 'low') ? C.dim : C.yel;
parts.push(`${C.cyan}DSv4Shim${C.r} ${eColor}${effort}${C.r}`);

// context usage
if (s.context_window?.used_percentage != null) {
  const pct = s.context_window.used_percentage;
  const col = pct > 85 ? C.red : pct > 60 ? C.yel : C.dim;
  const used = (s.context_window.total_input_tokens || 0) + (s.context_window.total_output_tokens || 0);
  parts.push(`${col}ctx ${pct.toFixed(0)}%${C.r} ${C.dim}(${(used / 1000).toFixed(0)}k)${C.r}`);
}

// spend today vs cap
if (l.todayUsd != null) {
  const cap = l.capUsd || 0;
  const frac = cap > 0 ? l.todayUsd / cap : 0;
  const col = frac > 0.9 ? C.red : frac > 0.6 ? C.yel : C.grn;
  const amt = l.exact === false ? `$${l.todayUsdMin.toFixed(3)}-${l.todayUsd.toFixed(3)}` : `$${l.todayUsd.toFixed(3)}`;
  parts.push(`${col}${amt}${C.r}${cap > 0 ? `${C.dim}/$${cap.toFixed(0)}${C.r}` : ''}`);
}

// burn rate
if (l.burn?.tokensPerMin) {
  parts.push(`${C.dim}${l.burn.tokensPerMin.toLocaleString('en-US')} tok/min - $${l.burn.usdPerHour.toFixed(2)}/hr${C.r}`);
}

// vision spend against its own cap (separate provider, separate credit pool)
if (l.vision?.enabled && l.vision.spentUsd > 0) {
  const vc = l.vision.capUsd || 0;
  const vfrac = vc > 0 ? l.vision.spentUsd / vc : 0;
  const col = vfrac >= 1 ? C.red : vfrac > 0.6 ? C.yel : C.dim;
  parts.push(`${col}img $${l.vision.spentUsd.toFixed(3)}${vc > 0 ? `/$${vc.toFixed(2)}` : ''}${C.r}`);
}

// remaining credit — red while DeepSeek's peak surcharge is in force, which is when this
// number drains fastest. The multiplier prints alongside so the red reads as "everything costs
// 2x right now" rather than an unexplained alarm.
//
// Peak state comes from the shim, which derives it from UTC windows using the same
// peakMultiplier() that prices every request. It therefore cannot disagree with what is
// actually being charged, and stays correct on a host whose timezone is set wrong.
const bi = l.balance?.balance_infos?.[0];
if (bi) {
  const bal = parseFloat(bi.total_balance);
  const peak = l.peak?.active === true;
  const col = (l.balance.is_available === false || peak || bal <= 20) ? C.red : bal <= 30 ? C.orange : bal <= 40 ? C.yel : C.grn;
  // Keep the label subdued; the balance amount carries the actionable colour. Bold rides on
  // top of the peak red and both clear at the segment's single trailing reset.
  const tag = peak ? ` ${C.b}x${l.peak.multiplier}` : '';
  parts.push(`${C.dim}Bal:${C.r} ${col}$${bal.toFixed(2)} ${bi.currency}${tag}${C.r}`);
}

if (!l.todayUsd && !bi) parts.push(`${C.red}shim down${C.r}`);

const dir = (s.workspace?.current_dir || '').replace(os.homedir() || '~', '~');
if (dir) parts.push(`${C.dim}${dir}${C.r}`);

process.stdout.write(parts.join(`${C.dim} | ${C.r}`));
