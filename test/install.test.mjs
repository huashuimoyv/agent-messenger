import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  checkNodeVersion,
  detectClients,
  installClients,
  doctorClients,
  uninstallClients,
  updateCodexToml,
  updateJsonMcpConfig,
  readCodexEntry,
} from '../scripts/install.mjs';
import piExtension from '../plugins/pi/agent-messenger.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function makeSandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-install-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const fakeBin = path.join(root, 'bin');
  const bundle = path.join(REPO_ROOT, 'dist', 'agent-messenger.mjs');
  const piSource = path.join(REPO_ROOT, 'plugins', 'pi', 'agent-messenger.ts');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(fakeBin, { recursive: true });
  const env = { PATH: fakeBin };
  return { root, home, fakeBin, bundle, piSource, env };
}

test('checkNodeVersion enforces >= 24.9.0', () => {
  assert.equal(checkNodeVersion('24.9.0'), '24.9.0');
  assert.equal(checkNodeVersion('v24.10.2-nightly'), '24.10.2');
  assert.equal(checkNodeVersion('25.0.0'), '25.0.0');
  assert.throws(() => checkNodeVersion('24.8.9'), /24\.9\.0\+ is required/);
  assert.throws(() => checkNodeVersion('22.14.0'), /24\.9\.0\+ is required/);
  assert.throws(() => checkNodeVersion('not-a-version'), /Unable to parse/);
});

test('detectClients finds only installed supported clients and ignores Claude/DeepSeek', t => {
  const sb = makeSandbox(t);

  // Create unsupported client dirs to verify strict scoping
  fs.mkdirSync(path.join(sb.home, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(sb.home, '.dsh'), { recursive: true });

  let detected = detectClients({ env: sb.env, home: sb.home, platform: 'win32', systemRoots: [] });
  assert.deepEqual(Object.keys(detected).sort(), ['antigravity', 'codex', 'pi']);
  assert.equal(detected.codex.detected, false);
  assert.equal(detected.antigravity.detected, false);
  assert.equal(detected.pi.detected, false);

  // Simulate Codex CLI on PATH + Antigravity profile + Pi dir
  fs.writeFileSync(path.join(sb.fakeBin, 'codex.cmd'), '@echo off\n', 'utf8');
  fs.mkdirSync(path.join(sb.home, '.gemini', 'antigravity'), { recursive: true });
  fs.mkdirSync(path.join(sb.home, '.pi', 'agent'), { recursive: true });

  detected = detectClients({ env: sb.env, home: sb.home, platform: 'win32', systemRoots: [] });
  assert.equal(detected.codex.detected, true);
  assert.equal(detected.antigravity.detected, true);
  assert.equal(detected.pi.detected, true);
  assert.ok(detected.codex.reasons.some(r => r.includes('codex CLI found')));
});

test('installClients creates missing configs from scratch for detected clients and skips undetected ones', t => {
  const sb = makeSandbox(t);
  // Only Pi is present on this device
  fs.mkdirSync(path.join(sb.home, '.pi', 'agent'), { recursive: true });

  const res = installClients({
    root: REPO_ROOT,
    env: sb.env,
    home: sb.home,
    platform: 'win32',
    systemRoots: [],
    nodePath: 'C:\\Node24\\node.exe',
    nodeVersion: '24.9.0',
    bundlePath: sb.bundle,
    piExtensionSource: sb.piSource,
  });

  assert.equal(res.clients.codex.status, 'skipped-not-detected');
  assert.equal(res.clients.antigravity.status, 'skipped-not-detected');
  assert.equal(fs.existsSync(path.join(sb.home, '.codex', 'config.toml')), false);
  assert.equal(fs.existsSync(path.join(sb.home, '.gemini', 'config', 'mcp_config.json')), false);

  assert.equal(res.clients.pi.status, 'created');
  assert.equal(res.clients.pi.extension, 'installed');
  const piMcp = JSON.parse(fs.readFileSync(path.join(sb.home, '.pi', 'agent', 'mcp.json'), 'utf8'));
  assert.deepEqual(piMcp.mcpServers['agent-messenger'], {
    command: 'C:\\Node24\\node.exe',
    args: ['--disable-warning=ExperimentalWarning', sb.bundle],
  });
  assert.equal(
    fs.readFileSync(path.join(sb.home, '.pi', 'agent', 'extensions', 'agent-messenger.ts'), 'utf8'),
    fs.readFileSync(sb.piSource, 'utf8'),
  );
});

test('installClients creates missing Codex and Antigravity configs when client dirs/binaries exist', t => {
  const sb = makeSandbox(t);
  fs.mkdirSync(path.join(sb.home, '.codex'), { recursive: true });
  const localAppData = path.join(sb.root, 'localappdata');
  fs.mkdirSync(path.join(localAppData, 'Programs', 'antigravity'), { recursive: true });

  const res = installClients({
    root: REPO_ROOT,
    env: { ...sb.env, LOCALAPPDATA: localAppData },
    home: sb.home,
    platform: 'win32',
    systemRoots: [],
    nodePath: 'C:\\Node24\\node.exe',
    nodeVersion: '24.9.0',
    bundlePath: sb.bundle,
    piExtensionSource: sb.piSource,
  });

  assert.equal(res.clients.codex.status, 'created');
  assert.equal(res.clients.antigravity.status, 'created');
  assert.equal(res.clients.pi.status, 'skipped-not-detected');

  const codexEntry = readCodexEntry(fs.readFileSync(path.join(sb.home, '.codex', 'config.toml'), 'utf8'));
  assert.deepEqual(codexEntry, {
    command: 'C:\\Node24\\node.exe',
    args: ['--disable-warning=ExperimentalWarning', sb.bundle],
  });
  const agJson = JSON.parse(fs.readFileSync(path.join(sb.home, '.gemini', 'config', 'mcp_config.json'), 'utf8'));
  assert.deepEqual(agJson.mcpServers['agent-messenger'], {
    command: 'C:\\Node24\\node.exe',
    args: ['--disable-warning=ExperimentalWarning', sb.bundle],
  });
});

test('updateCodexToml migrates old device paths, BOM, CRLF, multiline args, removes agent-hud, and preserves extra settings', () => {
  const oldToml = '\uFEFF' + [
    'model = "gpt-5.3-codex"',
    '',
    '[mcp_servers.other]',
    'command = "uvx"',
    'args = ["other-mcp"]',
    '',
    '[mcp_servers.agent-hud]',
    'command = "old-hud"',
    'args = ["hud"]',
    '',
    '[mcp_servers.agent-hud.env]',
    'OLD = "1"',
    '',
    '[mcp_servers."agent-messenger"]',
    'command = \'D:\\OldDevice\\node.exe\'',
    'args = [',
    '  "--disable-warning=ExperimentalWarning",',
    '  "D:\\\\OldRepo\\\\dist\\\\agent-messenger.mjs" # trailing comment',
    ']',
    'startup_timeout_sec = 45',
    'enabled = true',
    '',
    '[mcp_servers.agent-messenger.env]',
    'AGENT_MESSENGER_HOME = "E:\\\\CustomData"',
  ].join('\r\n');

  const entry = {
    command: 'E:\\Program Files\\Node js\\node.EXE',
    args: ['--disable-warning=ExperimentalWarning', 'E:\\Ameath\\agent-messenger\\dist\\agent-messenger.mjs'],
  };

  const migrated = updateCodexToml(oldToml, entry);
  assert.equal(migrated.changed, true);
  assert.equal(migrated.status, 'migrated');
  assert.doesNotMatch(migrated.text, /agent-hud/);
  assert.match(migrated.text, /model = "gpt-5\.3-codex"/);
  assert.match(migrated.text, /\[mcp_servers\.other\]/);
  assert.match(migrated.text, /startup_timeout_sec = 45/);
  assert.match(migrated.text, /enabled = true/);
  assert.match(migrated.text, /\[mcp_servers\.agent-messenger\.env\]/);
  assert.match(migrated.text, /AGENT_MESSENGER_HOME = "E:\\\\CustomData"/);
  assert.deepEqual(readCodexEntry(migrated.text), entry);

  // Second run must be a no-op (up-to-date)
  const second = updateCodexToml(migrated.text, entry);
  assert.equal(second.changed, false);
  assert.equal(second.status, 'up-to-date');
});

test('updateCodexToml migrates inline key under [mcp_servers] cleanly', () => {
  const inlineToml = [
    '[mcp_servers]',
    'other = { command = "npx", args = ["-y", "foo"] }',
    'agent-messenger = { command = "/old/node", args = ["/old/bundle.mjs"] }',
  ].join('\n');

  const entry = { command: '/usr/local/bin/node', args: ['--disable-warning=ExperimentalWarning', '/opt/am/dist/agent-messenger.mjs'] };
  const res = updateCodexToml(inlineToml, entry);
  assert.equal(res.changed, true);
  assert.equal(res.status, 'migrated');
  assert.match(res.text, /other = \{ command = "npx"/);
  assert.doesNotMatch(res.text, /agent-messenger = \{/);
  assert.deepEqual(readCodexEntry(res.text), entry);
});

test('updateJsonMcpConfig migrates stale entry with BOM, removes agent-hud, preserves extra properties', () => {
  const oldJson = '\uFEFF' + JSON.stringify({
    mcpServers: {
      obsidian: { command: 'obsidian-mcp', args: [] },
      'agent-hud': { command: 'old-hud', args: [] },
      'agent-messenger': {
        command: '/old/node',
        args: ['/old/bundle.mjs'],
        url: 'http://stale.example/mcp',
        exposure: 'direct',
        timeout: 30,
        env: { CUSTOM: 'yes' },
      },
    },
  }, null, 2);

  const entry = { command: '/new/node', args: ['--disable-warning=ExperimentalWarning', '/new/bundle.mjs'] };
  const res = updateJsonMcpConfig(oldJson, entry);
  assert.equal(res.changed, true);
  assert.equal(res.status, 'migrated');

  const parsed = JSON.parse(res.text);
  assert.equal(parsed.mcpServers['agent-hud'], undefined);
  assert.deepEqual(parsed.mcpServers.obsidian, { command: 'obsidian-mcp', args: [] });
  assert.deepEqual(parsed.mcpServers['agent-messenger'], {
    command: '/new/node',
    args: ['--disable-warning=ExperimentalWarning', '/new/bundle.mjs'],
    exposure: 'direct',
    timeout: 30,
    env: { CUSTOM: 'yes' },
  });

  // Idempotent on second pass
  const again = updateJsonMcpConfig(res.text, entry);
  assert.equal(again.changed, false);
  assert.equal(again.status, 'up-to-date');
});

test('installClients migrates all 3 clients with backups, stays idempotent, supports doctor & uninstall', t => {
  const sb = makeSandbox(t);
  const codexDir = path.join(sb.home, '.codex');
  const agDir = path.join(sb.home, '.gemini', 'config');
  const piDir = path.join(sb.home, '.pi', 'agent');
  const piExtDir = path.join(piDir, 'extensions');
  fs.mkdirSync(codexDir, { recursive: true });
  fs.mkdirSync(agDir, { recursive: true });
  fs.mkdirSync(piExtDir, { recursive: true });

  fs.writeFileSync(path.join(codexDir, 'config.toml'), '[mcp_servers.agent-messenger]\ncommand = "old-node"\nargs = ["old"]\n', 'utf8');
  fs.writeFileSync(path.join(agDir, 'mcp_config.json'), JSON.stringify({ mcpServers: { 'agent-messenger': { command: 'old-node', args: ['old'] } } }), 'utf8');
  fs.writeFileSync(path.join(piDir, 'mcp.json'), JSON.stringify({ mcpServers: { 'agent-messenger': { command: 'old-node', args: ['old'] } } }), 'utf8');
  fs.writeFileSync(path.join(piExtDir, 'agent-messenger.ts'), '// outdated pi extension\n', 'utf8');

  const baseOpts = {
    root: REPO_ROOT,
    env: sb.env,
    home: sb.home,
    platform: 'win32',
    systemRoots: [],
    nodePath: 'C:\\Node24\\node.exe',
    nodeVersion: '24.9.0',
    bundlePath: sb.bundle,
    piExtensionSource: sb.piSource,
    stamp: '20261114-120000',
  };

  // Doctor (dry-run) must not touch files
  const docBefore = doctorClients(baseOpts);
  assert.equal(docBefore.clients.codex.status, 'would-migrate');
  assert.equal(docBefore.clients.antigravity.status, 'would-migrate');
  assert.equal(docBefore.clients.pi.status, 'would-migrate');
  assert.equal(docBefore.clients.pi.extension, 'would-update');
  assert.equal(docBefore.backups.length, 0);
  assert.match(fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf8'), /old-node/);

  // Install migrates all 3 + creates backups
  const installed = installClients(baseOpts);
  assert.equal(installed.clients.codex.status, 'migrated');
  assert.equal(installed.clients.antigravity.status, 'migrated');
  assert.equal(installed.clients.pi.status, 'migrated');
  assert.equal(installed.clients.pi.extension, 'updated');
  assert.equal(installed.backups.length, 4);
  for (const bak of installed.backups) {
    assert.ok(fs.existsSync(bak), `Backup missing: ${bak}`);
    assert.ok(bak.endsWith('.bak'), `Backup must end in .bak so Pi does not load it: ${bak}`);
  }

  // Second install must be up-to-date with 0 backups
  const second = installClients({ ...baseOpts, stamp: '20261114-120001' });
  assert.equal(second.clients.codex.status, 'up-to-date');
  assert.equal(second.clients.antigravity.status, 'up-to-date');
  assert.equal(second.clients.pi.status, 'up-to-date');
  assert.equal(second.clients.pi.extension, 'up-to-date');
  assert.equal(second.backups.length, 0);

  // Uninstall removes entries + Pi extension cleanly
  const removed = uninstallClients({ ...baseOpts, stamp: '20261114-120002' });
  assert.equal(removed.clients.codex.status, 'uninstalled');
  assert.equal(removed.clients.antigravity.status, 'uninstalled');
  assert.equal(removed.clients.pi.status, 'uninstalled');
  assert.equal(removed.clients.pi.extension, 'uninstalled');
  assert.equal(readCodexEntry(fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf8')), null);
  assert.equal(fs.existsSync(path.join(piExtDir, 'agent-messenger.ts')), false);
});

test('installClients fails cleanly on invalid JSON without clobbering file and supports --clients override', t => {
  const sb = makeSandbox(t);
  const agDir = path.join(sb.home, '.gemini', 'config');
  fs.mkdirSync(agDir, { recursive: true });
  const badJson = '{ invalid json';
  fs.writeFileSync(path.join(agDir, 'mcp_config.json'), badJson, 'utf8');

  assert.throws(() => installClients({
    root: REPO_ROOT,
    env: sb.env,
    home: sb.home,
    platform: 'win32',
    systemRoots: [],
    bundlePath: sb.bundle,
    piExtensionSource: sb.piSource,
  }), /JSON/i);
  assert.equal(fs.readFileSync(path.join(agDir, 'mcp_config.json'), 'utf8'), badJson);

  // Force explicit --clients codex even when ~/.codex does not exist yet
  const explicit = installClients({
    root: REPO_ROOT,
    env: sb.env,
    home: sb.home,
    platform: 'win32',
    systemRoots: [],
    clients: ['codex'],
    bundlePath: sb.bundle,
    piExtensionSource: sb.piSource,
  });
  assert.equal(explicit.clients.codex.status, 'created');
  assert.equal(explicit.clients.antigravity.status, 'skipped-not-detected');
});

test('Pi extension auto-registers MCP server via registerMcpServer when mcp.json has no agent-messenger entry', t => {
  const sb = makeSandbox(t);
  const piDir = path.join(sb.home, '.pi', 'agent');
  fs.mkdirSync(piDir, { recursive: true });

  const prevPiDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = piDir;
  t.after(() => {
    if (prevPiDir !== undefined) process.env.PI_CODING_AGENT_DIR = prevPiDir;
    else delete process.env.PI_CODING_AGENT_DIR;
  });

  const registered = [];
  const mockPi = {
    on: () => {},
    sendUserMessage: () => {},
    registerMcpServer: (name, cfg) => registered.push({ name, cfg }),
  };

  piExtension(mockPi);
  assert.equal(registered.length, 1);
  assert.equal(registered[0].name, 'agent-messenger');
  assert.equal(registered[0].cfg.command, process.execPath);
  assert.deepEqual(registered[0].cfg.args, ['--disable-warning=ExperimentalWarning', sb.bundle]);

  // If mcp.json already configures agent-messenger, extension must defer to mcp.json
  fs.writeFileSync(path.join(piDir, 'mcp.json'), JSON.stringify({ mcpServers: { 'agent-messenger': { command: 'node', args: [] } } }), 'utf8');
  const registeredSecond = [];
  piExtension({
    on: () => {},
    sendUserMessage: () => {},
    registerMcpServer: (name, cfg) => registeredSecond.push({ name, cfg }),
  });
  assert.equal(registeredSecond.length, 0);
});

test('CLI scripts/cli.mjs doctor & setup work end-to-end against isolated HOME', t => {
  const sb = makeSandbox(t);
  const codexDir = path.join(sb.root, 'codex-home');
  const geminiDir = path.join(sb.root, 'gemini-home');
  const piDir = path.join(sb.root, 'pi-home');
  fs.mkdirSync(codexDir, { recursive: true });
  fs.mkdirSync(path.join(geminiDir, 'antigravity'), { recursive: true });
  fs.mkdirSync(piDir, { recursive: true });

  const cliEnv = {
    ...process.env,
    HOME: sb.home,
    USERPROFILE: sb.home,
    LOCALAPPDATA: path.join(sb.root, 'local'),
    CODEX_HOME: codexDir,
    GEMINI_CLI_HOME: geminiDir,
    PI_CODING_AGENT_DIR: piDir,
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${sb.fakeBin}`,
  };

  const doctorOut = JSON.parse(execFileSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'cli.mjs'), 'doctor'], {
    env: cliEnv,
    encoding: 'utf8',
  }));
  assert.equal(doctorOut.mode, 'check');
  assert.equal(doctorOut.clients.codex.status, 'would-create');
  assert.equal(doctorOut.clients.antigravity.status, 'would-create');
  assert.equal(doctorOut.clients.pi.status, 'would-create');
  assert.equal(doctorOut.clients.pi.extension, 'would-install');

  const setupOut = JSON.parse(execFileSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'cli.mjs'), 'setup'], {
    env: cliEnv,
    encoding: 'utf8',
  }));
  assert.equal(setupOut.mode, 'install');
  assert.equal(setupOut.clients.codex.status, 'created');
  assert.equal(setupOut.clients.antigravity.status, 'created');
  assert.equal(setupOut.clients.pi.status, 'created');
  assert.equal(setupOut.clients.pi.extension, 'installed');

  // Verify scripts/install.py wrapper also works cleanly and reports up-to-date
  let pythonExe = null;
  for (const cmd of ['python', 'python3']) {
    try {
      const resolved = execFileSync(cmd, ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim();
      if (resolved) {
        pythonExe = resolved;
        break;
      }
    } catch {}
  }
  if (pythonExe) {
    const pyOut = JSON.parse(execFileSync(pythonExe, [path.join(REPO_ROOT, 'scripts', 'install.py')], {
      env: cliEnv,
      encoding: 'utf8',
    }));
    assert.equal(pyOut.clients.codex.status, 'up-to-date');
    assert.equal(pyOut.clients.antigravity.status, 'up-to-date');
    assert.equal(pyOut.clients.pi.status, 'up-to-date');
    assert.equal(pyOut.clients.pi.extension, 'up-to-date');
  }
});

test('Windows case-only path differences (.EXE vs .exe) are treated as up-to-date without spurious backups', () => {
  const entry = {
    command: 'E:\\Program Files\\Node js\\node.exe',
    args: ['--disable-warning=ExperimentalWarning', 'E:\\Ameath\\agent-messenger\\dist\\agent-messenger.mjs'],
  };
  const existingToml = '[mcp_servers.agent-messenger]\ncommand = "E:\\\\Program Files\\\\Node js\\\\node.EXE"\nargs = ["--disable-warning=ExperimentalWarning", "e:\\\\Ameath\\\\agent-messenger\\\\dist\\\\agent-messenger.mjs"]\n';
  const tomlRes = updateCodexToml(existingToml, entry, { platform: 'win32' });
  assert.equal(tomlRes.changed, false);
  assert.equal(tomlRes.status, 'up-to-date');

  const existingJson = JSON.stringify({
    mcpServers: {
      'agent-messenger': {
        command: 'E:\\Program Files\\Node js\\node.EXE',
        args: ['--disable-warning=ExperimentalWarning', 'e:\\Ameath\\agent-messenger\\dist\\agent-messenger.mjs'],
      },
    },
  });
  const jsonRes = updateJsonMcpConfig(existingJson, entry, { platform: 'win32' });
  assert.equal(jsonRes.changed, false);
  assert.equal(jsonRes.status, 'up-to-date');

  // POSIX remains case-sensitive
  const posixRes = updateJsonMcpConfig(existingJson, entry, { platform: 'linux' });
  assert.equal(posixRes.changed, true);
  assert.equal(posixRes.status, 'migrated');
});

test('updateCodexToml migrates dotted keys and HTTP transport fields into valid stdio TOML', () => {
  const entry = { command: '/usr/bin/node', args: ['--disable-warning=ExperimentalWarning', '/opt/am/dist/agent-messenger.mjs'] };

  const dottedUnderMcp = [
    '[mcp_servers]',
    'other.command = "uvx"',
    'agent-messenger.command = "/old/node"',
    'agent-messenger.args = ["/old/bundle.mjs"]',
    'agent-hud.command = "/old/hud"',
  ].join('\n');
  const r1 = updateCodexToml(dottedUnderMcp, entry);
  assert.equal(r1.changed, true);
  assert.equal(r1.status, 'migrated');
  assert.match(r1.text, /other\.command = "uvx"/);
  assert.doesNotMatch(r1.text, /agent-messenger\.command/);
  assert.doesNotMatch(r1.text, /agent-hud/);
  assert.deepEqual(readCodexEntry(r1.text), entry);

  const topLevelDotted = [
    'mcp_servers.agent-messenger.command = "/old/node"',
    'mcp_servers.agent-messenger.args = ["/old/bundle.mjs"]',
    'mcp_servers.agent-hud.url = "http://old.hud"',
  ].join('\n');
  const r2 = updateCodexToml(topLevelDotted, entry);
  assert.equal(r2.changed, true);
  assert.equal(r2.status, 'migrated');
  assert.doesNotMatch(r2.text, /mcp_servers\.agent-messenger\.command/);
  assert.doesNotMatch(r2.text, /agent-hud/);
  assert.deepEqual(readCodexEntry(r2.text), entry);

  const httpTable = [
    '[mcp_servers.agent-messenger]',
    'command = "/usr/bin/node"',
    'args = ["--disable-warning=ExperimentalWarning", "/opt/am/dist/agent-messenger.mjs"]',
    'url = "http://stale.example/mcp"',
    'bearer_token_env_var = "STALE_TOKEN"',
    '',
    '[mcp_servers.agent-messenger.http_headers]',
    'X-Test = "1"',
    '',
    '[mcp_servers.agent-messenger.env]',
    'KEEP = "yes"',
  ].join('\n');
  const r3 = updateCodexToml(httpTable, entry);
  assert.equal(r3.changed, true);
  assert.equal(r3.status, 'migrated');
  assert.doesNotMatch(r3.text, /url =/);
  assert.doesNotMatch(r3.text, /bearer_token_env_var/);
  assert.doesNotMatch(r3.text, /http_headers/);
  assert.match(r3.text, /\[mcp_servers\.agent-messenger\.env\]/);
  assert.match(r3.text, /KEEP = "yes"/);
  assert.deepEqual(readCodexEntry(r3.text), entry);
  assert.equal(updateCodexToml(r3.text, entry).status, 'up-to-date');

  // Validate generated TOML with Python tomllib when available
  for (const cmd of ['python', 'python3']) {
    try {
      execFileSync(cmd, ['-c', 'import sys, tomllib; [tomllib.loads(x) for x in sys.argv[1:]]', r1.text, r2.text, r3.text], { stdio: 'pipe' });
      break;
    } catch (err) {
      if (err?.code === 'ENOENT') continue;
      throw err;
    }
  }
});

test('updateJsonMcpConfig strips stale HTTP fields (type/url/headers/oauth/auth) on migration', () => {
  const entry = { command: '/usr/bin/node', args: ['--disable-warning=ExperimentalWarning', '/opt/am/dist/agent-messenger.mjs'] };
  const httpJson = JSON.stringify({
    mcpServers: {
      'agent-messenger': {
        type: 'http',
        command: '/usr/bin/node',
        args: ['--disable-warning=ExperimentalWarning', '/opt/am/dist/agent-messenger.mjs'],
        url: 'https://stale.example/mcp',
        headers: { Authorization: 'Bearer x' },
        oauth: { clientId: 'abc' },
        auth: { provider: 'openai' },
        exposure: 'direct',
      },
    },
  });
  const res = updateJsonMcpConfig(httpJson, entry);
  assert.equal(res.changed, true);
  assert.equal(res.status, 'migrated');
  const parsed = JSON.parse(res.text);
  assert.deepEqual(parsed.mcpServers['agent-messenger'], {
    exposure: 'direct',
    command: '/usr/bin/node',
    args: ['--disable-warning=ExperimentalWarning', '/opt/am/dist/agent-messenger.mjs'],
  });
});

test('Pi package coverage matches Windows case-insensitively and extension avoids agent_messenger clash & duplicate listeners', t => {
  const sb = makeSandbox(t);
  const piDir = path.join(sb.home, '.pi', 'agent');
  fs.mkdirSync(piDir, { recursive: true });
  fs.writeFileSync(path.join(piDir, 'settings.json'), JSON.stringify({ packages: [REPO_ROOT.toLowerCase()] }), 'utf8');

  const res = installClients({
    root: REPO_ROOT,
    env: sb.env,
    home: sb.home,
    platform: 'win32',
    systemRoots: [],
    bundlePath: sb.bundle,
    piExtensionSource: sb.piSource,
  });
  assert.equal(res.clients.pi.extension, 'provided-by-pi-package');

  // agent_messenger in mcp.json shares namespace with agent-messenger so registerMcpServer must skip
  const prevPiDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = piDir;
  t.after(() => {
    if (prevPiDir !== undefined) process.env.PI_CODING_AGENT_DIR = prevPiDir;
    else delete process.env.PI_CODING_AGENT_DIR;
  });
  fs.writeFileSync(path.join(piDir, 'mcp.json'), JSON.stringify({ mcpServers: { agent_messenger: { command: 'node', args: [] } } }), 'utf8');
  const registered = [];
  const listeners = new Map();
  const sharedEvents = {
    emit(ch, data) { for (const fn of listeners.get(ch) || []) fn(data); },
    on(ch, fn) {
      const list = listeners.get(ch) || [];
      list.push(fn);
      listeners.set(ch, list);
      return () => {};
    },
  };
  const registeredEventsA = [];
  const registeredEventsB = [];
  piExtension({
    on: ev => registeredEventsA.push(ev),
    sendUserMessage: () => {},
    registerMcpServer: (name, cfg) => registered.push({ name, cfg }),
    events: sharedEvents,
  });
  piExtension({
    on: ev => registeredEventsB.push(ev),
    sendUserMessage: () => {},
    registerMcpServer: (name, cfg) => registered.push({ name, cfg }),
    events: sharedEvents,
  });
  assert.equal(registered.length, 0);
  assert.ok(registeredEventsA.includes('session_start'));
  assert.deepEqual(registeredEventsB, []);
});

test('CLI scripts/cli.mjs supports --version and serve stdio MCP initialize', () => {
  const ver = execFileSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'cli.mjs'), '--version'], { encoding: 'utf8' }).trim();
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.equal(ver, pkg.version);
});
