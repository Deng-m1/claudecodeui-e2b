#!/usr/bin/env node

import fs from 'fs/promises';
import path from 'path';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const repoRoot = process.cwd();
const serverEntry = path.join(repoRoot, 'server', 'index.js');
const shutdownGracePeriodMs = 5000;
const forceKillWaitMs = 1000;
const pollIntervalMs = 100;

function log(message) {
  process.stdout.write(`[server:restart] ${message}\n`);
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

async function getRepoScopedServerPids() {
  const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,args=']);
  const lines = stdout.split('\n');
  const pids = [];

  for (const line of lines) {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!match) continue;

    const pid = Number(match[1]);
    const args = match[2];

    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (pid === process.pid || pid === process.ppid) continue;
    if (!args.includes('server/index.js')) continue;
    if (args.includes('restart-server.js')) continue;

    try {
      const cwd = await fs.realpath(`/proc/${pid}/cwd`);
      if (cwd === repoRoot) {
        pids.push(pid);
      }
    } catch {
      // Ignore processes we cannot inspect.
    }
  }

  return pids;
}

async function stopExistingServers() {
  const pids = await getRepoScopedServerPids();

  if (pids.length === 0) {
    log('No running server process found for this repo.');
    return;
  }

  if (process.env.SERVER_RESTART_DRY_RUN === '1') {
    log(`Dry run: would stop server PID(s): ${pids.join(', ')}`);
    return;
  }

  log(`Stopping server PID(s): ${pids.join(', ')}`);

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
    const stoppedGracefully = await waitForExit(pid, shutdownGracePeriodMs);
    if (stoppedGracefully) {
      continue;
    }

    log(`PID ${pid} did not exit after SIGTERM; sending SIGKILL.`);
    try {
      process.kill(pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') {
        throw error;
      }
    }

    await waitForExit(pid, forceKillWaitMs);
  }
}

function startServer() {
  log(`Starting ${path.relative(repoRoot, serverEntry)}...`);

  const child = spawn(process.execPath, [serverEntry], {
    cwd: repoRoot,
    env: process.env,
    stdio: 'inherit',
  });

  const forwardSignal = (signal) => {
    if (!child.killed) {
      child.kill(signal);
    }
  };

  process.on('SIGINT', () => forwardSignal('SIGINT'));
  process.on('SIGTERM', () => forwardSignal('SIGTERM'));

  child.on('error', (error) => {
    console.error(`[server:restart] Failed to start server: ${error.message}`);
    process.exit(1);
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

async function main() {
  await stopExistingServers();

  if (process.env.SERVER_RESTART_DRY_RUN === '1') {
    return;
  }

  startServer();
}

main().catch((error) => {
  console.error(`[server:restart] ${error.message}`);
  process.exit(1);
});
