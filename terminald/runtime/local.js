import { execFile } from 'child_process';
import { promisify } from 'util';
import pty from 'node-pty';
import { TERMINALD_LOCAL_SHELL, TERMINALD_TMUX_BIN } from '../config.js';

const execFileAsync = promisify(execFile);

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function sanitizeSessionPart(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'term';
}

async function execTmux(args) {
  return execFileAsync(TERMINALD_TMUX_BIN, args, {
    env: process.env,
    maxBuffer: 1024 * 1024,
  });
}

export function buildTmuxSessionName(record) {
  return [
    'ccui',
    sanitizeSessionPart(record.runtime),
    sanitizeSessionPart(record.userId),
    sanitizeSessionPart(record.projectName),
    sanitizeSessionPart(record.terminalKey),
    sanitizeSessionPart(record.id),
  ].join('-');
}

async function hasTmuxSession(sessionName) {
  try {
    await execTmux(['has-session', '-t', sessionName]);
    return true;
  } catch {
    return false;
  }
}

export async function ensureLocalTerminal(record, context) {
  const tmuxSessionName = record.tmuxSessionName && !record.tmuxSessionName.endsWith('-undefined')
    ? record.tmuxSessionName
    : buildTmuxSessionName(record);
  const sessionExists = await hasTmuxSession(tmuxSessionName);

  if (!sessionExists) {
    await execTmux([
      'new-session',
      '-d',
      '-s',
      tmuxSessionName,
      '-c',
      context.projectRoot,
      TERMINALD_LOCAL_SHELL,
      '-lc',
      `cd ${shellQuote(context.projectRoot)} && exec ${TERMINALD_LOCAL_SHELL}`,
    ]);
  }

  return {
    ...record,
    tmuxSessionName,
    status: 'active',
  };
}

export function attachLocalTerminal(record, context, { cols = 120, rows = 30 } = {}) {
  const shellProcess = pty.spawn(TERMINALD_TMUX_BIN, ['attach-session', '-t', record.tmuxSessionName], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: context.projectRoot,
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'claudecliui-terminald',
    },
  });

  return {
    onOutput(listener) {
      return shellProcess.onData(listener);
    },
    onExit(listener) {
      return shellProcess.onExit(listener);
    },
    write(data) {
      shellProcess.write(data);
    },
    resize(nextCols, nextRows) {
      shellProcess.resize(nextCols, nextRows);
    },
    close() {
      try {
        shellProcess.kill();
      } catch {
        // Ignore attach-client shutdown errors.
      }
    },
  };
}

export async function closeLocalTerminal(record) {
  if (!record.tmuxSessionName) {
    return;
  }

  try {
    await execTmux(['kill-session', '-t', record.tmuxSessionName]);
  } catch {
    // Ignore already-removed sessions.
  }
}
