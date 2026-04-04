import { IS_PLATFORM } from '../../../constants/config';
import type { ShellIncomingMessage, ShellOutgoingMessage } from '../types/types';

function resolveTerminaldPort(): string {
  const explicitPort = import.meta.env.VITE_TERMINALD_PORT;
  if (explicitPort) {
    return String(explicitPort);
  }

  const currentPort = Number.parseInt(window.location.port || '', 10);
  if (Number.isInteger(currentPort) && currentPort > 0) {
    if (currentPort >= 5100 && currentPort <= 5199) {
      return '3112';
    }

    return String(currentPort + 1);
  }

  return '3112';
}

function buildWsUrl(pathname: string, { useTerminald = false } = {}): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = useTerminald
    ? `${window.location.hostname}:${resolveTerminaldPort()}`
    : window.location.host;

  return `${protocol}//${host}${pathname}`;
}

export function getShellWebSocketUrl(options: { projectTerminal?: boolean } = {}): string | null {
  const { projectTerminal = false } = options;
  const basePath = projectTerminal ? '/ws/project-terminal' : '/shell';

  if (IS_PLATFORM) {
    return buildWsUrl(basePath, { useTerminald: projectTerminal });
  }

  const token = localStorage.getItem('auth-token');
  if (!token) {
    console.error('No authentication token found for Shell WebSocket connection');
    return null;
  }

  return `${buildWsUrl(basePath, { useTerminald: projectTerminal })}?token=${encodeURIComponent(token)}`;
}

export function parseShellMessage(payload: string): ShellIncomingMessage | null {
  try {
    return JSON.parse(payload) as ShellIncomingMessage;
  } catch {
    return null;
  }
}

export function sendSocketMessage(ws: WebSocket | null, message: ShellOutgoingMessage): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}
