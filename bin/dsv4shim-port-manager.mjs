import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';

// Port 8788 is only a preference. A shared registry plus installed config discovery
// keeps dsv4shim, mmclaude, NovaCore, and future local siblings from colliding.
const HOME = os.homedir();
const WIN = process.platform === 'win32';
const REGISTRY = process.env.CODEX_SHIM_PORT_REGISTRY ||
  path.join(HOME, '.config', 'codex-port-reservations.json');
const CONFIG_NAMES = new Set(['config.json', 'port.json', 'server.json', 'settings.json']);
const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.update-cache', 'backups', 'vision-cache', 'logs',
  'projects', 'transcripts', 'sessions', 'skills', 'agents', '__pycache__',
]);

const validPort = (value) => {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(n) && n >= 1024 && n <= 65535 ? n : 0;
};
const clean = (value) => { try { return path.resolve(value); } catch { return ''; } };
function samePath(a, b) {
  const aa = clean(a), bb = clean(b);
  return WIN ? aa.toLowerCase() === bb.toLowerCase() : aa === bb;
}
function inside(file, dir) {
  const f = clean(file), d = clean(dir);
  if (!f || !d) return false;
  const rel = path.relative(d, f);
  return rel === '' || (rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}
function jsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}
function readActivePort(dataDir, app) {
  const state = jsonFile(path.join(dataDir, 'active-port.json'));
  return state && (!state.app || state.app === app) ? validPort(state.port) : 0;
}
function nestedPort(value) {
  for (const key of ['port', 'listenPort']) { const p = validPort(value?.[key]); if (p) return p; }
  for (const key of ['server', 'listen', 'gateway', 'http']) { const p = validPort(value?.[key]?.port); if (p) return p; }
  return 0;
}
function registryReservations(app) {
  const data = jsonFile(REGISTRY), out = [];
  if (!data || typeof data !== 'object') return out;
  for (const [owner, value] of Object.entries(data)) {
    if (owner === app) continue;
    const port = typeof value === 'object' ? nestedPort(value) : validPort(value);
    if (port) out.push({ port, owner, source: 'registry' });
  }
  return out;
}
function scanDir(root, depth, ownPaths, out, seen) {
  if (!root || depth < 0) return;
  const resolved = clean(root);
  if (!resolved || seen.has(resolved)) return;
  seen.add(resolved);
  let entries; try { entries = fs.readdirSync(resolved, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = path.join(resolved, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name.toLowerCase())) scanDir(full, depth - 1, ownPaths, out, seen);
      continue;
    }
    if (!entry.isFile() || !CONFIG_NAMES.has(entry.name.toLowerCase())) continue;
    if (ownPaths.some((p) => inside(full, p) || samePath(full, p))) continue;
    let stat; try { stat = fs.statSync(full); } catch { continue; }
    if (stat.size > 1024 * 1024) continue;
    const data = jsonFile(full), port = nestedPort(data);
    if (port) out.push({ port, owner: data?.app || data?.name || path.basename(path.dirname(full)), source: full });
  }
}
function discoveredReservations({ app, configDir, dataDir, scanRoots = [] }) {
  const out = [], ownPaths = [configDir, dataDir];
  const roots = [path.join(HOME, '.config'), path.join(HOME, '.local', 'share'),
    path.join(HOME, 'Documents', 'Codex'), ...scanRoots];
  const seen = new Set();
  for (const root of roots) scanDir(root, 7, ownPaths, out, seen);
  return out.filter((item) => item.owner !== app);
}
function isFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const probe = net.createServer();
    const done = (free) => { try { probe.close(); } catch {} resolve(free); };
    probe.once('error', () => done(false));
    probe.listen({ port, host }, () => done(true));
  });
}
function writeState({ app, configDir, dataDir, preferredPort, port }) {
  const state = { app, port, preferredPort, updatedAt: new Date().toISOString() };
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'active-port.json'), JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  } catch {}
  try {
    fs.mkdirSync(path.dirname(REGISTRY), { recursive: true });
    const data = jsonFile(REGISTRY) || {};
    data[app] = { ...state, configDir, dataDir };
    fs.writeFileSync(REGISTRY, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  } catch {}
}
export async function choosePort({ app, envVar, configDir, dataDir, configPort, defaultPort = 8788,
  bind = '127.0.0.1', scanRoots = [] }) {
  const preferredPort = validPort(process.env[envVar]) || validPort(configPort) || validPort(defaultPort);
  const active = readActivePort(dataDir, app);
  const candidates = [...new Set([validPort(process.env[envVar]), active, preferredPort].filter(Boolean))];
  const reserved = [...registryReservations(app), ...discoveredReservations({ app, configDir, dataDir, scanRoots })];
  const reservedPorts = new Set(reserved.map((item) => item.port));
  const start = candidates[0] || 8788;
  for (const seed of candidates) {
    for (let port = seed; port <= 65535; port++) {
      if (reservedPorts.has(port)) continue;
      if (await isFree(port, bind)) {
        writeState({ app, configDir, dataDir, preferredPort, port });
        return { port, preferredPort, shifted: port !== preferredPort, reserved };
      }
    }
  }
  for (let port = start; port <= 65535; port++) {
    if (!reservedPorts.has(port) && await isFree(port, bind)) {
      writeState({ app, configDir, dataDir, preferredPort, port });
      return { port, preferredPort, shifted: port !== preferredPort, reserved };
    }
  }
  throw new Error(`no free local port found after ${start}`);
}
export function configuredPort({ envVar, dataDir, configPort, defaultPort = 8788, app }) {
  return validPort(process.env[envVar]) || readActivePort(dataDir, app) || validPort(configPort) || defaultPort;
}
export async function healthAt(port, endpoint, timeoutMs = 1200) {
  try { const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, { signal: AbortSignal.timeout(timeoutMs) }); return response.ok; }
  catch { return false; }
}
export function syncLoopbackProfile(settingsPath, port) {
  const data = jsonFile(settingsPath), url = data?.env?.ANTHROPIC_BASE_URL;
  if (!data || typeof url !== 'string' || !/^https?:\/\/(?:127\.0\.0\.1|localhost):\d+$/i.test(url)) return false;
  data.env.ANTHROPIC_BASE_URL = url.replace(/:\d+$/, `:${port}`);
  try { fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2) + '\n'); return true; } catch { return false; }
}
export function reservationPath() { return REGISTRY; }
