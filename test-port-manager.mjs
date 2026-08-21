import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsv4shim-port-'));
process.env.CODEX_SHIM_PORT_REGISTRY = path.join(root, 'registry.json');
const { choosePort, configuredPort, syncLoopbackProfile } = await import('./bin/dsv4shim-port-manager.mjs');

const sibling = path.join(root, 'sibling');
const configDir = path.join(root, 'dsv4shim-config');
const dataDir = path.join(root, 'dsv4shim-data');
fs.mkdirSync(sibling, { recursive: true });
fs.writeFileSync(path.join(sibling, 'config.json'), JSON.stringify({ name: 'novacore', port: 45010 }));

const first = await choosePort({ app: 'dsv4shim-test', configDir, dataDir, configPort: 45010, scanRoots: [root] });
assert.equal(first.preferredPort, 45010);
assert.equal(first.port, 45011, 'an installed sibling config reserves the preferred port');
assert.equal(configuredPort({ envVar: 'DSV4SHIM_TEST_PORT', app: 'dsv4shim-test', dataDir, configPort: 45010 }), 45011);

const settingsPath = path.join(root, 'profile', 'settings.json');
fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
fs.writeFileSync(settingsPath, JSON.stringify({ env: {
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:45010',
  ANTHROPIC_AUTH_TOKEN: 'sentinel',
} }));
assert.equal(syncLoopbackProfile(settingsPath, first.port), true);
assert.equal(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:45011');
assert.equal(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).env.ANTHROPIC_AUTH_TOKEN, 'sentinel');

const listener = net.createServer();
await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(45011, '127.0.0.1', resolve); });
try {
  const second = await choosePort({ app: 'dsv4shim-test', configDir, dataDir, configPort: 45010, scanRoots: [root] });
  assert.equal(second.port, 45012, 'a live listener advances to the next free port');
} finally {
  await new Promise(resolve => listener.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('port manager: 2 passed, 0 failed');
