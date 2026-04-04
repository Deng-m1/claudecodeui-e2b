import { WebSocket } from 'ws';
import { SandboxAgent } from 'sandbox-agent';
import { e2b } from 'sandbox-agent/e2b';
import { resolveE2BTemplate } from '../../server/providers/e2b/sandbox-manager.js';
import { TERMINALD_E2B_SHELL } from '../config.js';

const clientCache = new Map();

function hasOwnEnv(envs, key) {
  return Object.prototype.hasOwnProperty.call(envs, key);
}

function sanitizeEnvs(envs) {
  return Object.fromEntries(
    Object.entries(envs).filter(([, value]) => value !== null && value !== undefined && value !== ''),
  );
}

function buildSandboxEnvs(context) {
  const envs = { ...(context.envs || {}) };

  if (process.env.GITHUB_TOKEN && !hasOwnEnv(envs, 'GITHUB_TOKEN')) {
    envs.GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  }

  if (process.env.ANTHROPIC_API_KEY && !hasOwnEnv(envs, 'ANTHROPIC_API_KEY')) {
    envs.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  }

  if (process.env.OPENAI_API_KEY && !hasOwnEnv(envs, 'OPENAI_API_KEY')) {
    envs.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  }

  return sanitizeEnvs(envs);
}

function normalizeLaunchSpec(spec) {
  if (!spec || typeof spec !== 'object') {
    return null;
  }

  const command = typeof spec.command === 'string' && spec.command.trim() ? spec.command.trim() : null;
  if (!command) {
    return null;
  }

  const args = Array.isArray(spec.args)
    ? spec.args.filter((value) => typeof value === 'string' && value.trim().length > 0)
    : [];

  return { command, args };
}

function buildCreateProcessRequest(context, launchSpec = null) {
  const processSpec = normalizeLaunchSpec(launchSpec);

  return {
    command: processSpec?.command || TERMINALD_E2B_SHELL,
    args: processSpec?.args || ['-l'],
    cwd: context.projectRoot,
    env: {
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'claudecliui-terminald',
    },
    interactive: true,
    tty: true,
  };
}

async function connectSandboxClient(context, forceReconnect = false) {
  const cacheKey = context.sandboxId;

  if (!forceReconnect && clientCache.has(cacheKey)) {
    return clientCache.get(cacheKey);
  }

  const client = await SandboxAgent.start({
    sandboxId: context.sandboxId,
    sandbox: e2b({
      create: { envs: buildSandboxEnvs(context) },
      template: resolveE2BTemplate(),
      autoPause: true,
    }),
  });

  clientCache.set(cacheKey, client);
  return client;
}

async function getRunningProcess(client, processId) {
  if (!processId) {
    return null;
  }

  try {
    const processInfo = await client.getProcess(processId);
    if (processInfo?.status === 'running' || processInfo?.status === 'starting') {
      return processInfo;
    }
  } catch {
    return null;
  }

  return null;
}

export async function ensureE2BTerminal(record, context, options = {}) {
  if (!process.env.E2B_API_KEY) {
    throw new Error('E2B_API_KEY is not configured');
  }

  let client = await connectSandboxClient(context);
  let processInfo = await getRunningProcess(client, record.processId);

  if (!processInfo) {
    try {
      client = await connectSandboxClient(context, true);
      processInfo = await getRunningProcess(client, record.processId);
    } catch {
      // Fall through to process creation below.
    }
  }

  if (!processInfo) {
    processInfo = await client.createProcess(buildCreateProcessRequest(context, options.launchSpec || null));
  }

  return {
    ...record,
    processId: processInfo.id,
    status: 'active',
  };
}

export async function attachE2BTerminal(record, context, { cols = 120, rows = 30 } = {}) {
  const client = await connectSandboxClient(context);
  const terminal = client.connectProcessTerminal(record.processId, { WebSocket });

  try {
    terminal.resize({ cols, rows });
  } catch {
    // Resize failures during startup are non-fatal.
  }

  return {
    onReady(listener) {
      return terminal.onReady(listener);
    },
    onOutput(listener) {
      return terminal.onData((data) => {
        listener(Buffer.from(data).toString('utf8'));
      });
    },
    onError(listener) {
      return terminal.onError(listener);
    },
    onExit(listener) {
      return terminal.onExit(listener);
    },
    write(data) {
      terminal.sendInput(data);
    },
    resize(nextCols, nextRows) {
      terminal.resize({ cols: nextCols, rows: nextRows });
    },
    async close() {
      terminal.close();
      await terminal.closed.catch(() => {});
    },
  };
}

export async function closeE2BTerminal(record, context) {
  const client = await connectSandboxClient(context);

  if (!record.processId) {
    return;
  }

  try {
    await client.stopProcess(record.processId);
  } catch {
    try {
      await client.killProcess(record.processId);
    } catch {
      // Ignore already-stopped processes.
    }
  }
}
