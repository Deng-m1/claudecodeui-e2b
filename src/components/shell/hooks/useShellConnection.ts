import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';
import type { Project, ProjectSession } from '../../../types/app';
import { TERMINAL_INIT_DELAY_MS } from '../constants/constants';
import { getShellWebSocketUrl, parseShellMessage, sendSocketMessage } from '../utils/socket';

const ANSI_ESCAPE_REGEX =
  /(?:\u001B\[[0-?]*[ -/]*[@-~]|\u009B[0-?]*[ -/]*[@-~]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)|\u009D[^\u0007\u009C]*(?:\u0007|\u009C)|\u001B[PX^_][^\u001B]*\u001B\\|[\u0090\u0098\u009E\u009F][^\u009C]*\u009C|\u001B[@-Z\\-_])/g;
const PROCESS_EXIT_REGEX = /Process exited with code (\d+)/;
const SHELL_BACKGROUND_RECONNECT_THRESHOLD_MS = 5_000;

type UseShellConnectionOptions = {
  wsRef: MutableRefObject<WebSocket | null>;
  terminalRef: MutableRefObject<Terminal | null>;
  fitAddonRef: MutableRefObject<FitAddon | null>;
  selectedProjectRef: MutableRefObject<Project | null | undefined>;
  selectedSessionRef: MutableRefObject<ProjectSession | null | undefined>;
  initialCommandRef: MutableRefObject<string | null | undefined>;
  isPlainShellRef: MutableRefObject<boolean>;
  isActiveRef: MutableRefObject<boolean>;
  onProcessCompleteRef: MutableRefObject<((exitCode: number) => void) | null | undefined>;
  isInitialized: boolean;
  autoConnect: boolean;
  closeSocket: () => void;
  clearTerminalScreen: () => void;
  setAuthUrl: (nextAuthUrl: string) => void;
  onOutputRef?: MutableRefObject<(() => void) | null>;
};

type UseShellConnectionResult = {
  isConnected: boolean;
  isConnecting: boolean;
  closeSocket: () => void;
  connectToShell: () => void;
  disconnectFromShell: () => void;
};

export function useShellConnection({
  wsRef,
  terminalRef,
  fitAddonRef,
  selectedProjectRef,
  selectedSessionRef,
  initialCommandRef,
  isPlainShellRef,
  isActiveRef,
  onProcessCompleteRef,
  isInitialized,
  autoConnect,
  closeSocket,
  clearTerminalScreen,
  setAuthUrl,
  onOutputRef,
}: UseShellConnectionOptions): UseShellConnectionResult {
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const connectingRef = useRef(false);
  const lastHiddenAtRef = useRef<number | null>(null);

  const handleProcessCompletion = useCallback(
    (output: string) => {
      if (!isPlainShellRef.current || !onProcessCompleteRef.current) {
        return;
      }

      const sanitizedOutput = output.replace(ANSI_ESCAPE_REGEX, '');
      const cleanOutput = sanitizedOutput;
      if (cleanOutput.includes('Process exited with code 0')) {
        onProcessCompleteRef.current(0);
        return;
      }

      const match = cleanOutput.match(PROCESS_EXIT_REGEX);
      if (!match) {
        return;
      }

      const exitCode = Number.parseInt(match[1], 10);
      if (!Number.isNaN(exitCode) && exitCode !== 0) {
        onProcessCompleteRef.current(exitCode);
      }
    },
    [isPlainShellRef, onProcessCompleteRef],
  );

  const handleSocketMessage = useCallback(
    (rawPayload: string) => {
      const message = parseShellMessage(rawPayload);
      if (!message) {
        console.error('[Shell] Error handling WebSocket message:', rawPayload);
        return;
      }

      if (message.type === 'output') {
        const output = typeof message.data === 'string' ? message.data : '';
        handleProcessCompletion(output);
        terminalRef.current?.write(output);
        onOutputRef?.current?.();
        return;
      }

      if (message.type === 'auth_url' || message.type === 'url_open') {
        const nextAuthUrl = typeof message.url === 'string' ? message.url : '';
        if (nextAuthUrl) {
          setAuthUrl(nextAuthUrl);
        }
      }
    },
    [handleProcessCompletion, onOutputRef, setAuthUrl, terminalRef],
  );

  const connectWebSocket = useCallback(
    (isConnectionLocked = false) => {
      if ((connectingRef.current && !isConnectionLocked) || isConnecting || isConnected) {
        return;
      }

      try {
        const currentProject = selectedProjectRef.current;
        const currentSession = selectedSessionRef.current;
        const projectUsesE2B =
          currentProject?.runtime === 'e2b' ||
          Boolean(currentProject?.cloud?.sandboxId) ||
          String(currentProject?.name || '').startsWith('e2b__');
        const useTerminaldTransport =
          !isPlainShellRef.current && (!currentSession || currentSession.__runtime === 'e2b' || projectUsesE2B);
        const wsUrl = getShellWebSocketUrl({ projectTerminal: useTerminaldTransport });
        if (!wsUrl) {
          connectingRef.current = false;
          setIsConnecting(false);
          return;
        }

        connectingRef.current = true;

        const socket = new WebSocket(wsUrl);
        wsRef.current = socket;

        socket.onopen = () => {
          setIsConnected(true);
          setIsConnecting(false);
          connectingRef.current = false;
          setAuthUrl('');

          window.setTimeout(() => {
            const currentTerminal = terminalRef.current;
            const currentFitAddon = fitAddonRef.current;
            const currentProject = selectedProjectRef.current;
            if (!currentTerminal || !currentFitAddon || !currentProject) {
              return;
            }

            currentFitAddon.fit();

            const terminalKey =
              !isPlainShellRef.current &&
              currentSession?.id &&
              (currentSession.__runtime === 'e2b' || projectUsesE2B)
                ? `session:${currentSession.id}`
                : null;

            sendSocketMessage(socket, {
              type: 'init',
              projectName: currentProject.name,
              projectPath: currentProject.fullPath || currentProject.path || '',
              projectRuntime: currentProject.runtime || 'local',
              sessionId: isPlainShellRef.current ? null : currentSession?.id || null,
              hasSession: isPlainShellRef.current ? false : Boolean(currentSession),
              provider: isPlainShellRef.current ? 'plain-shell' : (currentSession?.__provider || localStorage.getItem('selected-provider') || 'claude'),
              terminalKey,
              cols: currentTerminal.cols,
              rows: currentTerminal.rows,
              initialCommand: initialCommandRef.current,
              isPlainShell: isPlainShellRef.current,
            });
          }, TERMINAL_INIT_DELAY_MS);
        };

        socket.onmessage = (event) => {
          const rawPayload = typeof event.data === 'string' ? event.data : String(event.data ?? '');
          handleSocketMessage(rawPayload);
        };

        socket.onclose = () => {
          setIsConnected(false);
          setIsConnecting(false);
          connectingRef.current = false;
          clearTerminalScreen();
        };

        socket.onerror = () => {
          setIsConnected(false);
          setIsConnecting(false);
          connectingRef.current = false;
        };
      } catch {
        setIsConnected(false);
        setIsConnecting(false);
        connectingRef.current = false;
      }
    },
    [
      clearTerminalScreen,
      fitAddonRef,
      handleSocketMessage,
      initialCommandRef,
      isConnected,
      isConnecting,
      isPlainShellRef,
      selectedProjectRef,
      selectedSessionRef,
      setAuthUrl,
      terminalRef,
      wsRef,
    ],
  );

  const connectToShell = useCallback(() => {
    if (!isInitialized || isConnected || isConnecting || connectingRef.current) {
      return;
    }

    connectingRef.current = true;
    setIsConnecting(true);
    connectWebSocket(true);
  }, [connectWebSocket, isConnected, isConnecting, isInitialized]);

  const disconnectFromShell = useCallback(() => {
    closeSocket();
    clearTerminalScreen();
    setIsConnected(false);
    setIsConnecting(false);
    connectingRef.current = false;
    setAuthUrl('');
  }, [clearTerminalScreen, closeSocket, setAuthUrl]);

  const reconnectShell = useCallback((reason: string, force = false) => {
    if (!isInitialized) {
      return;
    }

    const socket = wsRef.current;
    const readyState = socket?.readyState;
    const shouldMaintainConnection = autoConnect || isConnected || isConnecting || Boolean(socket);

    if (!shouldMaintainConnection) {
      return;
    }

    if (!force && readyState !== undefined && (readyState === WebSocket.OPEN || readyState === WebSocket.CONNECTING)) {
      return;
    }

    if (socket) {
      wsRef.current = null;
      if (socket.readyState < WebSocket.CLOSING) {
        try {
          socket.close(4000, reason);
        } catch {
          socket.close();
        }
      }
    }

    clearTerminalScreen();
    setIsConnected(false);
    setIsConnecting(true);
    connectingRef.current = true;
    setAuthUrl('');
    connectWebSocket(true);
  }, [autoConnect, clearTerminalScreen, connectWebSocket, isConnected, isConnecting, isInitialized, setAuthUrl, wsRef]);

  useEffect(() => {
    const resumeConnection = (source: string, force = false) => {
      if (!isActiveRef.current) {
        return;
      }

      const hiddenAt = lastHiddenAtRef.current;
      const hiddenDuration = hiddenAt === null ? 0 : Date.now() - hiddenAt;
      const shouldForceReconnect = force || hiddenDuration >= SHELL_BACKGROUND_RECONNECT_THRESHOLD_MS;
      lastHiddenAtRef.current = null;

      if (shouldForceReconnect) {
        reconnectShell(`${source}-resume`, true);
        return;
      }

      reconnectShell(`${source}-resume`);
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        lastHiddenAtRef.current = Date.now();
        return;
      }

      resumeConnection('visibilitychange');
    };

    const handlePageShow = (event: PageTransitionEvent) => {
      resumeConnection('pageshow', Boolean(event.persisted));
    };

    const handleFocus = () => {
      if (document.visibilityState === 'hidden') {
        return;
      }

      resumeConnection('focus');
    };

    const handleOnline = () => {
      resumeConnection('online');
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pageshow', handlePageShow);
    window.addEventListener('focus', handleFocus);
    window.addEventListener('online', handleOnline);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pageshow', handlePageShow);
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener('online', handleOnline);
    };
  }, [isActiveRef, reconnectShell]);

  useEffect(() => {
    if (!autoConnect || !isInitialized || isConnecting || isConnected) {
      return;
    }

    connectToShell();
  }, [autoConnect, connectToShell, isConnected, isConnecting, isInitialized]);

  return {
    isConnected,
    isConnecting,
    closeSocket,
    connectToShell,
    disconnectFromShell,
  };
}
