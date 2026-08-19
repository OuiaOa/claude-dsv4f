#!/usr/bin/env node
/**
 * Provider-neutral capability discovery for the isolated DeepSeek profile.
 * It discovers optional tools without installing or authenticating them during a normal launch.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const WIN = process.platform === 'win32';

export function findExecutable(names, { env = process.env } = {}) {
  for (const name of (Array.isArray(names) ? names : [names])) {
    try {
      const checker = WIN ? 'where.exe' : 'which';
      const result = spawnSync(checker, [name], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 1500 });
      if (result.status === 0) {
        const found = String(result.stdout || '').split(/\r?\n/).map(s => s.trim()).find(Boolean);
        if (found) return found;
      }
    } catch { /* optional lookup */ }
  }
  if (WIN) {
    for (const name of (Array.isArray(names) ? names : [names])) {
      for (const ext of ['.cmd', '.exe', '.bat']) {
        try {
          const result = spawnSync('where.exe', [`${name}${ext}`], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 1500 });
          if (result.status === 0) {
            const found = String(result.stdout || '').split(/\r?\n/).map(s => s.trim()).find(Boolean);
            if (found) return found;
          }
        } catch { /* optional lookup */ }
      }
    }
  }
  return null;
}

export function discoverCapabilities({ env = process.env } = {}) {
  const command = names => findExecutable(names, { env });
  return {
    defuddle: command(['defuddle']),
    agentReach: command(['agent-reach']),
    codebaseMemory: command(['codebase-memory-mcp']),
    composio: command(['composio']),
    github: command(['gh']),
    youtube: command(['yt-dlp']),
    ffmpeg: command(['ffmpeg']),
    tmux: command(['tmux']),
    omc: command(['omc']),
  };
}

export function syncAutoMcpConfig(profileDir, { capabilities = discoverCapabilities() } = {}) {
  const configPath = path.join(profileDir, 'mcp.auto.json');
  if (!capabilities.codebaseMemory) return { configPath: null, enabled: false, changed: false };
  const config = { mcpServers: { 'codebase-memory-mcp': { command: capabilities.codebaseMemory, args: [] } } };
  const serialized = JSON.stringify(config, null, 2) + '\n';
  let changed = true;
  try { changed = fs.readFileSync(configPath, 'utf8') !== serialized; } catch { /* new file */ }
  if (changed) {
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(configPath, serialized, { mode: 0o600 });
    try { fs.chmodSync(configPath, 0o600); } catch { /* Windows */ }
  }
  return { configPath, enabled: true, changed };
}

export function capabilityContext({ cwd = process.cwd(), profileDir, capabilities = discoverCapabilities() } = {}) {
  const lines = [
    `Capability routing active for ${cwd}.`,
    'For any normal http(s) webpage, use `dsv4shim web <url>` first: it uses Defuddle when installed and a clean-reader fallback otherwise; do not send ads/navigation into the context.',
    capabilities.agentReach
      ? 'Agent Reach is available: use it for platform-specific web research (GitHub, YouTube, Reddit, X, RSS and other supported sources), then cite the source URLs.'
      : 'Agent Reach skill is available. If platform-specific research is needed, check `agent-reach doctor` and offer its safe install flow; do not invent a result when a channel is unavailable.',
    capabilities.codebaseMemory
      ? 'codebase-memory-mcp is available through the shim-owned MCP config: use its structural tools for architecture, symbol, impact and call-chain questions before broad file dumping.'
      : 'codebase-memory skill is available. If its MCP server is not installed, use focused rg/file inspection and tell the user the structural index is optional.',
    'For code changes, follow the bundled superpowers workflow: clarify non-trivial intent, make a small plan, use focused TDD where practical, debug from evidence, and verify before claiming completion. Keep Claude Code\'s native loops and goals intact.',
    'Use the bundled caveman discipline: be concise, preserve exact code/error output, avoid repeating context, and do not omit evidence needed to verify a change.',
    'Parallel work is allowed only for independent tasks. Respect the pay-as-you-go queue: prefer one main lane plus at most one background/helper lane, keep helper prompts short, and do not fan out speculative agents.',
    'Marketing, video, Composio, Mission Control, and Nova skills are available on matching requests; do not activate them for unrelated coding work or claim external actions without checking the relevant tool/authentication first.',
  ];
  if (profileDir) {
    const mcp = syncAutoMcpConfig(profileDir, { capabilities });
    if (mcp.enabled) lines.push('The codebase-memory MCP config was refreshed for this isolated profile.');
  }
  return lines.join(' ');
}

export function capabilityReport({ capabilities = discoverCapabilities() } = {}) {
  const rows = [
    ['Defuddle web extraction', capabilities.defuddle, 'dsv4shim web <url>'],
    ['Agent Reach internet routing', capabilities.agentReach, 'agent-reach doctor'],
    ['Codebase memory MCP', capabilities.codebaseMemory, 'codebase-memory-mcp'],
    ['Composio external tools', capabilities.composio, 'composio'],
    ['GitHub CLI', capabilities.github, 'gh'],
    ['YouTube/media inspection', capabilities.youtube, 'yt-dlp'],
    ['Video processing', capabilities.ffmpeg, 'ffmpeg'],
    ['Process teams', capabilities.tmux || capabilities.omc, capabilities.omc ? 'omc' : 'tmux'],
  ];
  return rows.map(([label, found, command]) => `${found ? 'ready' : 'skill only'}  ${label}${found ? ` (${command})` : ''}`).join('\n');
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  const profileDir = process.env.DSV4SHIM_PROFILE_DIR || process.env.CLAUDE_CONFIG_DIR;
  if (profileDir) syncAutoMcpConfig(profileDir);
  console.log(capabilityReport());
}
