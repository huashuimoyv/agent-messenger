import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function readPackageVersion() {
  try {
    const pkgPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (typeof pkg.version === 'string' && pkg.version.trim()) return pkg.version.trim();
  } catch {}
  return '0.0.0';
}

export const APP_VERSION = process.env.AGENT_MESSENGER_VERSION || readPackageVersion();
