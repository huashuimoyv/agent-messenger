#!/usr/bin/env node
import { configuration } from '../src/config.mjs';
import { createAdapters } from '../src/adapters/index.mjs';
import { startDashboardServer } from '../src/dashboard-server.mjs';

const config = configuration();
const adapters = createAdapters(config);
const port = Number(process.env.PORT) || 3721;
const host = process.env.HOST || '127.0.0.1';

const instance = startDashboardServer({ config, adapters, port, host });
if (instance) {
  const url = `http://${host}:${port}`;
  console.log(`[Agent Messenger Dashboard] Running at ${url}`);
  console.log(`- Web UI:    ${url}/`);
  console.log(`- API State: ${url}/api/state`);

  process.once('SIGINT', () => { instance.close(); process.exit(0); });
  process.once('SIGTERM', () => { instance.close(); process.exit(0); });
}
