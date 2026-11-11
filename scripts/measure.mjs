import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { McpClient } from './mcp-client.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const client = new McpClient();
const sample = () => JSON.parse(execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
  `$p=Get-Process -Id ${client.child.pid}; [pscustomobject]@{workingSet=$p.WorkingSet64;privateBytes=$p.PrivateMemorySize64;cpuSeconds=$p.TotalProcessorTime.TotalSeconds} | ConvertTo-Json -Compress`], { encoding: 'utf8', windowsHide: true }));
try {
  const started = performance.now(); await client.initialize();
  const initializeMs = performance.now() - started, before = sample();
  await new Promise(resolve => setTimeout(resolve, 3000));
  const after = sample();
  for (const source of ['codex', 'antigravity']) await client.call('list_sessions', { client: source, limit: 5 });
  const used = sample();
  const report = { node: process.version, bundleBytes: fs.statSync(path.join(root, 'dist', 'agent-messenger.mjs')).size,
    initializeMs: Math.round(initializeMs), initialized: before, idleAfterThreeSeconds: after,
    idleCpuSeconds: after.cpuSeconds - before.cpuSeconds, afterDiscovery: used,
    note: 'Single Windows sample of the MCP process only. Client applications and temporary discovery/app-server helpers are excluded.' };
  fs.mkdirSync(path.join(root, 'verification'), { recursive: true });
  fs.writeFileSync(path.join(root, 'verification', 'resources.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally { await client.close(); }
