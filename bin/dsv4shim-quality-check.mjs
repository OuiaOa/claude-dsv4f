#!/usr/bin/env node
/**
 * Bounded, local-only PostToolUse quality gate. It never calls an LLM, installs packages,
 * changes files, or blocks Claude's loop. The hook is intentionally conservative: it runs a
 * repository's existing high-signal check/test command when one is discoverable and otherwise
 * reports that no automatic command was available.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const raw = await new Promise(resolve => {
  let s = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', c => { s += c; });
  process.stdin.on('end', () => resolve(s));
});
let input = {};
try { input = JSON.parse(raw || '{}'); } catch { process.exit(0); }
const cwd = path.resolve(input.cwd || process.cwd());
const filePath = String(input.tool_input?.file_path || input.tool_input?.path || '');
if (!filePath) process.exit(0);
const relFile = filePath ? path.relative(cwd, filePath) : '';
const ext = path.extname(filePath).toLowerCase();
const interesting = new Set([
  '.c', '.cc', '.cpp', '.cs', '.go', '.h', '.hpp', '.java', '.js', '.jsx', '.json', '.mjs',
  '.py', '.rb', '.rs', '.scss', '.sh', '.sql', '.svelte', '.swift', '.ts', '.tsx', '.vue', '.xml'
]);
if (relFile.startsWith('..') || /(^|[\\/])(?:\.git|node_modules|\.env(?:\.|$)|.*(?:secret|token|credential))/i.test(relFile) || (filePath && !interesting.has(ext))) process.exit(0);

const lockDir = path.join(os.tmpdir(), 'dsv4shim-quality');
fs.mkdirSync(lockDir, { recursive: true });
const key = crypto.createHash('sha256').update(cwd).digest('hex').slice(0, 24);
const lockPath = path.join(lockDir, `${key}.lock`);
try {
  const stat = fs.statSync(lockPath);
  if (Date.now() - stat.mtimeMs < 10 * 60_000) {
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: `dsv4shim quality gate already running for ${cwd}; its result will be reported on a later turn.` } }));
    process.exit(0);
  }
  fs.rmSync(lockPath, { force: true });
} catch { /* no active gate */ }
try { fs.writeFileSync(lockPath, `${process.pid}\n`, { flag: 'wx' }); } catch { process.exit(0); }
const release = () => { try { fs.rmSync(lockPath, { force: true }); } catch { /* no-op */ } };
process.on('exit', release);

const run = (command, args, timeout = 90_000) => {
  const r = spawnSync(command, args, { cwd, encoding: 'utf8', timeout, maxBuffer: 160_000, windowsHide: true });
  return { ...r, output: `${r.stdout || ''}${r.stderr || ''}`.trim() };
};
const packageJson = path.join(cwd, 'package.json');
let checks = [];
try {
  const pkg = JSON.parse(fs.readFileSync(packageJson, 'utf8'));
  const scripts = pkg.scripts || {};
  const manager = fs.existsSync(path.join(cwd, 'pnpm-lock.yaml')) ? ['pnpm.cmd', 'pnpm']
    : fs.existsSync(path.join(cwd, 'yarn.lock')) ? ['yarn.cmd', 'yarn'] : ['npm.cmd', 'npm'];
  const pm = process.platform === 'win32' ? manager[0] : manager[1];
  if (scripts.check) checks.push([pm, ['run', 'check']]);
  else if (scripts.typecheck) checks.push([pm, ['run', 'typecheck']]);
  if (scripts.lint) checks.push([pm, ['run', 'lint']]);
  if (!checks.length && scripts.test) checks.push([pm, ['test', '--', '--runInBand']]);
} catch { /* not a Node project */ }
if (!checks.length && fs.existsSync(path.join(cwd, 'pyproject.toml'))) checks.push([process.platform === 'win32' ? 'python.exe' : 'python3', ['-m', 'pytest', '-q']]);
if (!checks.length && fs.existsSync(path.join(cwd, 'go.mod'))) checks.push(['go', ['test', './...']]);
if (!checks.length && fs.existsSync(path.join(cwd, 'Cargo.toml'))) checks.push(['cargo', ['check']]);
if (!checks.length && fs.existsSync(path.join(cwd, '.git'))) checks.push([process.platform === 'win32' ? 'git.exe' : 'git', ['diff', '--check']]);

if (!checks.length) {
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: `dsv4shim quality gate: no existing local check command discovered after ${relFile || 'the change'}; load dsv4shim-code-quality for the appropriate focused check.` } }));
  process.exit(0);
}
const results = [];
let failed = false;
for (const [command, args] of checks.slice(0, 2)) {
  const r = run(command, args);
  const label = [command, ...args].join(' ');
  if (r.error && r.error.code === 'ETIMEDOUT') { failed = true; results.push(`${label}: timed out`); break; }
  if (r.status !== 0) { failed = true; results.push(`${label}: failed\n${r.output.slice(-4_000)}`); break; }
  results.push(`${label}: passed`);
}
const status = failed ? 'FAIL' : 'PASS';
const msg = `dsv4shim quality gate: ${status} after ${relFile || 'the change'}\n${results.join('\n')}${failed ? '\nLoad dsv4shim-code-quality and inspect the failure before continuing.' : ''}`;
console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: msg } }));
