#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runCli as runInstallCli, resolveRoot } from './install.mjs';

function runWithCleanNode(target, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', target, ...args], {
      stdio: 'inherit',
    });
    const forward = sig => {
      try { child.kill(sig); } catch {}
    };
    process.on('SIGINT', forward);
    process.on('SIGTERM', forward);
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      process.off('SIGINT', forward);
      process.off('SIGTERM', forward);
      if (signal) process.kill(process.pid, signal);
      else resolve(code ?? 0);
    });
  });
}

function printHelp() {
  process.stdout.write([
    'Usage: agent-messenger <command> [options]',
    '',
    'Commands:',
    '  setup, install     Auto-detect clients (Codex, Antigravity, Pi), configure MCP, migrate paths, sync Pi extension',
    '  doctor, status     Check detected clients and configuration health without modifying files',
    '  uninstall          Remove agent-messenger configuration entries and Pi extension',
    '  dashboard          Start the local web dashboard (http://127.0.0.1:3721/)',
    '  serve              Start the MCP stdio server (default when no command is given)',
    '',
    'Setup options:',
    '  --check, --dry-run   Preview changes without writing',
    '  --clients <a,b>      Target specific clients (codex,antigravity,pi)',
    '  --all                Configure all supported clients even if undetected',
    '',
  ].join('\n'));
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === 'serve') {
    const root = resolveRoot(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
    const bundle = path.join(root, 'dist', 'agent-messenger.mjs');
    const server = path.join(root, 'src', 'server.mjs');
    const target = fs.existsSync(bundle) ? bundle : server;
    if (process.execArgv.includes('--disable-warning=ExperimentalWarning')) {
      await import(pathToFileURL(target).href);
      return 0;
    }
    return await runWithCleanNode(target, args.slice(cmd === 'serve' ? 1 : 0));
  }

  if (cmd === 'setup' || cmd === 'install') {
    return runInstallCli(args.slice(1));
  }

  if (cmd === 'doctor' || cmd === 'status') {
    return runInstallCli(['--check', ...args.slice(1)]);
  }

  if (cmd === 'uninstall') {
    return runInstallCli(['--uninstall', ...args.slice(1)]);
  }

  if (cmd === 'dashboard') {
    const root = resolveRoot(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
    return await runWithCleanNode(path.join(root, 'scripts', 'dashboard.mjs'), args.slice(1));
  }

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    printHelp();
    return 0;
  }

  if (cmd === '--version' || cmd === '-v') {
    const root = resolveRoot(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    process.stdout.write(`${pkg.version}\n`);
    return 0;
  }

  if (cmd.startsWith('-')) {
    return runInstallCli(args);
  }

  process.stderr.write(`Unknown command: ${cmd}\n`);
  printHelp();
  return 1;
}

main().then(code => {
  if (typeof code === 'number' && code !== 0) process.exitCode = code;
}).catch(err => {
  process.stderr.write(`${err.message}\n`);
  process.exitCode = 1;
});
