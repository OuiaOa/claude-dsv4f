import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { spawn } from 'node:child_process';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

async function usageServer(payload) {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

async function render({ script, portEnv, payload, stdin, needle }) {
  const { server, port } = await usageServer(payload);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-statusline-'));
  const child = spawn(process.execPath, [path.join(ROOT, script)], {
    cwd: ROOT,
    env: { ...process.env, [portEnv]: String(port),
      MMCLAUDE_CONFIG_DIR: temp, MMCLAUDE_DATA_DIR: temp,
      DSV4SHIM_CONFIG_DIR: temp, DSV4SHIM_DATA_DIR: temp },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  child.stdin.end(JSON.stringify(stdin));
  const result = await new Promise((resolve) => child.on('close', (code) => resolve({ code })));
  server.close();
  fs.rmSync(temp, { recursive: true, force: true });
  assert.equal(result.code, 0, Buffer.concat(stderr).toString());
  const output = Buffer.concat(stdout).toString();
  assert.ok(output.includes(needle), `expected statusline output to contain ${JSON.stringify(needle)}; got ${JSON.stringify(output)}`);
  return output;
}

const dsPayload = (balance, peak = false) => ({
  balance: { is_available: true, balance_infos: [{ total_balance: balance.toFixed(2), currency: 'USD' }] },
  peak: { active: peak, multiplier: 2 },
});
const dsInput = { effort: { level: 'high' } };
const yellow = '\x1b[33m';
const orange = '\x1b[38;5;208m';
const red = '\x1b[31m';
const bold = '\x1b[1m';

await render({ script: 'bin/dsv4shim-statusline.mjs', portEnv: 'DSV4SHIM_PORT',
  payload: dsPayload(40), stdin: dsInput, needle: `${yellow}bal 40.00 USD` });
await render({ script: 'bin/dsv4shim-statusline.mjs', portEnv: 'DSV4SHIM_PORT',
  payload: dsPayload(30), stdin: dsInput, needle: `${orange}bal 30.00 USD` });
await render({ script: 'bin/dsv4shim-statusline.mjs', portEnv: 'DSV4SHIM_PORT',
  payload: dsPayload(20), stdin: dsInput, needle: `${red}bal 20.00 USD` });
await render({ script: 'bin/dsv4shim-statusline.mjs', portEnv: 'DSV4SHIM_PORT',
  payload: dsPayload(100, true), stdin: dsInput, needle: `${red}bal 100.00 USD ${bold}x2` });

console.log('statusline threshold tests: 4 passed');
