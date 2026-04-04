import os from 'os';
import pty from 'node-pty';
import { WebSocket } from 'ws';

function getDefaultShell() {
  if (process.platform === 'win32') {
    return 'powershell.exe';
  }

  return process.env.SHELL || '/bin/bash';
}

function safeSend(ws, message, openState = WebSocket.OPEN) {
  if (!ws || ws.readyState !== openState) {
    return;
  }

  ws.send(typeof message === 'string' ? message : JSON.stringify(message));
}

function parseIncomingMessage(rawData) {
  const text = Buffer.isBuffer(rawData) ? rawData.toString('utf8') : String(rawData ?? '');
  if (!text) {
    return { text, json: null };
  }

  if (text.charCodeAt(0) !== 123) {
    return { text, json: null };
  }

  try {
    return { text, json: JSON.parse(text) };
  } catch {
    return { text, json: null };
  }
}

export function handleWebTerminalFallbackConnection(ws, options = {}) {
  const {
    createSessionId = () => `wt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    defaultCwd = process.env.HOME || os.homedir(),
    defaultShell = getDefaultShell(),
    env = process.env,
    ptyModule = pty,
    openState = WebSocket.OPEN,
    logger = console,
  } = options;

  const sessionId = createSessionId();
  let shellProcess = null;
  let isClosed = false;

  try {
    shellProcess = ptyModule.spawn(defaultShell, [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: defaultCwd,
      env: {
        ...env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        TERM_PROGRAM: 'web-terminal',
      },
    });
  } catch (error) {
    safeSend(ws, {
      type: 'error',
      message: `Failed to spawn shell: ${error instanceof Error ? error.message : String(error)}`,
    }, openState);

    if (typeof ws.close === 'function') {
      ws.close(1011, 'spawn failed');
    }

    return { sessionId, shellProcess: null };
  }

  safeSend(ws, {
    type: 'ready',
    sessionId,
    shell: defaultShell,
    cwd: defaultCwd,
    fallback: true,
  }, openState);

  shellProcess.onData((chunk) => {
    if (typeof shellProcess.pause === 'function') {
      shellProcess.pause();
    }

    const resume = () => {
      if (typeof shellProcess.resume === 'function') {
        shellProcess.resume();
      }
    };

    if (ws.readyState === openState) {
      try {
        ws.send(chunk, resume);
      } catch (error) {
        logger.warn?.('[web-terminal] Failed to stream shell output:', error);
        resume();
      }
    } else {
      resume();
    }
  });

  shellProcess.onExit(({ exitCode, signal } = {}) => {
    if (isClosed) {
      return;
    }

    safeSend(ws, {
      type: 'exit',
      sessionId,
      exitCode: exitCode ?? 0,
      signal,
    }, openState);

    if (ws.readyState === openState && typeof ws.close === 'function') {
      ws.close(1000, 'shell exited');
    }
  });

  ws.on('message', (rawData) => {
    if (!shellProcess) {
      return;
    }

    const { text, json } = parseIncomingMessage(rawData);

    if (json?.type === 'input' && typeof json.data === 'string') {
      shellProcess.write(json.data);
      return;
    }

    if (json?.type === 'resize') {
      const cols = Math.max(1, Math.min(Number(json.cols) || 80, 500));
      const rows = Math.max(1, Math.min(Number(json.rows) || 24, 200));
      shellProcess.resize(cols, rows);
      return;
    }

    if (json?.type === 'ping') {
      safeSend(ws, { type: 'pong', sessionId }, openState);
      return;
    }

    if (text) {
      shellProcess.write(text);
    }
  });

  const closeShell = () => {
    if (isClosed) {
      return;
    }

    isClosed = true;

    try {
      shellProcess?.kill();
    } catch {
      // Ignore PTY shutdown errors.
    }
  };

  ws.on('close', closeShell);
  ws.on('error', (error) => {
    logger.warn?.('[web-terminal] Client socket error:', error);
    closeShell();
  });

  return { sessionId, shellProcess };
}
