#!/usr/bin/env node
/** Clean web-page reader used by the default defuddle skill. */
import { spawnSync } from 'node:child_process';
import { findExecutable } from './dsv4shim-integrations.mjs';

const WIN = process.platform === 'win32';
const args = process.argv.slice(2);
const url = args.find(a => /^https?:\/\//i.test(a));
if (!url) {
  console.error('Usage: dsv4shim web <https://url> [--json]');
  process.exit(2);
}

function runDefuddle(command) {
  const defuddleArgs = ['parse', url, args.includes('--json') ? '--json' : '--md'];
  if (!WIN) return spawnSync(command, defuddleArgs, { stdio: 'inherit' }).status ?? 1;
  const quote = value => /[\s"&|<>^]/.test(value) ? `"${String(value).replace(/"/g, '""')}"` : String(value);
  return spawnSync([command, ...defuddleArgs].map(quote).join(' '), [], { stdio: 'inherit', shell: true }).status ?? 1;
}

const defuddle = findExecutable('defuddle');
if (defuddle) process.exit(runDefuddle(defuddle));

try {
  const response = await fetch(`https://r.jina.ai/${url}`, { signal: AbortSignal.timeout(30000), headers: { accept: 'text/plain' } });
  if (!response.ok) throw new Error(`clean reader returned HTTP ${response.status}`);
  console.error('dsv4shim web: Defuddle is not installed; using Agent Reach/Jina clean-reader fallback. Install with: npm install -g defuddle');
  const body = await response.text();
  await new Promise(resolve => process.stdout.write(body, resolve));
  // Let Node drain stdout naturally on Windows; process.exit() here can tear down libuv while
  // the console pipe is still flushing and produces 0xC0000409 after otherwise valid output.
  process.exitCode = 0;
} catch (error) {
  console.error(`dsv4shim web: ${error.message}`);
  process.exit(1);
}
