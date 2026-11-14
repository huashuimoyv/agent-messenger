import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

export function readPackageVersion(root) {
  const pkgPath = path.join(root, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const version = typeof pkg.version === 'string' ? pkg.version.trim() : '';
  if (!version || /[\r\n]|\*\//.test(version)) {
    throw new Error(`Missing or invalid version in ${pkgPath}`);
  }
  return version;
}

export function syncDistReadme(root, version) {
  const readmePath = path.join(root, 'dist', 'README.txt');
  fs.mkdirSync(path.dirname(readmePath), { recursive: true });
  if (!fs.existsSync(readmePath)) {
    const fallback = [
      `Agent Messenger ${version}`,
      '',
      '无头本机互发 MCP，仅含四个工具：',
      'list_sessions / send_message / get_message / start_session',
      '',
      '运行需要本机已有 Node.js 24.9+。将 agent-messenger.mjs、LICENSE、NOTICE、',
      'THIRD_PARTY_LICENSES.txt、ui、scripts/install.mjs 和 plugins/pi/agent-messenger.ts',
      '保存在一起。运行时不需要 npm 或 node_modules。',
      '',
      '一键自动检测并接入本机已安装的 Codex / Antigravity / Pi：',
      'node scripts/install.mjs',
      '',
    ].join('\n');
    fs.writeFileSync(readmePath, fallback, 'utf8');
    return readmePath;
  }
  const current = fs.readFileSync(readmePath, 'utf8');
  const eol = current.includes('\r\n') ? '\r\n' : '\n';
  const next = /^Agent Messenger [^\r\n]*/.test(current)
    ? current.replace(/^Agent Messenger [^\r\n]*/, () => `Agent Messenger ${version}`)
    : `Agent Messenger ${version}${eol}${eol}${current}`;
  if (next !== current) {
    fs.writeFileSync(readmePath, next, 'utf8');
  }
  return readmePath;
}

export async function buildRuntime({ root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') } = {}) {
  const version = readPackageVersion(root);
  const distDir = path.join(root, 'dist');
  fs.mkdirSync(distDir, { recursive: true });

  const outfile = path.join(distDir, 'agent-messenger.mjs');
  await build({
    entryPoints: [path.join(root, 'src', 'server.mjs')],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    minify: true,
    legalComments: 'eof',
    define: {
      'process.env.AGENT_MESSENGER_VERSION': JSON.stringify(version),
    },
    banner: {
      js: `/* Agent Messenger ${version}. See LICENSE, NOTICE and THIRD_PARTY_LICENSES.txt. */`,
    },
  });

  const licenses = ['@modelcontextprotocol/server', '@modelcontextprotocol/core', 'zod', 'fzstd'].map(name => {
    const folder = path.join(root, 'node_modules', name);
    const entry = fs.readdirSync(folder).find(n => /^licen[cs]e(?:\.txt|\.md)?$/i.test(n));
    if (!entry) throw new Error(`Missing license for ${name}`);
    return `${name}\n${'='.repeat(50)}\n${fs.readFileSync(path.join(folder, entry), 'utf8')}`;
  });
  fs.writeFileSync(path.join(distDir, 'THIRD_PARTY_LICENSES.txt'), licenses.join('\n\n'));
  syncDistReadme(root, version);

  const bytes = fs.statSync(outfile).size;
  return { version, outfile, bytes };
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
  const { version, outfile, bytes } = await buildRuntime();
  console.log(`Built ${outfile} v${version} (${bytes} bytes)`);
}
