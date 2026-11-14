#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MIN_NODE = [24, 9, 0];
const SUPPORTED_CLIENTS = ['codex', 'antigravity', 'pi'];
const ARGS_PREFIX = '--disable-warning=ExperimentalWarning';

export function checkNodeVersion(version = process.versions.node) {
  const clean = String(version || '').replace(/^v/i, '').split('-')[0];
  const parts = clean.split('.').map(n => Number.parseInt(n, 10));
  if (parts.length < 2 || parts.some(Number.isNaN)) {
    throw new Error(`Unable to parse Node.js version: ${version}`);
  }
  const [maj = 0, min = 0, pat = 0] = parts;
  const [rMaj, rMin, rPat] = MIN_NODE;
  const ok = maj > rMaj || (maj === rMaj && (min > rMin || (min === rMin && pat >= rPat)));
  if (!ok) {
    throw new Error(`Node.js ${rMaj}.${rMin}.${rPat}+ is required (current: ${version}).`);
  }
  return clean;
}

function existsFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function existsDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function existsAny(p) {
  try { fs.statSync(p); return true; } catch { return false; }
}

function arraysEqual(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
}

function sameArgOrPath(a, b, platform) {
  if (a === b) return true;
  if (platform === 'win32' && typeof a === 'string' && typeof b === 'string') {
    const looksPath = /^[A-Za-z]:[\\/]/.test(a) || /^[A-Za-z]:[\\/]/.test(b);
    if (looksPath) return path.win32.normalize(a).toLowerCase() === path.win32.normalize(b).toLowerCase();
  }
  return false;
}

function sameEntry(cmd, args, entry, platform = process.platform) {
  if (!entry || typeof cmd !== 'string' || !Array.isArray(args) || args.length !== entry.args.length) {
    return false;
  }
  return sameArgOrPath(cmd, entry.command, platform) && args.every((v, i) => sameArgOrPath(v, entry.args[i], platform));
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
}

function formatStamp(date = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function atomicWriteText(target, content) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temp, content, 'utf8');
    fs.renameSync(temp, target);
  } finally {
    try { fs.rmSync(temp, { force: true }); } catch {}
  }
}

function backupFile(target, stamp) {
  if (!existsFile(target)) return null;
  const backup = `${target}.agent-messenger-${stamp}.bak`;
  fs.copyFileSync(target, backup);
  return backup;
}

function findInPath(env, names, extraCheck = null) {
  const rawPath = String(env.PATH || env.Path || '');
  const dirs = rawPath.split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (existsFile(candidate)) return candidate;
    }
    if (extraCheck) {
      const hit = extraCheck(dir);
      if (hit) return hit;
    }
  }
  return null;
}

function findCodexOnPath(env, platform) {
  const names = platform === 'win32'
    ? ['codex.exe', 'codex.cmd', 'codex.ps1', 'codex']
    : ['codex'];
  const pkgTriple = process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
  const pkgName = process.arch === 'arm64' ? 'codex-win32-arm64' : 'codex-win32-x64';
  return findInPath(env, names, dir => {
    const pkgRoot = path.join(dir, 'node_modules', '@openai', 'codex');
    const posixPkgRoot = path.join(path.dirname(dir), 'lib', 'node_modules', '@openai', 'codex');
    for (const root of [pkgRoot, posixPkgRoot]) {
      const bin = path.join(root, 'node_modules', '@openai', pkgName, 'vendor', pkgTriple, 'bin', 'codex.exe');
      if (existsFile(bin)) return bin;
      if (existsFile(path.join(root, 'package.json'))) return root;
    }
    return null;
  });
}

function findAntigravityBinary(env, home, platform, systemRoots) {
  const names = platform === 'win32'
    ? ['antigravity.exe', 'antigravity.cmd', 'antigravity']
    : ['antigravity'];
  const onPath = findInPath(env, names);
  if (onPath) return onPath;

  const candidates = [];
  if (platform === 'win32') {
    if (env.LOCALAPPDATA) {
      candidates.push(
        path.join(env.LOCALAPPDATA, 'Programs', 'antigravity'),
        path.join(env.LOCALAPPDATA, 'Programs', 'Antigravity'),
        path.join(env.LOCALAPPDATA, 'Programs', 'Antigravity IDE'),
      );
    }
  } else if (platform === 'darwin') {
    candidates.push(
      path.join(home, 'Applications', 'Antigravity.app'),
      path.join(home, 'Applications', 'Antigravity IDE.app'),
    );
    for (const root of systemRoots) {
      candidates.push(
        path.join(root, 'Antigravity.app'),
        path.join(root, 'Antigravity IDE.app'),
      );
    }
  } else {
    const xdg = env.XDG_CONFIG_HOME || path.join(home, '.config');
    candidates.push(path.join(xdg, 'Antigravity'));
    for (const root of systemRoots) {
      candidates.push(path.join(root, 'antigravity'));
    }
  }
  return candidates.find(existsAny) || null;
}

function findPiOnPath(env, platform) {
  const names = platform === 'win32'
    ? ['pi.exe', 'pi.cmd', 'pi.ps1', 'pi']
    : ['pi'];
  return findInPath(env, names, dir => {
    for (const candidate of [
      path.join(dir, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js'),
      path.join(path.dirname(dir), 'lib', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js'),
    ]) {
      if (existsFile(candidate)) return candidate;
    }
    return null;
  });
}

export function resolveRoot(fromDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')) {
  return path.resolve(fromDir);
}

export function resolveBundle(root, { autoBuild = false } = {}) {
  const candidates = [
    path.join(root, 'dist', 'agent-messenger.mjs'),
    path.join(root, 'agent-messenger.mjs'),
  ];
  for (const candidate of candidates) {
    if (existsFile(candidate)) return candidate;
  }
  const buildScript = path.join(root, 'scripts', 'build.mjs');
  const esbuildPkg = path.join(root, 'node_modules', 'esbuild');
  if (autoBuild && existsFile(buildScript) && existsDir(esbuildPkg)) {
    execFileSync(process.execPath, [buildScript], { cwd: root, stdio: 'pipe' });
    if (existsFile(candidates[0])) return candidates[0];
  }
  throw new Error('Could not locate dist/agent-messenger.mjs. Run "npm run build" or use a release bundle.');
}

export function resolvePiExtensionSource(root) {
  const candidates = [
    path.join(root, 'plugins', 'pi', 'agent-messenger.ts'),
    path.join(root, 'agent-messenger.ts'),
  ];
  return candidates.find(existsFile) || null;
}

export function detectClients({
  env = process.env,
  home = os.homedir(),
  platform = process.platform,
  systemRoots = platform === 'darwin' ? ['/Applications'] : ['/usr/share'],
} = {}) {
  const codexHome = env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(home, '.codex');
  const codexConfig = path.join(codexHome, 'config.toml');
  const codexReasons = [];
  if (existsFile(codexConfig)) codexReasons.push('config.toml exists');
  if (existsDir(codexHome)) codexReasons.push('CODEX_HOME directory exists');
  if (env.AGENT_MESSENGER_CODEX && existsAny(env.AGENT_MESSENGER_CODEX)) codexReasons.push('AGENT_MESSENGER_CODEX exists');
  const codexBin = findCodexOnPath(env, platform);
  if (codexBin) codexReasons.push(`codex CLI found (${codexBin})`);
  if (platform === 'win32' && env.LOCALAPPDATA) {
    for (const dir of [path.join(env.LOCALAPPDATA, 'Programs', 'Codex'), path.join(env.LOCALAPPDATA, 'OpenAI', 'Codex')]) {
      if (existsAny(dir)) codexReasons.push(`Codex app directory found (${dir})`);
    }
  } else if (platform === 'darwin') {
    for (const dir of [path.join(home, 'Applications', 'Codex.app'), ...systemRoots.map(r => path.join(r, 'Codex.app'))]) {
      if (existsAny(dir)) codexReasons.push(`Codex.app found (${dir})`);
    }
  }

  const geminiHome = env.GEMINI_CLI_HOME ? path.resolve(env.GEMINI_CLI_HOME) : path.join(home, '.gemini');
  const agConfig = path.join(geminiHome, 'config', 'mcp_config.json');
  const agReasons = [];
  if (existsFile(agConfig)) agReasons.push('mcp_config.json exists');
  for (const sub of ['antigravity', 'antigravity-ide', 'antigravity-cli']) {
    if (existsDir(path.join(geminiHome, sub))) agReasons.push(`${sub} profile directory exists`);
  }
  const agBin = findAntigravityBinary(env, home, platform, systemRoots);
  if (agBin) agReasons.push(`Antigravity installation found (${agBin})`);

  const piHome = env.PI_CODING_AGENT_DIR ? path.resolve(env.PI_CODING_AGENT_DIR) : path.join(home, '.pi', 'agent');
  const piConfig = path.join(piHome, 'mcp.json');
  const piExtension = path.join(piHome, 'extensions', 'agent-messenger.ts');
  const piSettings = path.join(piHome, 'settings.json');
  const piReasons = [];
  if (existsFile(piConfig)) piReasons.push('mcp.json exists');
  if (existsFile(piExtension)) piReasons.push('Pi extension exists');
  if (existsDir(piHome)) piReasons.push('PI_CODING_AGENT_DIR directory exists');
  if (env.AGENT_MESSENGER_PI && existsAny(env.AGENT_MESSENGER_PI)) piReasons.push('AGENT_MESSENGER_PI exists');
  const piBin = findPiOnPath(env, platform);
  if (piBin) piReasons.push(`pi CLI found (${piBin})`);

  return {
    codex: {
      client: 'codex',
      detected: codexReasons.length > 0,
      reasons: codexReasons,
      homeDir: codexHome,
      configPath: codexConfig,
    },
    antigravity: {
      client: 'antigravity',
      detected: agReasons.length > 0,
      reasons: agReasons,
      homeDir: geminiHome,
      configPath: agConfig,
    },
    pi: {
      client: 'pi',
      detected: piReasons.length > 0,
      reasons: piReasons,
      homeDir: piHome,
      configPath: piConfig,
      extensionPath: piExtension,
      settingsPath: piSettings,
    },
  };
}

// --- Lightweight TOML Scanner/Updater for [mcp_servers] ---

function createTomlState() {
  return { inBasicMulti: false, inLiteralMulti: false, bracketDepth: 0, braceDepth: 0 };
}

function isNeutralState(st) {
  return !st.inBasicMulti && !st.inLiteralMulti && st.bracketDepth === 0 && st.braceDepth === 0;
}

function advanceTomlState(line, st) {
  let i = 0;
  let inBasic = false;
  let inLiteral = false;
  while (i < line.length) {
    if (st.inBasicMulti) {
      if (line[i] === '\\') { i += 2; continue; }
      if (line.startsWith('"""', i)) { st.inBasicMulti = false; i += 3; continue; }
      i++;
      continue;
    }
    if (st.inLiteralMulti) {
      if (line.startsWith("'''", i)) { st.inLiteralMulti = false; i += 3; continue; }
      i++;
      continue;
    }
    if (inBasic) {
      if (line[i] === '\\') { i += 2; continue; }
      if (line[i] === '"') inBasic = false;
      i++;
      continue;
    }
    if (inLiteral) {
      if (line[i] === "'") inLiteral = false;
      i++;
      continue;
    }
    const ch = line[i];
    if (ch === '#') break;
    if (line.startsWith('"""', i)) { st.inBasicMulti = true; i += 3; continue; }
    if (line.startsWith("'''", i)) { st.inLiteralMulti = true; i += 3; continue; }
    if (ch === '"') { inBasic = true; i++; continue; }
    if (ch === "'") { inLiteral = true; i++; continue; }
    if (ch === '[') st.bracketDepth++;
    else if (ch === ']' && st.bracketDepth > 0) st.bracketDepth--;
    else if (ch === '{') st.braceDepth++;
    else if (ch === '}' && st.braceDepth > 0) st.braceDepth--;
    i++;
  }
}

function parseDottedKey(raw) {
  const parts = [];
  let i = 0;
  const s = raw.trim();
  while (i < s.length) {
    while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
    if (i >= s.length) break;
    if (s[i] === '"') {
      i++;
      let out = '';
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && i + 1 < s.length) {
          out += s[i + 1];
          i += 2;
        } else {
          out += s[i++];
        }
      }
      if (s[i] !== '"') return null;
      i++;
      parts.push(out);
    } else if (s[i] === "'") {
      i++;
      let out = '';
      while (i < s.length && s[i] !== "'") out += s[i++];
      if (s[i] !== "'") return null;
      i++;
      parts.push(out);
    } else {
      const start = i;
      while (i < s.length && /[A-Za-z0-9_-]/.test(s[i])) i++;
      if (i === start) return null;
      parts.push(s.slice(start, i));
    }
    while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
    if (i < s.length) {
      if (s[i] !== '.') return null;
      i++;
    }
  }
  return parts.length ? parts : null;
}

function parseTableHeader(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('[')) return null;
  const isArray = trimmed.startsWith('[[');
  let i = isArray ? 2 : 1;
  let inBasic = false;
  let inLiteral = false;
  while (i < trimmed.length) {
    const ch = trimmed[i];
    if (inBasic) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === '"') inBasic = false;
      i++;
      continue;
    }
    if (inLiteral) {
      if (ch === "'") inLiteral = false;
      i++;
      continue;
    }
    if (ch === '"') { inBasic = true; i++; continue; }
    if (ch === "'") { inLiteral = true; i++; continue; }
    if (isArray && trimmed.startsWith(']]', i)) {
      const rest = trimmed.slice(i + 2).trim();
      if (rest && !rest.startsWith('#')) return null;
      const parts = parseDottedKey(trimmed.slice(2, i));
      return parts ? { isArray: true, parts } : null;
    }
    if (!isArray && ch === ']') {
      const rest = trimmed.slice(i + 1).trim();
      if (rest && !rest.startsWith('#')) return null;
      const parts = parseDottedKey(trimmed.slice(1, i));
      return parts ? { isArray: false, parts } : null;
    }
    i++;
  }
  return null;
}

function splitTomlSections(text) {
  const normalized = stripBom(text).replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  // Avoid trailing empty element from final newline unless file truly ends with blank lines we track cleanly.
  if (normalized.endsWith('\n')) lines.pop();
  const sections = [{ headerLine: null, header: null, lines: [] }];
  const st = createTomlState();
  for (const line of lines) {
    if (isNeutralState(st) && line.trimStart().startsWith('[')) {
      const header = parseTableHeader(line);
      if (header) {
        sections.push({ headerLine: line, header, lines: [] });
        continue;
      }
    }
    sections[sections.length - 1].lines.push(line);
    advanceTomlState(line, st);
  }
  return sections;
}

function splitTomlStatements(sectionLines) {
  const items = [];
  const st = createTomlState();
  let current = null;
  for (const line of sectionLines) {
    if (current) {
      current.push(line);
      advanceTomlState(line, st);
      if (isNeutralState(st)) {
        items.push({ kind: 'stmt', lines: current });
        current = null;
      }
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      items.push({ kind: 'trivia', lines: [line] });
      continue;
    }
    advanceTomlState(line, st);
    if (isNeutralState(st)) {
      items.push({ kind: 'stmt', lines: [line] });
    } else {
      current = [line];
    }
  }
  if (current) items.push({ kind: 'stmt', lines: current });
  return items;
}

function parseAssignmentKey(stmtText) {
  const trimmed = stmtText.trimStart();
  let i = 0;
  const keys = [];
  for (;;) {
    while (i < trimmed.length && (trimmed[i] === ' ' || trimmed[i] === '\t')) i++;
    if (i >= trimmed.length) return null;
    if (trimmed[i] === '"') {
      i++;
      let out = '';
      while (i < trimmed.length && trimmed[i] !== '"') {
        if (trimmed[i] === '\\' && i + 1 < trimmed.length) { out += trimmed[i + 1]; i += 2; }
        else out += trimmed[i++];
      }
      if (trimmed[i] !== '"') return null;
      i++;
      keys.push(out);
    } else if (trimmed[i] === "'") {
      i++;
      let out = '';
      while (i < trimmed.length && trimmed[i] !== "'") out += trimmed[i++];
      if (trimmed[i] !== "'") return null;
      i++;
      keys.push(out);
    } else {
      const start = i;
      while (i < trimmed.length && /[A-Za-z0-9_-]/.test(trimmed[i])) i++;
      if (i === start) return null;
      keys.push(trimmed.slice(start, i));
    }
    while (i < trimmed.length && (trimmed[i] === ' ' || trimmed[i] === '\t')) i++;
    if (trimmed[i] === '.') {
      i++;
      continue;
    }
    if (trimmed[i] !== '=') return null;
    break;
  }
  return { keys, key: keys.join('.'), rawValue: trimmed.slice(i + 1).trim() };
}

function parseTomlStringAt(src, start) {
  let i = start;
  if (src.startsWith('"""', i)) {
    i += 3;
    if (src[i] === '\n') i++;
    let out = '';
    while (i < src.length) {
      if (src.startsWith('"""', i)) return { value: out, next: i + 3 };
      if (src[i] === '\\') {
        const esc = src[i + 1];
        if (esc === '\n' || esc === ' ' || esc === '\t') {
          i++;
          while (i < src.length && (src[i] === ' ' || src[i] === '\t' || src[i] === '\n')) i++;
          continue;
        }
        const map = { '"': '"', '\\': '\\', n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };
        if (esc in map) { out += map[esc]; i += 2; continue; }
        if (esc === 'u') { out += String.fromCodePoint(Number.parseInt(src.slice(i + 2, i + 6), 16)); i += 6; continue; }
        if (esc === 'U') { out += String.fromCodePoint(Number.parseInt(src.slice(i + 2, i + 10), 16)); i += 10; continue; }
      }
      out += src[i++];
    }
    return null;
  }
  if (src.startsWith("'''", i)) {
    i += 3;
    if (src[i] === '\n') i++;
    const end = src.indexOf("'''", i);
    if (end === -1) return null;
    return { value: src.slice(i, end), next: end + 3 };
  }
  if (src[i] === '"') {
    i++;
    let out = '';
    while (i < src.length && src[i] !== '"') {
      if (src[i] === '\\') {
        const esc = src[i + 1];
        const map = { '"': '"', '\\': '\\', n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };
        if (esc in map) { out += map[esc]; i += 2; continue; }
        if (esc === 'u') { out += String.fromCodePoint(Number.parseInt(src.slice(i + 2, i + 6), 16)); i += 6; continue; }
        if (esc === 'U') { out += String.fromCodePoint(Number.parseInt(src.slice(i + 2, i + 10), 16)); i += 10; continue; }
        return null;
      }
      out += src[i++];
    }
    if (src[i] !== '"') return null;
    return { value: out, next: i + 1 };
  }
  if (src[i] === "'") {
    i++;
    const end = src.indexOf("'", i);
    if (end === -1) return null;
    return { value: src.slice(i, end), next: end + 1 };
  }
  return null;
}

function skipTomlTrivia(src, i) {
  while (i < src.length) {
    if (src[i] === ' ' || src[i] === '\t' || src[i] === '\n' || src[i] === '\r') { i++; continue; }
    if (src[i] === '#') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    break;
  }
  return i;
}

function parseTomlStringValue(raw) {
  const parsed = parseTomlStringAt(raw, 0);
  if (!parsed) return null;
  const rest = raw.slice(parsed.next).trim();
  if (rest && !rest.startsWith('#')) return null;
  return parsed.value;
}

function parseTomlStringArray(raw) {
  let i = 0;
  if (raw[i] !== '[') return null;
  i++;
  const items = [];
  for (;;) {
    i = skipTomlTrivia(raw, i);
    if (i >= raw.length) return null;
    if (raw[i] === ']') {
      const rest = raw.slice(i + 1).trim();
      return (!rest || rest.startsWith('#')) ? items : null;
    }
    const parsed = parseTomlStringAt(raw, i);
    if (!parsed) return null;
    items.push(parsed.value);
    i = skipTomlTrivia(raw, parsed.next);
    if (raw[i] === ',') { i++; continue; }
    if (raw[i] === ']') continue;
    return null;
  }
}

function isServerTable(parts, name) {
  return parts && parts.length === 2 && parts[0] === 'mcp_servers' && parts[1] === name;
}

function isServerSubtable(parts, name) {
  return parts && parts.length > 2 && parts[0] === 'mcp_servers' && parts[1] === name;
}

function isMcpServersRoot(parts) {
  return parts && parts.length === 1 && parts[0] === 'mcp_servers';
}

function isServerHttpSubtable(parts, name) {
  return parts && parts.length === 3 && parts[0] === 'mcp_servers' && parts[1] === name && parts[2] === 'http_headers';
}

function classifyRootOrMcpAssign(sectionParts, assign) {
  if (!assign) return null;
  const keys = assign.keys;
  if (sectionParts === null) {
    if (keys.length >= 2 && keys[0] === 'mcp_servers') {
      if (keys[1] === 'agent-messenger') return 'target';
      if (keys[1] === 'agent-hud') return 'hud';
    }
    return null;
  }
  if (isMcpServersRoot(sectionParts)) {
    if (keys[0] === 'agent-messenger') return 'target';
    if (keys[0] === 'agent-hud') return 'hud';
  }
  return null;
}

const CODEX_HTTP_KEYS = new Set(['url', 'bearer_token_env_var', 'http_headers']);

export function updateCodexToml(rawText, entry, { uninstall = false, platform = process.platform } = {}) {
  const existed = typeof rawText === 'string';
  const sections = existed ? splitTomlSections(rawText) : [{ headerLine: null, header: null, lines: [] }];

  let existingCommand = null;
  let existingArgs = null;
  let sawTargetSection = false;
  let sawLegacyHud = false;
  let sawInlineTarget = false;
  let sawHttpField = false;
  let targetSectionCount = 0;

  for (const sec of sections) {
    const parts = sec.header?.parts || null;
    if (!sec.header?.isArray && isServerTable(parts, 'agent-messenger')) {
      targetSectionCount++;
      sawTargetSection = true;
      for (const item of splitTomlStatements(sec.lines)) {
        if (item.kind !== 'stmt') continue;
        const assign = parseAssignmentKey(item.lines.join('\n'));
        if (!assign) continue;
        if (assign.key === 'command') existingCommand = parseTomlStringValue(assign.rawValue);
        else if (assign.key === 'args') existingArgs = parseTomlStringArray(assign.rawValue);
        else if (CODEX_HTTP_KEYS.has(assign.keys[0])) sawHttpField = true;
      }
    } else if (!sec.header?.isArray && isServerHttpSubtable(parts, 'agent-messenger')) {
      sawHttpField = true;
    } else if (!sec.header?.isArray && (isServerTable(parts, 'agent-hud') || isServerSubtable(parts, 'agent-hud'))) {
      sawLegacyHud = true;
    } else if (!sec.header?.isArray && (parts === null || isMcpServersRoot(parts))) {
      for (const item of splitTomlStatements(sec.lines)) {
        if (item.kind !== 'stmt') continue;
        const kind = classifyRootOrMcpAssign(parts, parseAssignmentKey(item.lines.join('\n')));
        if (kind === 'target') sawInlineTarget = true;
        else if (kind === 'hud') sawLegacyHud = true;
      }
    }
  }

  if (uninstall) {
    if (!existed || (!sawTargetSection && !sawInlineTarget && !sawLegacyHud)) {
      return { changed: false, status: 'not-installed', text: rawText ?? '' };
    }
    const kept = [];
    for (const sec of sections) {
      const parts = sec.header?.parts || null;
      if (!sec.header?.isArray && (
        isServerTable(parts, 'agent-messenger') ||
        isServerSubtable(parts, 'agent-messenger') ||
        isServerTable(parts, 'agent-hud') ||
        isServerSubtable(parts, 'agent-hud')
      )) {
        continue;
      }
      if (!sec.header?.isArray && (parts === null || isMcpServersRoot(parts))) {
        const filteredLines = [];
        for (const item of splitTomlStatements(sec.lines)) {
          if (item.kind === 'stmt') {
            const kind = classifyRootOrMcpAssign(parts, parseAssignmentKey(item.lines.join('\n')));
            if (kind === 'target' || kind === 'hud') continue;
          }
          filteredLines.push(...item.lines);
        }
        kept.push({ ...sec, lines: filteredLines });
      } else {
        kept.push(sec);
      }
    }
    const out = serializeTomlSections(kept);
    return { changed: true, status: 'uninstalled', text: out };
  }

  if (
    existed &&
    targetSectionCount === 1 &&
    !sawInlineTarget &&
    !sawLegacyHud &&
    !sawHttpField &&
    sameEntry(existingCommand, existingArgs, entry, platform)
  ) {
    return { changed: false, status: 'up-to-date', text: stripBom(rawText).replace(/\r\n/g, '\n') };
  }

  const commandLine = `command = ${JSON.stringify(entry.command)}`;
  const argsLine = `args = ${JSON.stringify(entry.args)}`;

  const nextSections = [];
  let insertedTarget = false;

  for (const sec of sections) {
    const parts = sec.header?.parts || null;
    if (!sec.header?.isArray && (
      isServerTable(parts, 'agent-hud') ||
      isServerSubtable(parts, 'agent-hud') ||
      isServerHttpSubtable(parts, 'agent-messenger')
    )) {
      continue;
    }
    if (!sec.header?.isArray && isServerTable(parts, 'agent-messenger')) {
      if (insertedTarget) continue;
      insertedTarget = true;
      const items = splitTomlStatements(sec.lines);
      const rebuilt = [];
      let wroteCommand = false;
      let wroteArgs = false;
      for (const item of items) {
        if (item.kind === 'stmt') {
          const assign = parseAssignmentKey(item.lines.join('\n'));
          if (assign?.key === 'command') {
            if (!wroteCommand) { rebuilt.push(commandLine); wroteCommand = true; }
            continue;
          }
          if (assign?.key === 'args') {
            if (!wroteArgs) { rebuilt.push(argsLine); wroteArgs = true; }
            continue;
          }
          if (assign && CODEX_HTTP_KEYS.has(assign.keys[0])) {
            continue;
          }
        }
        rebuilt.push(...item.lines);
      }
      // Trim trailing blank lines inside section before inserting missing keys, then preserve single blank separator.
      while (rebuilt.length && !rebuilt[rebuilt.length - 1].trim()) rebuilt.pop();
      if (!wroteCommand && !wroteArgs) rebuilt.unshift(commandLine, argsLine);
      else if (!wroteCommand) rebuilt.unshift(commandLine);
      else if (!wroteArgs) {
        const cmdIdx = rebuilt.indexOf(commandLine);
        rebuilt.splice(cmdIdx + 1, 0, argsLine);
      }
      nextSections.push({ headerLine: sec.headerLine, header: sec.header, lines: rebuilt });
      continue;
    }
    if (!sec.header?.isArray && (parts === null || isMcpServersRoot(parts))) {
      const filteredLines = [];
      for (const item of splitTomlStatements(sec.lines)) {
        if (item.kind === 'stmt') {
          const kind = classifyRootOrMcpAssign(parts, parseAssignmentKey(item.lines.join('\n')));
          if (kind === 'target' || kind === 'hud') continue;
        }
        filteredLines.push(...item.lines);
      }
      nextSections.push({ ...sec, lines: filteredLines });
      continue;
    }
    nextSections.push(sec);
  }

  if (!insertedTarget) {
    nextSections.push({
      headerLine: '[mcp_servers.agent-messenger]',
      header: { isArray: false, parts: ['mcp_servers', 'agent-messenger'] },
      lines: [commandLine, argsLine],
    });
  }

  const out = serializeTomlSections(nextSections);
  verifyCodexToml(out, entry);
  const status = !existed ? 'created' : (sawTargetSection || sawInlineTarget || sawLegacyHud || sawHttpField) ? 'migrated' : 'configured';
  return { changed: true, status, text: out };
}

function serializeTomlSections(sections) {
  const blocks = [];
  for (const sec of sections) {
    const lines = [...sec.lines];
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    if (sec.headerLine === null) {
      while (lines.length && !lines[0].trim()) lines.shift();
      if (lines.length) blocks.push(lines.join('\n'));
    } else {
      blocks.push([sec.headerLine, ...lines].join('\n'));
    }
  }
  return blocks.length ? `${blocks.join('\n\n')}\n` : '';
}

function verifyCodexToml(tomlText, expectedEntry) {
  const parsed = readCodexEntry(tomlText);
  if (!parsed || parsed.command !== expectedEntry.command || !arraysEqual(parsed.args, expectedEntry.args)) {
    throw new Error('Codex TOML verification failed after rendering.');
  }
}

export function readCodexEntry(tomlText) {
  const sections = splitTomlSections(tomlText);
  for (const sec of sections) {
    if (!sec.header?.isArray && isServerTable(sec.header?.parts, 'agent-messenger')) {
      let command = null;
      let args = null;
      for (const item of splitTomlStatements(sec.lines)) {
        if (item.kind !== 'stmt') continue;
        const assign = parseAssignmentKey(item.lines.join('\n'));
        if (!assign) continue;
        if (assign.key === 'command') command = parseTomlStringValue(assign.rawValue);
        if (assign.key === 'args') args = parseTomlStringArray(assign.rawValue);
      }
      return { command, args };
    }
  }
  return null;
}

// --- JSON MCP Config Updater (Antigravity & Pi) ---

export function updateJsonMcpConfig(rawText, entry, { uninstall = false, platform = process.platform } = {}) {
  const existed = typeof rawText === 'string';
  let parsed;
  if (!existed) {
    parsed = { mcpServers: {} };
  } else {
    const clean = stripBom(rawText).trim();
    parsed = clean ? JSON.parse(clean) : { mcpServers: {} };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Existing MCP config JSON must be a JSON object.');
  }
  if (parsed.mcpServers !== undefined && (!parsed.mcpServers || typeof parsed.mcpServers !== 'object' || Array.isArray(parsed.mcpServers))) {
    throw new Error('Existing MCP config field "mcpServers" must be a JSON object.');
  }
  const servers = parsed.mcpServers || {};
  parsed.mcpServers = servers;

  const hasLegacyHud = Object.prototype.hasOwnProperty.call(servers, 'agent-hud');
  const existing = servers['agent-messenger'];

  if (uninstall) {
    if (!existed || (!existing && !hasLegacyHud)) {
      return { changed: false, status: 'not-installed', text: rawText ?? '' };
    }
    delete servers['agent-hud'];
    delete servers['agent-messenger'];
    return { changed: true, status: 'uninstalled', text: `${JSON.stringify(parsed, null, 2)}\n` };
  }

  const matches = existing &&
    typeof existing === 'object' &&
    !Array.isArray(existing) &&
    sameEntry(existing.command, existing.args, entry, platform) &&
    (existing.type === undefined || existing.type === 'stdio') &&
    existing.url === undefined &&
    existing.headers === undefined &&
    existing.oauth === undefined &&
    existing.auth === undefined;

  if (existed && matches && !hasLegacyHud) {
    return { changed: false, status: 'up-to-date', text: stripBom(rawText) };
  }

  delete servers['agent-hud'];
  const preserved = (existing && typeof existing === 'object' && !Array.isArray(existing)) ? { ...existing } : {};
  delete preserved.url;
  delete preserved.headers;
  delete preserved.oauth;
  delete preserved.auth;
  if (preserved.type !== undefined && preserved.type !== 'stdio') {
    delete preserved.type;
  }
  servers['agent-messenger'] = { ...preserved, command: entry.command, args: entry.args };

  const out = `${JSON.stringify(parsed, null, 2)}\n`;
  const verified = JSON.parse(out);
  if (
    verified?.mcpServers?.['agent-messenger']?.command !== entry.command ||
    !arraysEqual(verified?.mcpServers?.['agent-messenger']?.args, entry.args)
  ) {
    throw new Error('JSON MCP config verification failed after rendering.');
  }

  const status = !existed ? 'created' : (existing || hasLegacyHud) ? 'migrated' : 'configured';
  return { changed: true, status, text: out };
}

function piPackageCoversRoot(settingsPath, root, platform = process.platform) {
  if (!existsFile(settingsPath)) return false;
  try {
    const parsed = JSON.parse(stripBom(fs.readFileSync(settingsPath, 'utf8')));
    const packages = Array.isArray(parsed?.packages) ? parsed.packages : [];
    const piHome = path.dirname(settingsPath);
    const resolvedRoot = path.resolve(root);
    const extEntry = path.join(resolvedRoot, 'plugins', 'pi', 'agent-messenger.ts');
    for (const item of packages) {
      const src = typeof item === 'string' ? item : item?.source;
      if (typeof src !== 'string' || !src.trim()) continue;
      if (src.startsWith('.') || path.isAbsolute(src) || src.includes(path.sep) || src.includes('/')) {
        if (!/^(npm:|git:|https?:)/i.test(src)) {
          const resolved = path.resolve(piHome, src);
          if (sameArgOrPath(resolved, resolvedRoot, platform) || sameArgOrPath(resolved, extEntry, platform)) {
            return true;
          }
        }
      }
    }
  } catch {}
  return false;
}

export function syncPiExtension(sourcePath, targetPath, { dryRun = false, uninstall = false, stamp = formatStamp() } = {}) {
  if (uninstall) {
    if (!existsFile(targetPath)) return { changed: false, status: 'not-installed', path: targetPath, backup: null };
    if (dryRun) return { changed: true, status: 'would-uninstall', path: targetPath, backup: null };
    const backup = backupFile(targetPath, stamp);
    fs.rmSync(targetPath, { force: true });
    return { changed: true, status: 'uninstalled', path: targetPath, backup };
  }

  if (!sourcePath || !existsFile(sourcePath)) {
    throw new Error('Missing Pi extension source plugins/pi/agent-messenger.ts.');
  }
  const srcBuf = fs.readFileSync(sourcePath);
  if (existsFile(targetPath)) {
    const dstBuf = fs.readFileSync(targetPath);
    if (Buffer.compare(srcBuf, dstBuf) === 0) {
      return { changed: false, status: 'up-to-date', path: targetPath, backup: null };
    }
    if (dryRun) return { changed: true, status: 'would-update', path: targetPath, backup: null };
    const backup = backupFile(targetPath, stamp);
    atomicWriteText(targetPath, srcBuf.toString('utf8'));
    if (Buffer.compare(srcBuf, fs.readFileSync(targetPath)) !== 0) {
      throw new Error('Pi extension verification failed after write.');
    }
    return { changed: true, status: 'updated', path: targetPath, backup };
  }
  if (dryRun) return { changed: true, status: 'would-install', path: targetPath, backup: null };
  atomicWriteText(targetPath, srcBuf.toString('utf8'));
  if (Buffer.compare(srcBuf, fs.readFileSync(targetPath)) !== 0) {
    throw new Error('Pi extension verification failed after write.');
  }
  return { changed: true, status: 'installed', path: targetPath, backup: null };
}

function selectTargets(detected, { clients = null, all = false } = {}) {
  if (Array.isArray(clients) && clients.length) {
    const invalid = clients.filter(c => !SUPPORTED_CLIENTS.includes(c));
    if (invalid.length) {
      throw new Error(`Unsupported client(s): ${invalid.join(', ')}. Supported clients: ${SUPPORTED_CLIENTS.join(', ')}.`);
    }
    return new Set(clients);
  }
  if (all) return new Set(SUPPORTED_CLIENTS);
  return new Set(SUPPORTED_CLIENTS.filter(c => detected[c].detected));
}

export function installClients(options = {}) {
  const {
    root = resolveRoot(),
    env = process.env,
    home = os.homedir(),
    platform = process.platform,
    systemRoots,
    nodePath = process.execPath,
    nodeVersion = process.versions.node,
    bundlePath: explicitBundlePath = null,
    piExtensionSource: explicitPiSource = null,
    clients = null,
    all = false,
    dryRun = false,
    uninstall = false,
    autoBuild = !dryRun && !uninstall,
    stamp = formatStamp(),
  } = options;

  if (!uninstall) checkNodeVersion(nodeVersion);
  const bundlePath = explicitBundlePath || (uninstall ? null : resolveBundle(root, { autoBuild }));
  const piExtensionSource = explicitPiSource || (uninstall ? null : resolvePiExtensionSource(root));
  const entry = bundlePath ? { command: nodePath, args: [ARGS_PREFIX, bundlePath] } : null;

  const detected = detectClients({ env, home, platform, systemRoots });
  const selected = selectTargets(detected, { clients, all });
  const backups = [];
  const results = {};

  for (const name of SUPPORTED_CLIENTS) {
    const info = detected[name];
    if (!selected.has(name)) {
      results[name] = {
        detected: info.detected,
        reasons: info.reasons,
        config: info.configPath,
        status: 'skipped-not-detected',
      };
      continue;
    }

    if (name === 'codex') {
      const raw = existsFile(info.configPath) ? fs.readFileSync(info.configPath, 'utf8') : undefined;
      const plan = updateCodexToml(raw, entry, { uninstall, platform });
      let status = plan.status;
      let backup = null;
      if (plan.changed) {
        if (dryRun) {
          status = `would-${status === 'created' ? 'create' : status === 'migrated' ? 'migrate' : status === 'uninstalled' ? 'uninstall' : 'configure'}`;
        } else {
          backup = backupFile(info.configPath, stamp);
          if (backup) backups.push(backup);
          atomicWriteText(info.configPath, plan.text);
          if (!uninstall) {
            const actual = readCodexEntry(fs.readFileSync(info.configPath, 'utf8'));
            if (!actual || actual.command !== entry.command || !arraysEqual(actual.args, entry.args)) {
              throw new Error('Codex config round-trip verification failed.');
            }
          }
        }
      }
      results.codex = { detected: info.detected, reasons: info.reasons, config: info.configPath, status, ...(backup ? { backup } : {}) };
    } else if (name === 'antigravity') {
      const raw = existsFile(info.configPath) ? fs.readFileSync(info.configPath, 'utf8') : undefined;
      const plan = updateJsonMcpConfig(raw, entry, { uninstall, platform });
      let status = plan.status;
      let backup = null;
      if (plan.changed) {
        if (dryRun) {
          status = `would-${status === 'created' ? 'create' : status === 'migrated' ? 'migrate' : status === 'uninstalled' ? 'uninstall' : 'configure'}`;
        } else {
          backup = backupFile(info.configPath, stamp);
          if (backup) backups.push(backup);
          atomicWriteText(info.configPath, plan.text);
          if (!uninstall) {
            const actual = JSON.parse(stripBom(fs.readFileSync(info.configPath, 'utf8')));
            const actualEntry = actual?.mcpServers?.['agent-messenger'];
            if (!actualEntry || actualEntry.command !== entry.command || !arraysEqual(actualEntry.args, entry.args)) {
              throw new Error('Antigravity config round-trip verification failed.');
            }
          }
        }
      }
      results.antigravity = { detected: info.detected, reasons: info.reasons, config: info.configPath, status, ...(backup ? { backup } : {}) };
    } else if (name === 'pi') {
      const raw = existsFile(info.configPath) ? fs.readFileSync(info.configPath, 'utf8') : undefined;
      const plan = updateJsonMcpConfig(raw, entry, { uninstall, platform });
      let status = plan.status;
      let backup = null;
      if (plan.changed) {
        if (dryRun) {
          status = `would-${status === 'created' ? 'create' : status === 'migrated' ? 'migrate' : status === 'uninstalled' ? 'uninstall' : 'configure'}`;
        } else {
          backup = backupFile(info.configPath, stamp);
          if (backup) backups.push(backup);
          atomicWriteText(info.configPath, plan.text);
          if (!uninstall) {
            const actual = JSON.parse(stripBom(fs.readFileSync(info.configPath, 'utf8')));
            const actualEntry = actual?.mcpServers?.['agent-messenger'];
            if (!actualEntry || actualEntry.command !== entry.command || !arraysEqual(actualEntry.args, entry.args)) {
              throw new Error('Pi mcp.json round-trip verification failed.');
            }
          }
        }
      }

      let extRes;
      if (!uninstall && piPackageCoversRoot(info.settingsPath, root, platform) && !existsFile(info.extensionPath)) {
        extRes = { changed: false, status: 'provided-by-pi-package', path: info.extensionPath, backup: null };
      } else {
        extRes = syncPiExtension(piExtensionSource, info.extensionPath, { dryRun, uninstall, stamp });
        if (extRes.backup) backups.push(extRes.backup);
      }

      results.pi = {
        detected: info.detected,
        reasons: info.reasons,
        config: info.configPath,
        status,
        extension: extRes.status,
        extensionPath: info.extensionPath,
        ...(backup ? { backup } : {}),
        ...(extRes.backup ? { extensionBackup: extRes.backup } : {}),
      };
    }
  }

  return {
    mode: uninstall ? 'uninstall' : dryRun ? 'check' : 'install',
    node: nodePath,
    nodeVersion,
    bundle: bundlePath,
    server: entry,
    clients: results,
    backups,
  };
}

export function doctorClients(options = {}) {
  return installClients({ ...options, dryRun: true, autoBuild: false });
}

export function uninstallClients(options = {}) {
  return installClients({ ...options, uninstall: true, autoBuild: false });
}

function parseCliArgs(argv) {
  const opts = { clients: null, all: false, dryRun: false, uninstall: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check' || arg === '--doctor' || arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--uninstall') opts.uninstall = true;
    else if (arg === '--all') opts.all = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--clients' || arg === '-c') {
      const next = argv[++i];
      if (!next) throw new Error('Missing value for --clients.');
      opts.clients = next.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    } else if (arg.startsWith('--clients=')) {
      opts.clients = arg.slice('--clients='.length).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return opts;
}

export function runCli(argv = process.argv.slice(2)) {
  const opts = parseCliArgs(argv);
  if (opts.help) {
    process.stdout.write([
      'Usage: node scripts/install.mjs [options]',
      '',
      'Auto-detects installed Codex, Antigravity, and Pi environments, migrates stale',
      'paths, creates missing client configs, and syncs the Pi extension.',
      '',
      'Options:',
      '  --check, --doctor, --dry-run   Inspect environment and report changes without writing',
      '  --clients <a,b>                Target specific clients (codex,antigravity,pi)',
      '  --all                          Configure all supported clients even if undetected',
      '  --uninstall                    Remove agent-messenger entries and Pi extension',
      '  -h, --help                     Show this help',
      '',
    ].join('\n'));
    return 0;
  }
  const summary = installClients(opts);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return 0;
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) {
  try {
    process.exitCode = runCli();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
