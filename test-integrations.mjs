#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { capabilityContext, capabilityReport, syncAutoMcpConfig } from './bin/dsv4shim-integrations.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsv4shim-integrations-'));
try {
  const profile = path.join(dir, 'profile');
  const capabilities = {
    defuddle: null, agentReach: null,
    codebaseMemory: process.platform === 'win32' ? 'C:\\tools\\codebase-memory-mcp.exe' : '/tools/codebase-memory-mcp',
    composio: null, github: null, youtube: null, ffmpeg: null, tmux: null, omc: null,
  };
  const first = syncAutoMcpConfig(profile, { capabilities });
  if (!first.enabled || !fs.existsSync(first.configPath)) throw new Error('MCP config was not created');
  const config = JSON.parse(fs.readFileSync(first.configPath, 'utf8'));
  if (config.mcpServers['codebase-memory-mcp'].command !== capabilities.codebaseMemory) throw new Error('MCP command mismatch');
  const second = syncAutoMcpConfig(profile, { capabilities });
  if (second.changed) throw new Error('MCP config is not idempotent');
  const context = capabilityContext({ cwd: dir, profileDir: profile, capabilities });
  if (!context.includes('Defuddle') || !context.includes('codebase-memory-mcp') || !context.includes('superpowers')) throw new Error('routing context incomplete');
  if (!capabilityReport({ capabilities }).includes('ready  Codebase memory MCP')) throw new Error('capability report incomplete');
  console.log('dsv4shim integrations: 5 checks passed');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
