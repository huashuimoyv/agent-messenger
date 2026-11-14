import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { buildRuntime, readPackageVersion } from './build.mjs';

export function runtimeEntries(root) {
  const distRoot = path.join(root, 'dist');
  return [
    { source: path.join(distRoot, 'agent-messenger.mjs'), name: 'agent-messenger.mjs' },
    { source: path.join(distRoot, 'README.txt'), name: 'README.txt' },
    { source: path.join(distRoot, 'THIRD_PARTY_LICENSES.txt'), name: 'THIRD_PARTY_LICENSES.txt' },
    { source: path.join(root, 'LICENSE'), name: 'LICENSE' },
    { source: path.join(root, 'NOTICE'), name: 'NOTICE' },
    { source: path.join(root, 'ui', 'index.html'), name: 'ui/index.html' },
    { source: path.join(root, 'scripts', 'install.mjs'), name: 'scripts/install.mjs' },
    { source: path.join(root, 'plugins', 'pi', 'agent-messenger.ts'), name: 'plugins/pi/agent-messenger.ts' },
  ];
}

function toDosDateTime(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date(1980, 0, 1);
  const year = Math.min(2107, Math.max(1980, d.getFullYear()));
  const dosTime = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() >> 1) & 0x1f);
  const dosDate = (((year - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { dosTime, dosDate };
}

export function createZip(entries, outputPath) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const stat = fs.statSync(entry.source);
    if (!stat.isFile()) throw new Error(`Missing runtime input: ${entry.source}`);
    const data = fs.readFileSync(entry.source);
    const crc = zlib.crc32(data) >>> 0;
    const deflated = data.length > 0 ? zlib.deflateRawSync(data, { level: 9 }) : data;
    const useDeflate = data.length > 0 && deflated.length < data.length;
    const method = useDeflate ? 8 : 0;
    const payload = useDeflate ? deflated : data;
    const entryName = entry.name.replace(/\\/g, '/');
    const nameBuf = Buffer.from(entryName, 'utf8');
    const { dosTime, dosDate } = toDosDateTime(stat.mtime);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(payload.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(payload.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    localParts.push(localHeader, nameBuf, payload);
    centralParts.push(centralHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + payload.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const tmpPath = `${outputPath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmpPath, Buffer.concat([...localParts, centralDir, eocd]));
    fs.renameSync(tmpPath, outputPath);
  } catch (error) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw error;
  }
  return fs.statSync(outputPath).size;
}

export function verifyDistVersionConsistency(root, version) {
  const readmePath = path.join(root, 'dist', 'README.txt');
  const bundlePath = path.join(root, 'dist', 'agent-messenger.mjs');
  const readmeFirstLine = fs.readFileSync(readmePath, 'utf8').split(/\r?\n/, 1)[0];
  if (readmeFirstLine !== `Agent Messenger ${version}`) {
    throw new Error(`dist/README.txt header "${readmeFirstLine}" does not match package.json version "${version}"`);
  }
  const bundleHead = fs.readFileSync(bundlePath, 'utf8').slice(0, 256);
  if (!bundleHead.startsWith(`/* Agent Messenger ${version}.`)) {
    throw new Error(`dist/agent-messenger.mjs banner does not match package.json version "${version}"`);
  }
}

export async function packageRuntime({
  root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  outputPath = path.join(root, 'dist', 'agent-messenger-runtime.zip'),
  skipBuild = false,
} = {}) {
  const version = readPackageVersion(root);
  if (!skipBuild) {
    await buildRuntime({ root });
  }
  const entries = runtimeEntries(root);
  for (const entry of entries) {
    if (!fs.existsSync(entry.source) || !fs.statSync(entry.source).isFile()) {
      throw new Error(`Missing runtime input: ${entry.source}`);
    }
  }
  verifyDistVersionConsistency(root, version);
  const bytes = createZip(entries, outputPath);
  return { version, outputPath, bytes, entries: entries.map(e => e.name) };
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
  const skipBuild = process.argv.includes('--skip-build');
  const { version, outputPath, bytes, entries } = await packageRuntime({ skipBuild });
  console.log(`Packaged ${outputPath} v${version} (${bytes} bytes, ${entries.length} entries)`);
}
