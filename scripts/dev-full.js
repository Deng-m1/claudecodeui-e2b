#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { execFile, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { promisify } from 'util';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const concurrentlyBin = path.join(repoRoot, 'node_modules', 'concurrently', 'dist', 'bin', 'concurrently.js');
const execFileAsync = promisify(execFile);
const shutdownGraceMs = 5000;
const pollIntervalMs = 100;

function readDotEnv(filePath) {
  const values = {};

  if (!fs.existsSync(filePath)) {
    return values;
  }

  const content = fs.readFileSync(filePath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) {
      continue;
    }

    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    values[match[1]] = value;
  }

  return values;
}

function resolvePort(value, fallback) {
  const port = Number.parseInt(value, 10);
  return Number.isInteger(port) && port > 0 ? String(port) : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await sleep(pollIntervalMs);
  }

  return !isProcessAlive(pid);
}

async function getRepoScopedDevPids() {
  const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,args=']);
  const patterns = [
    'npm run terminald',
    'npm run server:watch',
    'npm run client',
    'server/index.js',
    'terminald/index.js',
    'node_modules/.bin/vite',
    'vite/dist/node/cli.js',
  ];
  const pids = [];

  for (const line of stdout.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!match) {
      continue;
    }

    const pid = Number(match[1]);
    const args = match[2];
    if (!Number.isInteger(pid) || pid <= 0) {
      continue;
    }
    if (pid === process.pid || pid === process.ppid) {
      continue;
    }
    if (!patterns.some((pattern) => args.includes(pattern))) {
      continue;
    }

    try {
      const cwd = await fs.promises.realpath(`/proc/${pid}/cwd`);
      if (cwd === repoRoot) {
        pids.push(pid);
      }
    } catch {
      // Ignore processes that have already exited or cannot be inspected.
    }
  }

  return Array.from(new Set(pids));
}

async function stopExistingDevProcesses() {
  const pids = await getRepoScopedDevPids();

  if (pids.length === 0) {
    return;
  }

  console.log(`[dev:full] Stopping existing repo-local dev process(es): ${pids.join(', ')}`);

  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch (error) {
      if (error.code !== 'ESRCH') {
        throw error;
      }
    }
  }

  for (const pid of pids) {
    const stopped = await waitForExit(pid, shutdownGraceMs);
    if (stopped) {
      continue;
    }

    console.log(`[dev:full] PID ${pid} did not stop after SIGTERM; sending SIGKILL.`);
    try {
      process.kill(pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') {
        throw error;
      }
    }
    await waitForExit(pid, 1000);
  }
}

if (!fs.existsSync(concurrentlyBin)) {
  console.error('[dev:full] Missing concurrently. Run npm install first.');
  process.exit(1);
}

const dotEnv = readDotEnv(path.join(repoRoot, '.env'));
const env = {
  ...dotEnv,
  ...process.env,
  CLAUDE_CODE_UI_FORCE_VITE_DEV_SERVER: '1',
};

const serverPort = resolvePort(env.SERVER_PORT || env.PORT, '3001');
const vitePort = resolvePort(env.VITE_PORT, '5173');
const terminaldPort = resolvePort(
  env.TERMINALD_PORT || env.VITE_TERMINALD_PORT,
  String(Number.parseInt(serverPort, 10) + 1)
);

env.SERVER_PORT = serverPort;
env.VITE_PORT = vitePort;
env.TERMINALD_PORT = terminaldPort;
env.VITE_TERMINALD_PORT = terminaldPort;

console.log('[dev:full] Starting full development stack.');
console.log(`[dev:full] Live UI:     http://localhost:${vitePort}`);
console.log(`[dev:full] Backend/API: http://localhost:${serverPort}`);
console.log(`[dev:full] terminald:   http://localhost:${terminaldPort}`);
console.log('[dev:full] Backend HTML routes are forced to the Vite dev server while this runs.');

await stopExistingDevProcesses();

const child = spawn(process.execPath, [
  concurrentlyBin,
  '--kill-others',
  '--names',
  'terminald,server,client',
  '--prefix-colors',
  'yellow,cyan,green',
  'npm run terminald',
  'npm run server:watch',
  'npm run client',
], {
  cwd: repoRoot,
  env,
  stdio: 'inherit',
});

child.on('error', (error) => {
  console.error(`[dev:full] Failed to start development stack: ${error.message}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
