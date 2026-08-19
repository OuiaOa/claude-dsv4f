import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const PACKAGE = '@anthropic-ai/claude-code';
export function privateClaudeRoot(dataDir) { return path.join(dataDir, 'claude-code'); }
export function privateClaudeCandidates(dataDir, platform = process.platform) {
  const bin = path.join(privateClaudeRoot(dataDir), 'node_modules', '.bin');
  return platform === 'win32' ? [path.join(bin, 'claude.cmd'), path.join(bin, 'claude.exe')] : [path.join(bin, 'claude')];
}
export function findPrivateClaude(dataDir, platform = process.platform, fsSync = fs) {
  for (const candidate of privateClaudeCandidates(dataDir, platform)) {
    try { if (fsSync.existsSync(candidate)) return candidate; } catch {}
  }
  return '';
}
export function installPrivateClaude({ dataDir, platform = process.platform, npm = platform === 'win32' ? 'npm.cmd' : 'npm', exec = spawnSync } = {}) {
  const root = privateClaudeRoot(dataDir);
  fs.mkdirSync(root, { recursive: true });
  const result = exec(npm, ['install', '--prefix', root, '--no-package-lock', '--no-fund', '--no-audit', `${PACKAGE}@latest`], { stdio: 'inherit', windowsHide: true });
  if (result?.status !== 0) throw new Error(`could not install the private Claude Code runner (npm exit ${result?.status ?? 'unknown'})`);
  const found = findPrivateClaude(dataDir, platform);
  if (!found) throw new Error(`Claude Code installed but its launcher was not found under ${root}`);
  try { fs.writeFileSync(path.join(root, 'install.json'), JSON.stringify({ package: PACKAGE, installedAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 }); } catch {}
  return found;
}
