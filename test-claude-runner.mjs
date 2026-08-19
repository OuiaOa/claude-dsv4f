import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findPrivateClaude, installPrivateClaude } from './bin/dsv4shim-claude.mjs';
import { resolveClaude } from './bin/dsv4shim-lib.mjs';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsv4shim-claude-'));
const runner = installPrivateClaude({ dataDir, platform: 'linux', npm: 'npm-test', exec: (_cmd, args) => {
  const root = args[args.indexOf('--prefix') + 1];
  const bin = path.join(root, 'node_modules', '.bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\n');
  return { status: 0 };
} });
assert.equal(runner, findPrivateClaude(dataDir, 'linux'));
assert.equal(resolveClaude({ platform: 'linux', dataDir }), runner, 'private runner wins over PATH');
fs.rmSync(dataDir, { recursive: true, force: true });
console.log('claude runner: 2 passed, 0 failed');
