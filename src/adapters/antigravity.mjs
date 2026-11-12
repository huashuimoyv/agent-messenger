// Antigravity's local Connect JSON API and transcript records.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { canonical, rawId, entries, jsonLines, headRecords, tailOffset, textContent, envelopeMessageId, DeliveryError } from '../io.mjs';

const execFileAsync = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SERVICE_PATH = '/exa.language_server_pb.LanguageServerService/';
const META = { metadata: { ideName: 'antigravity', extensionName: 'antigravity', locale: 'en', ideVersion: 'unknown' } };
const ENQUEUE = 'MESSAGE_DELIVERY_STRATEGY_WHEN_IDLE';
const STALE_MS = 120_000;
const ENDPOINT_TTL_MS = 45_000;
const LARGE_TRANSCRIPT_BYTES = 512 * 1024;
const TAIL_READ_BYTES = 256 * 1024;
const MAX_RESPONSE = 32 * 1024 * 1024;

const httpAgent = new http.Agent({ keepAlive: true, keepAliveMsecs: 15_000, maxSockets: 8 });
const httpsAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 15_000, maxSockets: 8, rejectUnauthorized: false });
httpAgent.on('free', socket => socket.unref?.());
httpsAgent.on('free', socket => socket.unref?.());

class RpcError extends Error {
  constructor(message, status = null) { super(message); this.status = status; }
}

function commandFlag(command, name) {
  const match = String(command || '').match(new RegExp('(?:^|\\s)--' + name + '(?:=|\\s+)([^\\s]+)'));
  return match?.[1]?.replace(/^["']|["']$/g, '') || null;
}

async function windowsServers() {
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "function Flag([string]$s, [string]$n) {",
    "  $pattern = '(?:^|\\s)--' + [regex]::Escape($n) + '(?:=|\\s+)(\"[^\"]*\"|''[^'']*''|\\S+)'",
    "  $m = [regex]::Match($s, $pattern)",
    "  if (-not $m.Success) { return $null }",
    "  return $m.Groups[1].Value.Trim('\"').Trim(\"'\")",
    "}",
    "$procs = @(Get-CimInstance Win32_Process -Filter 'Name=''language_server.exe''')",
    "if ($procs.Count -eq 0) { '[]'; exit 0 }",
    "$listeners = @{}",
    "foreach ($conn in (Get-NetTCPConnection -State Listen)) {",
    "  if ($conn.LocalAddress -in @('127.0.0.1','::1','0.0.0.0','::')) {",
    "    $owner = [int]$conn.OwningProcess",
    "    if (-not $listeners.ContainsKey($owner)) { $listeners[$owner] = [System.Collections.Generic.HashSet[int]]::new() }",
    "    [void]$listeners[$owner].Add([int]$conn.LocalPort)",
    "  }",
    "}",
    "$rows = [System.Collections.Generic.List[object]]::new()",
    "foreach ($p in $procs) {",
    "  $exe = ([string]$p.ExecutablePath).ToLowerInvariant().Replace('\\','/')",
    "  $appData = [string](Flag $p.CommandLine 'app_data_dir')",
    "  if (-not ($exe.Contains('/antigravity/') -or $exe.Contains('/antigravity ide.app/') -or $exe.Contains('/antigravity-cli/') -or $exe.Contains('/antigravity_cli/') -or $appData.StartsWith('antigravity',[System.StringComparison]::OrdinalIgnoreCase))) { continue }",
    "  $token = Flag $p.CommandLine 'csrf_token'",
    "  $extensionPort = Flag $p.CommandLine 'extension_server_port'",
    "  $extensionToken = Flag $p.CommandLine 'extension_server_csrf_token'",
    "  if (-not $token -and -not ($extensionPort -and $extensionToken)) { continue }",
    "  $pidInt = [int]$p.ProcessId",
    "  $ports = if ($listeners.ContainsKey($pidInt)) { @($listeners[$pidInt]) } else { @() }",
    "  [void]$rows.Add([pscustomobject]@{ pid=$pidInt; token=$token; ports=$ports; extensionPort=$extensionPort; extensionToken=$extensionToken })",
    "}",
    "ConvertTo-Json -InputObject @($rows.ToArray()) -Depth 4 -Compress",
  ].join('\n');

  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', timeout: 5_000, maxBuffer: 1024 * 1024, windowsHide: true,
    });
    const rows = JSON.parse(stdout.trim() || '[]');
    return (Array.isArray(rows) ? rows : [rows]).map(row => ({
      pid: Number(row.pid),
      token: typeof row.token === 'string' ? row.token : '',
      ports: (Array.isArray(row.ports) ? row.ports : [row.ports]).map(Number).filter(port => port > 0 && port <= 65535),
      extensionPort: Number(row.extensionPort) || null,
      extensionToken: typeof row.extensionToken === 'string' ? row.extensionToken : '',
    }));
  } catch {
    return [];
  }
}

async function unixServers() {
  let stdout;
  try {
    ({ stdout } = await execFileAsync('ps', ['-eww', '-o', 'pid=,command='], { encoding: 'utf8', timeout: 2_000, maxBuffer: 8 * 1024 * 1024 }));
  } catch {
    return [];
  }
  const matched = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!match) continue;
    const command = match[2];
    const executable = command.trim().split(/\s+/, 1)[0].toLowerCase().replaceAll('\\', '/');
    const appData = commandFlag(command, 'app_data_dir')?.toLowerCase() || '';
    if (!/language[_-]server/i.test(executable)
      || !(executable.includes('/antigravity/') || executable.includes('/antigravity ide.app/')
        || executable.includes('/antigravity-cli/') || executable.includes('/antigravity_cli/')
        || appData.startsWith('antigravity'))) continue;
    const token = commandFlag(command, 'csrf_token') || '';
    const extensionPort = Number(commandFlag(command, 'extension_server_port')) || null;
    const extensionToken = commandFlag(command, 'extension_server_csrf_token') || '';
    if (token || (extensionPort && extensionToken)) {
      matched.push({ pidStr: match[1], pid: Number(match[1]), token, extensionPort, extensionToken });
    }
  }
  return Promise.all(matched.map(async item => {
    let ports = [];
    try {
      const { stdout: listeners } = await execFileAsync('lsof', ['-nP', '-a', '-p', item.pidStr, '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8', timeout: 2_000, maxBuffer: 1024 * 1024 });
      ports = [...new Set([...listeners.matchAll(/:(\d+)\s+\(LISTEN\)/g)].map(value => Number(value[1])))];
    } catch {}
    return { pid: item.pid, token: item.token, ports, extensionPort: item.extensionPort, extensionToken: item.extensionToken };
  }));
}

function candidatesFor(servers) {
  const found = [];
  for (const server of servers) {
    if (server.token) for (const port of server.ports) found.push({ pid: server.pid, scheme: 'https', port, token: server.token });
    if (server.extensionPort && (server.extensionToken || server.token)) {
      found.push({ pid: server.pid, scheme: 'http', port: server.extensionPort, token: server.extensionToken || server.token });
    }
  }
  const unique = new Map();
  for (const endpoint of found) unique.set(`${endpoint.scheme}:${endpoint.port}:${endpoint.pid}`, endpoint);
  return [...unique.values()];
}

function requestJson(endpoint, method, params, timeout = 3_000) {
  return new Promise((resolve, reject) => {
    const isHttps = endpoint.scheme === 'https';
    const transport = isHttps ? https : http;
    const agent = isHttps ? httpsAgent : httpAgent;
    const body = Buffer.from(JSON.stringify(params));
    const request = transport.request({
      hostname: '127.0.0.1',
      port: endpoint.port,
      path: SERVICE_PATH + method,
      method: 'POST',
      agent,
      headers: {
        'Connect-Protocol-Version': '1',
        'X-Codeium-Csrf-Token': endpoint.token,
        'Content-Type': 'application/json',
        'Content-Length': body.length,
      },
    }, response => {
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_RESPONSE) {
          request.destroy(new Error('Antigravity response exceeded the local read limit.'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('error', error => reject(new RpcError('Antigravity local service response failed: ' + error.message, response.statusCode || null)));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let value;
        try { value = text ? JSON.parse(text) : null; }
        catch { return reject(new RpcError('Antigravity local service returned invalid JSON.', response.statusCode || null)); }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          const message = typeof value?.message === 'string' ? value.message : 'Antigravity local service returned HTTP ' + response.statusCode;
          return reject(new RpcError(message, response.statusCode));
        }
        if (!value || typeof value !== 'object' || Array.isArray(value)) return reject(new RpcError('Antigravity local service returned an empty or invalid response.', response.statusCode));
        resolve(value);
      });
    });
    request.setTimeout(timeout, () => request.destroy(new Error('Antigravity local service timed out.')));
    request.on('error', error => reject(new RpcError('Antigravity local service request failed: ' + error.message)));
    request.end(body);
  });
}

async function discoverEndpoints() {
  const servers = process.platform === 'win32' ? await windowsServers() : await unixServers();
  const candidates = candidatesFor(servers);
  if (!candidates.length) return [];
  const results = await Promise.allSettled(candidates.map(async endpoint => {
    const status = await requestJson(endpoint, 'GetUserStatus', META, 1_500);
    return status.userStatus && typeof status.userStatus === 'object' ? endpoint : null;
  }));
  return results.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);
}

function profileRoots(config) {
  const geminiHome = process.env.GEMINI_CLI_HOME || path.join(config.home, '.gemini');
  return ['antigravity', 'antigravity-ide', 'antigravity-cli'].map(name => path.join(geminiHome, name));
}

function transcriptPath(root, id) {
  const file = path.join(root, 'brain', id, '.system_generated', 'logs', 'transcript.jsonl');
  try { return fs.statSync(file).isFile() ? file : null; }
  catch { return null; }
}

function conversationFiles(roots) {
  const result = new Map();
  for (const root of roots) {
    const brain = path.join(root, 'brain');
    for (const entry of entries(brain)) {
      if (!entry.isDirectory() || !UUID.test(entry.name)) continue;
      const file = transcriptPath(root, entry.name);
      const old = result.get(entry.name);
      const folder = path.join(brain, entry.name);
      try {
        if (file) {
          const fileMtime = fs.statSync(file).mtimeMs;
          if (!old?.file || fileMtime > old.mtimeMs) result.set(entry.name, { file, mtimeMs: fileMtime });
        } else if (!old) {
          result.set(entry.name, { file: null, mtimeMs: fs.statSync(folder).mtimeMs });
        }
      } catch {}
    }
    const conversations = path.join(root, 'conversations');
    for (const entry of entries(conversations)) {
      if (!entry.isFile() || !entry.name.endsWith('.db')) continue;
      const id = entry.name.slice(0, -3);
      if (UUID.test(id) && !result.has(id)) {
        try { result.set(id, { file: null, mtimeMs: fs.statSync(path.join(conversations, entry.name)).mtimeMs }); }
        catch {}
      }
    }
  }
  return result;
}

function promptText(record) {
  const raw = textContent(record?.content);
  const wrapped = raw.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
  if (wrapped) return wrapped[1].trim();
  return raw.replace(/<(?:ADDITIONAL_METADATA|USER_SETTINGS_CHANGE|CONTEXT_SUMMARY)>[\s\S]*?<\/(?:ADDITIONAL_METADATA|USER_SETTINGS_CHANGE|CONTEXT_SUMMARY)>/g, '').trim();
}

function timestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (value && typeof value === 'object' && Number.isFinite(value.seconds)) {
    return Number(value.seconds) * 1000 + Math.floor(Number(value.nanos || 0) / 1e6);
  }
  return null;
}

function summaryTimestamp(summary) {
  for (const key of ['updatedAt', 'updated_at', 'lastUpdatedAt', 'lastModifiedTime', 'lastModified', 'createdAt', 'created_at']) {
    const value = timestamp(summary?.[key]);
    if (value !== null) return value;
  }
  return null;
}

function summaryTitle(summary) {
  for (const key of ['title', 'name']) {
    const value = summary?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 120);
  }
  if (typeof summary?.summary === 'string' && summary.summary.trim()) return summary.summary.trim().slice(0, 120);
  return null;
}

function summaryProject(summary) {
  const uri = summary?.workspaces?.[0]?.workspaceFolderAbsoluteUri;
  if (typeof uri !== 'string') return null;
  try { return fileURLToPath(uri); } catch { return uri; }
}

function validModel(value) {
  return typeof value === 'string' && Boolean(value.trim()) && !value.trim().endsWith('_UNSPECIFIED');
}

function modelIsValid(value) {
  return validModel(value?.model) || validModel(value?.alias);
}

function cascadeConfig(trajectory) {
  const steps = trajectory?.trajectory?.steps;
  if (!Array.isArray(steps)) return null;
  for (const step of [...steps].reverse()) {
    for (const key of ['userConfig', 'lastUserConfig']) {
      const config = step?.userInput?.[key];
      const planner = config?.plannerConfig;
      if (validModel(planner?.planModel) || modelIsValid(planner?.requestedModel)) return config;
    }
  }
  return null;
}

function defaultCascadeConfig(status) {
  const data = status?.userStatus?.cascadeModelConfigData || status?.cascadeModelConfigData;
  if (!data || typeof data !== 'object') return null;
  const configs = Array.isArray(data.clientModelConfigs) ? data.clientModelConfigs : [];
  const candidate = data.defaultOverrideModelConfig?.modelOrAlias;
  if (modelIsValid(candidate) && !configs.some(item => JSON.stringify(item.modelOrAlias) === JSON.stringify(candidate) && item.disabled === true)) {
    return { plannerConfig: { requestedModel: candidate } };
  }
  if (Array.isArray(data.clientModelSorts)) {
    for (const sort of data.clientModelSorts) for (const group of sort.groups || []) {
      for (const label of group.modelLabels || []) {
        const found = configs.find(item => item.label === label && item.disabled !== true && modelIsValid(item.modelOrAlias));
        if (found) return { plannerConfig: { requestedModel: found.modelOrAlias } };
      }
    }
  }
  const found = configs.find(item => item.disabled !== true && item.isRecommended === true && modelIsValid(item.modelOrAlias))
    || configs.find(item => item.disabled !== true && modelIsValid(item.modelOrAlias));
  return found ? { plannerConfig: { requestedModel: found.modelOrAlias } } : null;
}

function summaryState(summary) {
  if (Array.isArray(summary?.waitingSteps) && summary.waitingSteps.length) return 'running';
  if (typeof summary?.state === 'string') {
    if (/running|working|in.?progress|waiting/i.test(summary.state)) return 'running';
    if (/idle|done|completed|stopped/i.test(summary.state)) return 'idle';
  }
  return 'unknown';
}

function applyTranscriptRecord(acc, value) {
  const at = timestamp(value.created_at) ?? timestamp(value.timestamp);
  if (at !== null) acc.updatedAt = at;
  const stepIndex = value.step_index ?? value.stepIndex;
  if (stepIndex !== undefined && stepIndex !== null) acc.lastStep = String(stepIndex);
  if (value.type === 'USER_INPUT' && value.source !== 'SYSTEM') {
    const prompt = promptText(value);
    if (!acc.title && prompt) acc.title = prompt.replace(/\s+/g, ' ').slice(0, 120);
    if (prompt) acc.current = { text: prompt, turnId: stepIndex == null ? null : 'step-' + stepIndex };
    acc.state = 'running';
    acc.active = true;
    acc.latestFinal = false;
  } else if (value.type === 'PLANNER_RESPONSE') {
    const status = String(value.status || '').toUpperCase();
    const hasToolCalls = Array.isArray(value.tool_calls) && value.tool_calls.length > 0;
    if (hasToolCalls && !['ERROR', 'CANCELED'].includes(status)) {
      acc.state = 'running';
      acc.active = true;
      acc.latestFinal = false;
    } else if (['DONE', 'ERROR', 'CANCELED'].includes(status)) {
      acc.state = 'idle';
      acc.active = false;
      acc.latestFinal = true;
    } else if (acc.active) {
      acc.state = 'running';
    } else {
      acc.state = 'unknown';
    }
  } else if (value.type === 'GENERIC' || value.type === 'TOOL_RESPONSE') {
    if (acc.active) acc.state = 'running';
    acc.latestFinal = false;
  }
}

function endpointKey(endpoint) {
  return `${endpoint.pid}:${endpoint.scheme}:${endpoint.port}`;
}

async function findOwner(id, endpoints, request) {
  const checks = await Promise.allSettled(endpoints.map(async endpoint => {
    const response = await request(endpoint, 'GetAllCascadeTrajectories', {});
    return { endpoint, summary: response.trajectorySummaries?.[id] || null };
  }));
  const loaded = [], other = [];
  checks.forEach((res, idx) => {
    if (res.status === 'fulfilled' && res.value.summary) loaded.push(res.value);
    else other.push(endpoints[idx]);
  });
  for (const candidate of [...loaded.map(item => item.endpoint), ...other]) {
    try {
      const trajectory = await request(candidate, 'GetCascadeTrajectory', { cascadeId: id });
      if (trajectory?.trajectory && typeof trajectory.trajectory === 'object') {
        return {
          endpoint: candidate,
          trajectory,
          summary: loaded.find(item => endpointKey(item.endpoint) === endpointKey(candidate))?.summary || null,
        };
      }
    } catch {}
  }
  return null;
}

export class AntigravityAdapter {
  #transcriptCache = new Map();
  #cachedEndpoints = null;
  #endpointsExpireAt = 0;
  #discovering = null;
  #rawDiscover;

  constructor(config, dependencies = {}) {
    this.config = config;
    this.client = 'antigravity';
    this.replyTool = "agent-messenger's send_message tool";
    this.canStart = false;
    this.#rawDiscover = dependencies.discover || discoverEndpoints;
    this.discover = () => this.#discoverCached();
    this.request = dependencies.request || requestJson;
    this.roots = profileRoots(config);
  }

  identifyCaller({ meta }) {
    const cascade = meta?.['antigravity.google/conversation_id'];
    return typeof cascade === 'string' && cascade ? { client: 'antigravity', rawId: rawId('antigravity', cascade), turnId: null } : null;
  }

  watchPaths(session, record) {
    return [record?.anchor?.path || session?._file].filter(Boolean);
  }

  invalidateEndpoints() {
    this.#cachedEndpoints = null;
    this.#endpointsExpireAt = 0;
  }

  async #discoverCached(force = false) {
    if (!force && this.#cachedEndpoints && Date.now() < this.#endpointsExpireAt) {
      return this.#cachedEndpoints;
    }
    if (this.#discovering) return this.#discovering;
    this.#discovering = (async () => {
      try {
        const found = await this.#rawDiscover();
        this.#cachedEndpoints = found;
        this.#endpointsExpireAt = Date.now() + (found.length ? ENDPOINT_TTL_MS : 5_000);
        return found;
      } finally {
        this.#discovering = null;
      }
    })();
    return this.#discovering;
  }

  async #readTranscript(file) {
    if (!file) return { offset: 0, title: null, updatedAt: null, state: 'unknown', current: null, lastStep: null };
    let stat;
    try { stat = fs.statSync(file); }
    catch { return { offset: 0, title: null, updatedAt: null, state: 'unknown', current: null, lastStep: null }; }

    const cached = this.#transcriptCache.get(file);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      const data = { ...cached.data };
      if (data.active && !data.latestFinal) {
        data.state = Date.now() - data.updatedAt < STALE_MS ? 'running' : 'unknown';
      }
      return data;
    }

    const acc = { offset: 0, title: null, updatedAt: null, state: 'unknown', current: null, lastStep: null, active: false, latestFinal: false };
    let start = 0;
    if (stat.size > LARGE_TRANSCRIPT_BYTES) {
      const head = await headRecords(file, 64 * 1024, 15);
      for (const rec of head) {
        if (rec.type === 'USER_INPUT' && rec.source !== 'SYSTEM') {
          const prompt = promptText(rec);
          if (prompt) { acc.title = prompt.replace(/\s+/g, ' ').slice(0, 120); break; }
        }
      }
      start = await tailOffset(file, TAIL_READ_BYTES);
    }

    for await (const { value, offset: nextOffset } of jsonLines(file, start)) {
      acc.offset = nextOffset;
      applyTranscriptRecord(acc, value);
    }
    if (start > 0 && acc.offset === 0) {
      for await (const { value, offset: nextOffset } of jsonLines(file, 0)) {
        acc.offset = nextOffset;
        applyTranscriptRecord(acc, value);
      }
    }

    acc.updatedAt ??= stat.mtimeMs;
    if (acc.active && !acc.latestFinal) acc.state = Date.now() - acc.updatedAt < STALE_MS ? 'running' : 'unknown';
    else if (acc.state === 'unknown' && acc.offset > 0) acc.state = 'idle';

    this.#transcriptCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, data: { ...acc } });
    return acc;
  }

  async #sessionRecord(id, local, summary, endpointCount) {
    const info = await this.#readTranscript(local?.file || null);
    const updatedAt = info.updatedAt ?? summaryTimestamp(summary) ?? local?.mtimeMs ?? null;
    return {
      id: canonical('antigravity', id), rawId: id, client: 'antigravity',
      title: summaryTitle(summary) || info.title || id,
      project: summaryProject(summary),
      state: info.state !== 'unknown' ? info.state : summaryState(summary),
      reachable: summary ? true : endpointCount ? null : false,
      ...(endpointCount ? {} : { reason: 'No authenticated Antigravity language server is running.' }),
      updatedAt, _file: local?.file || null, _offset: info.offset, _lastStep: info.lastStep,
      _current: info.current, _summary: summary || null,
    };
  }

  async #collectSummaries(endpoints) {
    const summaries = new Map();
    const responses = await Promise.allSettled(endpoints.map(ep => this.request(ep, 'GetAllCascadeTrajectories', {})));
    let anyFailed = false;
    for (const res of responses) {
      if (res.status === 'fulfilled') {
        for (const [id, summary] of Object.entries(res.value.trajectorySummaries || {})) {
          if (UUID.test(id)) summaries.set(id, summary);
        }
      } else {
        anyFailed = true;
      }
    }
    return { summaries, anyFailed };
  }

  async list({ limit = 50, offset = 0 } = {}) {
    let endpoints = await this.discover();
    let { summaries, anyFailed } = await this.#collectSummaries(endpoints);
    if (anyFailed && !summaries.size && this.#cachedEndpoints) {
      endpoints = await this.#discoverCached(true);
      ({ summaries } = await this.#collectSummaries(endpoints));
    }

    const local = conversationFiles(this.roots);
    const candidates = [];
    for (const id of new Set([...local.keys(), ...summaries.keys()])) {
      const loc = local.get(id), sum = summaries.get(id);
      candidates.push({ id, loc, sum, coarseTime: summaryTimestamp(sum) ?? loc?.mtimeMs ?? 0 });
    }
    candidates.sort((a, b) => b.coarseTime - a.coarseTime);

    const windowSize = Math.min(candidates.length, offset + limit + 8);
    const sessions = await Promise.all(
      candidates.slice(0, windowSize).map(c => this.#sessionRecord(c.id, c.loc, c.sum, endpoints.length))
    );
    sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return sessions.slice(offset, offset + limit);
  }

  async get(id) {
    const raw = rawId('antigravity', id);
    if (!UUID.test(raw)) return null;
    const local = conversationFiles(this.roots).get(raw);
    let endpoints = await this.discover();
    const lookup = async eps => {
      const checks = await Promise.allSettled(eps.map(ep => this.request(ep, 'GetAllCascadeTrajectories', {})));
      for (const r of checks) {
        if (r.status === 'fulfilled' && r.value.trajectorySummaries?.[raw]) return r.value.trajectorySummaries[raw];
      }
      return null;
    };
    let summary = await lookup(endpoints);
    if (!summary && this.#cachedEndpoints && !local) {
      endpoints = await this.#discoverCached(true);
      summary = await lookup(endpoints);
    }
    if (!local && !summary) return null;
    return this.#sessionRecord(raw, local, summary, endpoints.length);
  }

  async capture(session) {
    return {
      path: session._file || null,
      offset: session._offset || 0,
      lastStep: session._lastStep || null,
      correlationUnsafe: session.state !== 'idle',
    };
  }

  async deliver(session, text, messageId) {
    const id = rawId('antigravity', session.rawId || session.id);
    if (!UUID.test(id)) throw new DeliveryError('Antigravity session identity is invalid.');
    let endpoints = await this.discover();
    if (!endpoints.length && this.#cachedEndpoints !== null) {
      endpoints = await this.#discoverCached(true);
    }
    if (!endpoints.length) throw new DeliveryError('No authenticated Antigravity language server is running.');

    let owner = await findOwner(id, endpoints, this.request);
    if (!owner && this.#cachedEndpoints) {
      endpoints = await this.#discoverCached(true);
      if (endpoints.length) owner = await findOwner(id, endpoints, this.request);
    }
    if (!owner) throw new DeliveryError('The Antigravity cascade could not be opened on a running language server.');

    let config = cascadeConfig(owner.trajectory);
    if (!config) {
      try {
        const status = await this.request(owner.endpoint, 'GetUserStatus', META);
        config = defaultCascadeConfig(status);
      } catch {}
    }
    const params = {
      metadata: META.metadata,
      cascadeId: id,
      items: [{ text }],
      deliveryStrategy: ENQUEUE,
      ...(config ? { cascadeConfig: config } : {}),
    };
    try {
      await this.request(owner.endpoint, 'SendUserCascadeMessage', params);
      return { state: 'queued' };
    } catch (error) {
      this.invalidateEndpoints();
      if (error instanceof RpcError && error.status >= 400 && error.status < 500) {
        return { state: 'refused', reason: error.message };
      }
      return {
        state: 'uncertain',
        reason: 'Antigravity may have accepted the message, but its acknowledgement was not confirmed. Do not resend with a new request id.',
      };
    }
  }

  async read(session, message) {
    if (message.anchor?.correlationUnsafe) {
      if (session.reachable === false) {
        return {
          state: 'expired',
          reason: 'Antigravity session is offline; wait ended with delivery unconfirmed. An explicit reply_to remains available.',
        };
      }
      return {
        state: message.state || 'queued',
        reason: 'Antigravity queued this while a turn was active, so its ordinary answer cannot be linked safely. Ask for an explicit reply_to.',
      };
    }
    const file = message.anchor?.path || session._file;
    if (!file || !fs.existsSync(file)) {
      if (session.reachable === false) {
        return {
          state: 'expired',
          reason: 'The Antigravity session is offline and transcript is not available. Wait ended with delivery unconfirmed.',
        };
      }
      return { state: message.state || 'queued', reason: 'The Antigravity transcript is not available yet. An explicit reply_to remains available.' };
    }
    const offset = Number.isSafeInteger(message.anchor?.offset) ? message.anchor.offset : 0;
    let matched = false, turn = null, answer = null, ended = false, status = null;
    try {
      for await (const { value } of jsonLines(file, offset)) {
        if (value.type === 'USER_INPUT' && value.source !== 'SYSTEM') {
          const prompt = promptText(value);
          if (matched) break;
          if (envelopeMessageId(prompt) === message.id) {
            matched = true;
            turn = value.step_index == null ? null : 'step-' + value.step_index;
          }
        } else if (matched && value.type === 'PLANNER_RESPONSE'
          && (!Array.isArray(value.tool_calls) || value.tool_calls.length === 0 || ['ERROR', 'CANCELED'].includes(String(value.status || '').toUpperCase()))) {
          status = String(value.status || '').toUpperCase();
          if (typeof value.content === 'string' && value.content.trim()) answer = value.content.trim();
          if (['DONE', 'ERROR', 'CANCELED'].includes(status)) { ended = true; break; }
        }
      }
    } catch {
      return { state: message.state || 'queued', reason: 'The Antigravity transcript could not be read. An explicit reply_to remains available.' };
    }
    if (!matched) {
      if (session.reachable === false) {
        return {
          state: 'expired',
          reason: 'Target session is offline; message was not processed before shutdown. Wait ended with delivery unconfirmed.',
        };
      }
      return { state: message.state || 'queued' };
    }
    if (ended) {
      return {
        state: 'done', answer, turn,
        ...(['ERROR', 'CANCELED'].includes(status) ? { reason: `Antigravity turn ended with status ${status}.` }
          : !answer ? { reason: 'The Antigravity turn ended without readable answer text.' } : {}),
      };
    }
    if (session.reachable === false) {
      return {
        state: 'expired',
        turn,
        reason: 'Target session is offline; turn did not complete before shutdown. Wait ended with delivery unconfirmed.',
      };
    }
    return { state: 'started', turn };
  }

  async current(session, turnId = null) {
    const current = (await this.get(session.rawId || session.id))?._current || null;
    return current && (!turnId || current.turnId === turnId) ? current : null;
  }
}
