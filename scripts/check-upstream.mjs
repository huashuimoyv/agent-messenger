import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const UPSTREAM_DIR = path.resolve(ROOT, '../.codex_work/agent-hud-open');
const UPSTREAM_URL = 'https://github.com/jazzenchen/agent-hud-open.git';
const STATE_FILE = path.resolve(ROOT, 'verification/upstream-sync.json');

const MESSAGING_PATHS = [
  'src/crates/messaging/',
  'src/crates/platform/src/delivery/',
  'src/crates/platform/src/claude_plugin/',
  'src/crates/platform/src/deepseek_plugin/',
  'src/crates/platform/src/hooks/',
  'src/apps/mcp/',
  'docs/agent-messages.md',
  'docs/agent-contract.md',
  'docs/client-hooks.md'
];

function git(dir, args) {
  try {
    return execFileSync('git', args, { cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    throw new Error(`git ${args.join(' ')} failed: ${error.stderr || error.message}`);
  }
}

async function main() {
  console.log('[Agent Messenger] Checking upstream repository for messaging updates...');
  
  if (!fs.existsSync(UPSTREAM_DIR)) {
    console.log(`Cloning upstream repository to ${UPSTREAM_DIR}...`);
    fs.mkdirSync(path.dirname(UPSTREAM_DIR), { recursive: true });
    git(path.dirname(UPSTREAM_DIR), ['clone', '--bare', UPSTREAM_URL, UPSTREAM_DIR]);
  }

  // Fetch latest commits
  console.log('Fetching latest commits from remote origin...');
  git(UPSTREAM_DIR, ['fetch', 'origin']);

  let baselineCommit = 'd14bc43fe117f2f5d4e9143d5ebcf92c62225a66';
  if (fs.existsSync(STATE_FILE)) {
    try {
      const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      if (state.last_checked_commit) baselineCommit = state.last_checked_commit;
    } catch {}
  }

  const latestCommit = git(UPSTREAM_DIR, ['rev-parse', 'origin/main']);
  console.log(`Baseline commit: ${baselineCommit.slice(0, 7)}`);
  console.log(`Latest commit:   ${latestCommit.slice(0, 7)}`);

  if (baselineCommit === latestCommit) {
    console.log('No new upstream commits found. Agent Messenger is completely up to date with upstream!');
    return;
  }

  // Get commits between baseline and latest
  const logOutput = git(UPSTREAM_DIR, ['log', '--oneline', `${baselineCommit}..${latestCommit}`]);
  const allCommits = logOutput ? logOutput.split('\n') : [];

  // Filter commits that touch messaging paths
  const messagingDiffStats = git(UPSTREAM_DIR, ['diff', '--stat', `${baselineCommit}..${latestCommit}`, '--', ...MESSAGING_PATHS]);
  const messagingCommitsRaw = git(UPSTREAM_DIR, ['log', '--oneline', `${baselineCommit}..${latestCommit}`, '--', ...MESSAGING_PATHS]);
  const messagingCommits = messagingCommitsRaw ? messagingCommitsRaw.split('\n') : [];

  console.log('\n--- Upstream Update Summary ---');
  console.log(`Total new upstream commits: ${allCommits.length}`);
  console.log(`Commits affecting messaging subsystem: ${messagingCommits.length}`);

  if (messagingCommits.length > 0) {
    console.log('\n[Relevant Messaging Commits]');
    messagingCommits.forEach(c => console.log('  * ' + c));
    console.log('\n[Changed Messaging Files]');
    console.log(messagingDiffStats);
  } else {
    console.log('\nAll new commits relate only to UI/Tauri/WebView2/Quota/Styling; messaging contracts are untouched.');
  }

  const syncReport = {
    checked_at: new Date().toISOString(),
    upstream_url: UPSTREAM_URL,
    baseline_commit: baselineCommit,
    latest_commit: latestCommit,
    total_new_commits: allCommits.length,
    messaging_commits_count: messagingCommits.length,
    messaging_commits: messagingCommits,
    has_messaging_updates: messagingCommits.length > 0
  };

  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(syncReport, null, 2) + '\n', 'utf-8');
  console.log(`Sync status recorded at ${STATE_FILE}`);
}

main().catch(err => {
  console.error('[Error]', err.message);
  process.exit(1);
});
