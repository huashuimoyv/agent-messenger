import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildRuntime, readPackageVersion, syncDistReadme } from '../scripts/build.mjs';
import { createZip, packageRuntime, verifyDistVersionConsistency } from '../scripts/package.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function extractAndVerifyZip(zipPath, destDir) {
  for (const py of ['python', 'python3']) {
    try {
      const out = execFileSync(py, [
        '-c',
        'import sys, zipfile; z = zipfile.ZipFile(sys.argv[1]); bad = z.testzip(); assert bad is None, f"CRC mismatch: {bad}"; z.extractall(sys.argv[2]); print("\\n".join(z.namelist()))',
        zipPath,
        destDir,
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return out.trim().split(/\r?\n/).filter(Boolean);
    } catch (err) {
      if (err?.code === 'ENOENT' || err?.status === 9009) continue;
      throw err;
    }
  }
  if (process.platform === 'win32') {
    const out = execFileSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      `Add-Type -AssemblyName System.IO.Compression.FileSystem; $z = [IO.Compression.ZipFile]::OpenRead($args[0]); try { $z.Entries | ForEach-Object { $_.FullName } } finally { $z.Dispose() }; [IO.Compression.ZipFile]::ExtractToDirectory($args[0], $args[1])`,
      zipPath,
      destDir,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return out.trim().split(/\r?\n/).filter(Boolean);
  }
  execFileSync('unzip', ['-t', zipPath], { stdio: 'pipe' });
  execFileSync('unzip', ['-q', zipPath, '-d', destDir], { stdio: 'pipe' });
  return [];
}

function initializeMcpBundle(bundlePath, dataDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', bundlePath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, AGENT_MESSENGER_HOME: dataDir, AGENT_MESSENGER_DASHBOARD: '0' },
    });
    let out = '';
    let err = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch {}
      reject(new Error(`Timed out waiting for MCP initialize. stderr=${err}`));
    }, 8000);
    child.on('error', e => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on('exit', code => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`Bundle exited early with code ${code}: ${err}`));
      }
    });
    child.stderr.on('data', chunk => { err += chunk.toString(); });
    child.stdout.on('data', chunk => {
      out += chunk.toString();
      let nl;
      while ((nl = out.indexOf('\n')) !== -1) {
        const line = out.slice(0, nl).trim();
        out = out.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.id === 1) {
          settled = true;
          clearTimeout(timer);
          const done = () => resolve({ result: msg.result, stderr: err });
          if (child.exitCode !== null || child.signalCode !== null) {
            done();
            return;
          }
          child.once('exit', done);
          child.stdin.end();
          setTimeout(() => { try { child.kill(); } catch {} }, 200).unref();
          return;
        }
      }
    });
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'pkg-test', version: '1.0.0' } },
    }) + '\n');
  });
}

test('readPackageVersion validates package.json version', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-ver-'));
  t.after(() => {
    try { fs.rmSync(path.join(dir, 'node_modules'), { recursive: true, force: true }); } catch {}
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: ' 1.2.3 ' }), 'utf8');
  assert.equal(readPackageVersion(dir), '1.2.3');

  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '   ' }), 'utf8');
  assert.throws(() => readPackageVersion(dir), /Missing or invalid version/);

  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '1.0.0*/alert(1)' }), 'utf8');
  assert.throws(() => readPackageVersion(dir), /Missing or invalid version/);

  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '1.0.0\n2.0.0' }), 'utf8');
  assert.throws(() => readPackageVersion(dir), /Missing or invalid version/);
});

test('syncDistReadme updates version header while preserving EOL and body, and handles missing file', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-readme-'));
  t.after(() => {
    try { fs.rmSync(path.join(dir, 'node_modules'), { recursive: true, force: true }); } catch {}
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const distDir = path.join(dir, 'dist');

  // Missing README.txt -> creates fallback with target version
  const createdPath = syncDistReadme(dir, '1.4.0');
  assert.ok(fs.readFileSync(createdPath, 'utf8').startsWith('Agent Messenger 1.4.0\n'));

  // Existing CRLF README.txt -> updates first line only and keeps CRLF
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(createdPath, 'Agent Messenger 0.1.0\r\n\r\nLine two\r\n', 'utf8');
  syncDistReadme(dir, '2.0.0-rc.1');
  assert.equal(fs.readFileSync(createdPath, 'utf8'), 'Agent Messenger 2.0.0-rc.1\r\n\r\nLine two\r\n');

  // Literal $& / $$ sequences in version string do not trigger String.replace backreferences
  syncDistReadme(dir, '2.0.0+$&');
  assert.equal(fs.readFileSync(createdPath, 'utf8'), 'Agent Messenger 2.0.0+$&\r\n\r\nLine two\r\n');

  // Existing file without header -> prepends header
  fs.writeFileSync(createdPath, 'Body only\n', 'utf8');
  syncDistReadme(dir, '3.1.0');
  assert.equal(fs.readFileSync(createdPath, 'utf8'), 'Agent Messenger 3.1.0\n\nBody only\n');
});

test('buildRuntime and packageRuntime eliminate hardcoded 0.1.0 and produce runnable runtime zip', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-pkg-'));
  t.after(() => {
    try { fs.rmSync(path.join(dir, 'node_modules'), { recursive: true, force: true }); } catch {}
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  for (const rel of ['src', 'ui', 'scripts', 'plugins']) {
    fs.cpSync(path.join(REPO_ROOT, rel), path.join(dir, rel), { recursive: true });
  }
  for (const file of ['LICENSE', 'NOTICE']) {
    fs.copyFileSync(path.join(REPO_ROOT, file), path.join(dir, file));
  }
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, 'dist', 'README.txt'), path.join(dir, 'dist', 'README.txt'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'agent-messenger',
    version: '2.3.4',
    type: 'module',
  }), 'utf8');
  fs.symlinkSync(
    path.join(REPO_ROOT, 'node_modules'),
    path.join(dir, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );

  const built = await buildRuntime({ root: dir });
  assert.equal(built.version, '2.3.4');

  const pkgRes = await packageRuntime({ root: dir, skipBuild: true });
  assert.equal(pkgRes.version, '2.3.4');
  assert.equal(pkgRes.entries.length, 8);

  const extractDir = path.join(dir, 'extracted');
  const names = extractAndVerifyZip(pkgRes.outputPath, extractDir);
  if (names.length) {
    assert.deepEqual(names, [
      'agent-messenger.mjs',
      'README.txt',
      'THIRD_PARTY_LICENSES.txt',
      'LICENSE',
      'NOTICE',
      'ui/index.html',
      'scripts/install.mjs',
      'plugins/pi/agent-messenger.ts',
    ]);
  }

  for (const rel of pkgRes.entries) {
    assert.equal(fs.existsSync(path.join(extractDir, rel)), true, `Missing extracted ${rel}`);
  }
  assert.equal(fs.readFileSync(path.join(extractDir, 'README.txt'), 'utf8').split(/\r?\n/, 1)[0], 'Agent Messenger 2.3.4');
  assert.ok(fs.readFileSync(path.join(extractDir, 'agent-messenger.mjs'), 'utf8').startsWith('/* Agent Messenger 2.3.4.'));

  const init = await initializeMcpBundle(path.join(extractDir, 'agent-messenger.mjs'), path.join(dir, 'data'));
  assert.equal(init.stderr, '');
  assert.equal(init.result.serverInfo.name, 'agent-messenger');
  assert.equal(init.result.serverInfo.version, '2.3.4');
});

test('verifyDistVersionConsistency and packageRuntime reject version drift and missing inputs', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-drift-'));
  t.after(() => {
    try { fs.rmSync(path.join(dir, 'node_modules'), { recursive: true, force: true }); } catch {}
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'ui'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'plugins', 'pi'), { recursive: true });

  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '1.0.0' }), 'utf8');
  fs.writeFileSync(path.join(dir, 'dist', 'agent-messenger.mjs'), '/* Agent Messenger 1.0.0. */\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'dist', 'README.txt'), 'Agent Messenger 0.1.0\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'dist', 'THIRD_PARTY_LICENSES.txt'), 'ok', 'utf8');
  fs.writeFileSync(path.join(dir, 'LICENSE'), 'ok', 'utf8');
  fs.writeFileSync(path.join(dir, 'NOTICE'), 'ok', 'utf8');
  fs.writeFileSync(path.join(dir, 'ui', 'index.html'), '<html/>', 'utf8');
  fs.writeFileSync(path.join(dir, 'scripts', 'install.mjs'), '// ok', 'utf8');
  fs.writeFileSync(path.join(dir, 'plugins', 'pi', 'agent-messenger.ts'), '// ok', 'utf8');

  assert.throws(() => verifyDistVersionConsistency(dir, '1.0.0'), /README\.txt header/);
  await assert.rejects(() => packageRuntime({ root: dir, skipBuild: true }), /README\.txt header/);

  fs.writeFileSync(path.join(dir, 'dist', 'README.txt'), 'Agent Messenger 1.0.0\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'dist', 'agent-messenger.mjs'), '/* Agent Messenger 0.1.0. */\n', 'utf8');
  assert.throws(() => verifyDistVersionConsistency(dir, '1.0.0'), /banner/);

  fs.writeFileSync(path.join(dir, 'dist', 'agent-messenger.mjs'), '/* Agent Messenger 1.0.0. */\n', 'utf8');
  fs.unlinkSync(path.join(dir, 'NOTICE'));
  await assert.rejects(() => packageRuntime({ root: dir, skipBuild: true }), /Missing runtime input/);
});

test('createZip handles empty files, incompressible random data, and Windows path separators', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-zip-edge-'));
  t.after(() => {
    try { fs.rmSync(path.join(dir, 'node_modules'), { recursive: true, force: true }); } catch {}
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const emptyFile = path.join(dir, 'empty.txt');
  const randomFile = path.join(dir, 'random.bin');
  const randomBytes = crypto.randomBytes(2048);
  fs.writeFileSync(emptyFile, Buffer.alloc(0));
  fs.writeFileSync(randomFile, randomBytes);

  const zipPath = path.join(dir, 'edge.zip');
  createZip([
    { source: emptyFile, name: 'sub\\empty.txt' },
    { source: randomFile, name: 'sub\\random.bin' },
  ], zipPath);

  const outDir = path.join(dir, 'out');
  const names = extractAndVerifyZip(zipPath, outDir);
  if (names.length) assert.deepEqual(names, ['sub/empty.txt', 'sub/random.bin']);
  assert.equal(fs.readFileSync(path.join(outDir, 'sub', 'empty.txt')).length, 0);
  assert.deepEqual(fs.readFileSync(path.join(outDir, 'sub', 'random.bin')), randomBytes);
});

function extractWorkflowBashSteps(raw) {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const steps = [];
  for (let i = 0; i < lines.length; i++) {
    const stepMatch = lines[i].match(/^      - name:\s*(.+?)\s*$/);
    if (!stepMatch) continue;
    const name = stepMatch[1];
    let hasBashShell = false;
    let j = i + 1;
    while (j < lines.length && !/^      - name:\s*/.test(lines[j])) {
      if (/^\s+shell:\s*bash\s*$/.test(lines[j])) hasBashShell = true;
      if (/^\s+run:\s*\|\s*$/.test(lines[j])) {
        const bodyLines = [];
        let k = j + 1;
        while (k < lines.length && (lines[k] === '' || lines[k].startsWith('          '))) {
          bodyLines.push(lines[k].startsWith('          ') ? lines[k].slice(10) : '');
          k++;
        }
        steps.push({ name, hasBashShell, script: bodyLines.join('\n').trimEnd() + '\n' });
        i = k - 1;
        break;
      }
      j++;
    }
  }
  return steps;
}

function findBashBinary() {
  const candidates = process.platform === 'win32'
    ? ['C:\\Program Files\\Git\\bin\\bash.exe', 'D:\\Bio program\\rtools45\\usr\\bin\\bash.exe']
    : ['bash'];
  return candidates.find(p => p === 'bash' || fs.existsSync(p)) || null;
}

test('release workflow defines v* tag and workflow_dispatch triggers, permissions, verification, and release publishing', t => {
  const wfPath = path.join(REPO_ROOT, '.github', 'workflows', 'release.yml');
  const raw = fs.readFileSync(wfPath, 'utf8');

  assert.equal(raw.includes('\t'), false, 'YAML must not contain tab characters');
  assert.ok(raw.endsWith('\n'), 'YAML should end with trailing newline');
  assert.match(raw, /^on:\s*[\r\n]+  push:\s*[\r\n]+    tags:\s*[\r\n]+      - 'v\*'/m);
  assert.match(raw, /^  workflow_dispatch:/m);
  assert.match(raw, /^permissions:\s*[\r\n]+  contents: write/m);
  assert.match(raw, /node-version:\s*'>=24\.9\.0 <25'/);
  assert.match(raw, /run:\s*npm ci/);
  assert.match(raw, /run:\s*npm test/);
  assert.match(raw, /run:\s*npm run package/);
  assert.match(raw, /GH_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}/);
  assert.match(raw, /dist\/agent-messenger-runtime\.zip/);
  assert.match(raw, /gh release create/);
  assert.match(raw, /gh release upload/);
  assert.match(raw, /gh release edit/);

  const steps = extractWorkflowBashSteps(raw);
  assert.equal(steps.length, 4, 'Expected 4 multiline bash steps in release.yml');
  for (const step of steps) {
    assert.equal(step.hasBashShell, true, `Step "${step.name}" should declare shell: bash`);
  }

  // Syntax-check every embedded inline node -e snippet in release.yml
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-wf-syntax-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  let snippetIdx = 0;
  for (const step of steps) {
    for (const match of step.script.matchAll(/node\b([^\n]*?)\s+-e\s+'([\s\S]*?)'/g)) {
      const isModule = match[1].includes('--input-type=module');
      const checkFile = path.join(tmpDir, `snippet-${snippetIdx++}.${isModule ? 'mjs' : 'cjs'}`);
      fs.writeFileSync(checkFile, match[2], 'utf8');
      execFileSync(process.execPath, ['--check', checkFile], { stdio: 'pipe' });
    }
  }
  assert.ok(snippetIdx >= 4, `Expected at least 4 inline Node snippets in release.yml, checked ${snippetIdx}`);

  const bashExe = findBashBinary();
  if (bashExe) {
    for (const step of steps) {
      execFileSync(bashExe, ['-n', '-c', step.script], { stdio: 'pipe' });
    }
  }
});

test('release workflow bash steps execute cleanly end-to-end with packaged zip and mock gh/git', async t => {
  const bashExe = findBashBinary();
  if (!bashExe) return t.skip('No non-WSL bash binary available');

  const wfPath = path.join(REPO_ROOT, '.github', 'workflows', 'release.yml');
  const steps = new Map(extractWorkflowBashSteps(fs.readFileSync(wfPath, 'utf8')).map(s => [s.name, s.script]));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-wf-e2e-'));
  t.after(() => {
    try { fs.rmSync(path.join(dir, 'node_modules'), { recursive: true, force: true }); } catch {}
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  // Build isolated 2.4.0 repo + package runtime zip
  for (const rel of ['src', 'ui', 'scripts', 'plugins']) {
    fs.cpSync(path.join(REPO_ROOT, rel), path.join(dir, rel), { recursive: true });
  }
  for (const file of ['LICENSE', 'NOTICE']) {
    fs.copyFileSync(path.join(REPO_ROOT, file), path.join(dir, file));
  }
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, 'dist', 'README.txt'), path.join(dir, 'dist', 'README.txt'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'agent-messenger', version: '2.4.0', type: 'module' }), 'utf8');
  fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  await packageRuntime({ root: dir });

  const runnerTemp = path.join(dir, 'runner-temp');
  const binDir = path.join(dir, 'mock-bin');
  const ghStateDir = path.join(dir, 'gh-state');
  fs.mkdirSync(runnerTemp, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(ghStateDir, { recursive: true });

  // Mock gh and git via Node helpers so POSIX bash scripts exercise exact CLI arguments and file outputs
  const mockGhJs = path.join(binDir, 'mock-gh.mjs').replace(/\\/g, '/');
  fs.writeFileSync(mockGhJs, `
import fs from 'node:fs';
import path from 'node:path';
const stateDir = process.env.MOCK_GH_STATE;
const args = process.argv.slice(2);
const logFile = path.join(stateDir, 'gh-calls.jsonl');
fs.appendFileSync(logFile, JSON.stringify(args) + '\\n');
const [group, sub, ...rest] = args;
if (group !== 'release') process.exit(2);
const tag = rest[0];
const relFile = path.join(stateDir, \`release-\${tag}.json\`);
if (sub === 'view') {
  if (!fs.existsSync(relFile)) process.exit(1);
  const data = JSON.parse(fs.readFileSync(relFile, 'utf8'));
  if (rest.includes('--json') && rest.includes('body')) process.stdout.write(data.body || '');
  process.exit(0);
}
if (sub === 'create') {
  const notesIdx = rest.indexOf('--notes');
  const notes = notesIdx !== -1 ? rest[notesIdx + 1] : '';
  const body = \`\${notes}\\n## What's Changed\\n* Initial release\\n\`;
  fs.writeFileSync(relFile, JSON.stringify({ tag, body, args: rest }, null, 2));
  process.exit(0);
}
if (sub === 'upload') {
  if (!fs.existsSync(relFile)) process.exit(1);
  const data = JSON.parse(fs.readFileSync(relFile, 'utf8'));
  data.uploaded = rest[1];
  fs.writeFileSync(relFile, JSON.stringify(data, null, 2));
  process.exit(0);
}
if (sub === 'edit') {
  if (!fs.existsSync(relFile)) process.exit(1);
  const data = JSON.parse(fs.readFileSync(relFile, 'utf8'));
  const nfIdx = rest.indexOf('--notes-file');
  if (nfIdx !== -1) data.body = fs.readFileSync(rest[nfIdx + 1], 'utf8');
  fs.writeFileSync(relFile, JSON.stringify(data, null, 2));
  process.exit(0);
}
process.exit(2);
`, 'utf8');

  const nodeExePosix = process.execPath.replace(/\\/g, '/');
  fs.writeFileSync(path.join(binDir, 'gh'), `#!/usr/bin/env bash\nexec "${nodeExePosix}" "${mockGhJs}" "$@"\n`, 'utf8');
  fs.writeFileSync(path.join(binDir, 'git'), `#!/usr/bin/env bash\nif [ "$1" = "ls-remote" ]; then\n  [ "\${MOCK_TAG_EXISTS:-0}" = "1" ] && exit 0 || exit 2\nfi\nexit 0\n`, 'utf8');

  const toPosixPath = p => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);
  const testEnv = {
    ...process.env,
    PATH: `${toPosixPath(binDir)}:${toPosixPath(path.dirname(process.execPath))}:/usr/bin:/bin`,
    RUNNER_TEMP: runnerTemp.replace(/\\/g, '/'),
    MOCK_GH_STATE: ghStateDir,
  };

  // 1. Verify Node.js version + Verify packaged runtime archive
  execFileSync(bashExe, ['-c', steps.get('Verify Node.js version')], { cwd: dir, env: testEnv, stdio: 'pipe' });
  execFileSync(bashExe, ['-c', steps.get('Verify packaged runtime archive')], { cwd: dir, env: testEnv, stdio: 'pipe' });

  // 1b. Negative check: Verify packaged runtime archive rejects version mismatch in bundle
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'agent-messenger', version: '9.9.9', type: 'module' }), 'utf8');
  assert.throws(
    () => execFileSync(bashExe, ['-c', steps.get('Verify packaged runtime archive')], { cwd: dir, env: testEnv, stdio: 'pipe' }),
  );
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'agent-messenger', version: '2.4.0', type: 'module' }), 'utf8');

  // 2. Resolve release metadata (workflow_dispatch default, prerelease trimmed tag, and invalid tag rejection)
  const ghOut1 = path.join(dir, 'github-output-1.txt');
  fs.writeFileSync(ghOut1, '', 'utf8');
  execFileSync(bashExe, ['-c', steps.get('Resolve release metadata')], {
    cwd: dir,
    env: { ...testEnv, EVENT_NAME: 'workflow_dispatch', REF_NAME: 'main', INPUT_TAG: '  ', INPUT_PRERELEASE: 'false', GITHUB_OUTPUT: ghOut1.replace(/\\/g, '/') },
    stdio: 'pipe',
  });
  const meta1 = Object.fromEntries(fs.readFileSync(ghOut1, 'utf8').trim().split('\n').map(l => l.split('=')));
  assert.equal(meta1.tag, 'v2.4.0');
  assert.equal(meta1.pkg_version, '2.4.0');
  assert.equal(meta1.prerelease, 'false');
  assert.match(meta1.sha256, /^[0-9a-f]{64}$/);

  const ghOut2 = path.join(dir, 'github-output-2.txt');
  fs.writeFileSync(ghOut2, '', 'utf8');
  execFileSync(bashExe, ['-c', steps.get('Resolve release metadata')], {
    cwd: dir,
    env: { ...testEnv, EVENT_NAME: 'workflow_dispatch', REF_NAME: 'main', INPUT_TAG: ' v2.4.0-rc.1 ', INPUT_PRERELEASE: 'false', GITHUB_OUTPUT: ghOut2.replace(/\\/g, '/') },
    stdio: 'pipe',
  });
  const meta2 = Object.fromEntries(fs.readFileSync(ghOut2, 'utf8').trim().split('\n').map(l => l.split('=')));
  assert.equal(meta2.tag, 'v2.4.0-rc.1');
  assert.equal(meta2.prerelease, 'true');

  assert.throws(() => execFileSync(bashExe, ['-c', steps.get('Resolve release metadata')], {
    cwd: dir,
    env: { ...testEnv, EVENT_NAME: 'workflow_dispatch', REF_NAME: 'main', INPUT_TAG: 'v2.4.0 bad', INPUT_PRERELEASE: 'false', GITHUB_OUTPUT: ghOut2.replace(/\\/g, '/') },
    stdio: 'pipe',
  }));

  // 3. Publish GitHub Release: create path + existing release update path (updating SHA-256 while preserving changelog)
  const publishEnv = {
    ...testEnv,
    GH_TOKEN: 'dummy-token',
    GITHUB_SHA: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    TAG: meta1.tag,
    PKG_VERSION: meta1.pkg_version,
    IS_PRERELEASE: meta1.prerelease,
    ZIP_SHA256: meta1.sha256,
    MOCK_TAG_EXISTS: '0',
  };
  execFileSync(bashExe, ['-c', steps.get('Publish GitHub Release')], { cwd: dir, env: publishEnv, stdio: 'pipe' });
  const created = JSON.parse(fs.readFileSync(path.join(ghStateDir, 'release-v2.4.0.json'), 'utf8'));
  assert.ok(created.args.includes('--generate-notes'));
  assert.ok(created.args.includes('--target'));
  assert.ok(created.body.includes(`SHA-256: \`${meta1.sha256}\``));
  assert.ok(created.body.includes('## What\'s Changed'));

  // Re-run with updated sha256 -> updates asset AND SHA-256 notes while keeping generated changelog
  const newSha = 'f'.repeat(64);
  execFileSync(bashExe, ['-c', steps.get('Publish GitHub Release')], {
    cwd: dir,
    env: { ...publishEnv, ZIP_SHA256: newSha, MOCK_TAG_EXISTS: '1' },
    stdio: 'pipe',
  });
  const updated = JSON.parse(fs.readFileSync(path.join(ghStateDir, 'release-v2.4.0.json'), 'utf8'));
  assert.equal(updated.uploaded, 'dist/agent-messenger-runtime.zip');
  assert.ok(updated.body.includes(`SHA-256: \`${newSha}\``), 'Expected updated SHA-256 in release notes');
  assert.equal(updated.body.includes(meta1.sha256), false, 'Expected stale SHA-256 to be replaced');
  assert.ok(updated.body.includes('## What\'s Changed'), 'Expected existing generated changelog to be preserved');
});
