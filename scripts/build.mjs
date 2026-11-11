import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outfile = path.join(root, 'dist', 'agent-messenger.mjs');
await build({ entryPoints: [path.join(root, 'src', 'server.mjs')], outfile, bundle: true, platform: 'node', target: 'node24', format: 'esm', minify: true,
  legalComments: 'eof', banner: { js: '/* Agent Messenger 0.1.0. See LICENSE, NOTICE and THIRD_PARTY_LICENSES.txt. */' } });
const licenses = ['@modelcontextprotocol/server', '@modelcontextprotocol/core', 'zod', 'fzstd'].map(name => {
  const folder = path.join(root, 'node_modules', name);
  const entry = fs.readdirSync(folder).find(n => /^licen[cs]e(?:\.txt|\.md)?$/i.test(n));
  if (!entry) throw new Error(`Missing license for ${name}`);
  return `${name}\n${'='.repeat(50)}\n${fs.readFileSync(path.join(folder, entry), 'utf8')}`;
});
fs.writeFileSync(path.join(root, 'dist', 'THIRD_PARTY_LICENSES.txt'), licenses.join('\n\n'));
console.log(`Built ${outfile} (${fs.statSync(outfile).size} bytes)`);
