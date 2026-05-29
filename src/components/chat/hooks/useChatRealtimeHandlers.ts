import { useEffect, useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { PendingPermissionRequest } from '../types/types';
import type { WebSocketFeedMessage } from '../../../contexts/WebSocketContext';
import type { Project, ProjectSession, SessionProvider } from '../../../types/app';
import type { SessionStore, NormalizedMessage } from '../../../stores/useSessionStore';
import { getPendingViewSessionId, type PendingViewSession } from '../utils/pendingSession';

type LatestChatMessage = {
  type?: string;
  kind?: string;
  data?: any;
  message?: any;
  delta?: string;
  sessionId?: string;
  session_id?: string;
  requestId?: string;
  toolName?: string;
  input?: unknown;
  context?: unknown;
  error?: string;
  tool?: any;
  toolId?: string;
  result?: any;
  exitCode?: number;
  isProcessing?: boolean;
  actualSessionId?: string;
  event?: string;
  status?: any;
  isNewSession?: boolean;
  resultText?: string;
  isError?: boolean;
  success?: boolean;
  reason?: string;
  provider?: string;
  content?: string;
  text?: string;
  tokens?: number;
  canInterrupt?: boolean;
  tokenBudget?: unknown;
  newSessionId?: string;
  aborted?: boolean;
  [key: string]: any;
};

interface UseChatRealtimeHandlersArgs {
  latestMessage: LatestChatMessage | null;
  messageFeed: WebSocketFeedMessage[];
  provider: SessionProvider;
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  setCurrentSessionId: (sessionId: string | null) => void;
  setIsLoading: (loading: boolean) => void;
  setCanAbortSession: (canAbort: boolean) => void;
  setClaudeStatus: (status: { text: string; tokens: number; can_interrupt: boolean } | null) => void;
  setTokenBudget: (budget: Record<string, unknown> | null) => void;
  setPendingPermissionRequests: Dispatch<SetStateAction<PendingPermissionRequest[]>>;
  pendingViewSessionRef: MutableRefObject<PendingViewSession | null>;
  streamBufferRef: MutableRefObject<string>;
  streamTimerRef: MutableRefObject<number | null>;
  accumulatedStreamRef: MutableRefObject<string>;
  onSessionInactive?: (sessionId?: string | null) => void;
  onSessionProcessing?: (sessionId?: string | null) => void;
  onSessionNotProcessing?: (sessionId?: string | null) => void;
  wasSessionMarkedProcessingRecently?: (sessionId?: string | null, windowMs?: number) => boolean;
  wasSessionMarkedNotProcessingRecently?: (sessionId?: string | null, windowMs?: number) => boolean;
  onReplaceTemporarySession?: (sessionId?: string | null) => void;
  onNavigateToSession?: (sessionId: string) => void;
  onWebSocketReconnect?: () => void;
  sessionStore: SessionStore;
}

/* ------------------------------------------------------------------ */
/*  Hook                                                              */
/* ------------------------------------------------------------------ */

export function useChatRealtimeHandlers({
  latestMessage,
  messageFeed,
  provider,
  selectedProject,
  selectedSession,
  currentSessionId,
  setCurrentSessionId,
  setIsLoading,
  setCanAbortSession,
  setClaudeStatus,
  setTokenBudget,
  setPendingPermissionRequests,
  pendingViewSessionRef,
  streamBufferRef,
  streamTimerRef,
  accumulatedStreamRef,
  onSessionInactive,
  onSessionProcessing,
  onSessionNotProcessing,
  wasSessionMarkedProcessingRecently,
  wasSessionMarkedNotProcessingRecently,
  onReplaceTemporarySession,
  onNavigateToSession,
  onWebSocketReconnect,
  sessionStore,
}: UseChatRealtimeHandlersArgs) {
  const SESSION_STATUS_FALSE_GRACE_MS = 15_000;
  const lastProcessedMessageSequenceRef = useRef(0);
  const streamStatesRef = useRef<Map<string, {
    accumulated: string;
    provider: SessionProvider;
    timer: number | null;
  }>>(new Map());
  const terminalStateRef = useRef<Map<string, number>>(new Map());
  const projectRefreshTimeoutRef = useRef<number | null>(null);
  const lastProjectRefreshAtRef = useRef(0);

  const markSessionActive = (sessionId: string | null) => {
    if (!sessionId) {
      return;
    }

    terminalStateRef.current.delete(sessionId);
    onSessionProcessing?.(sessionId);
  };

  const markSessionTerminal = (sessionId: string | null) => {
    if (!sessionId) {
      return;
    }

    terminalStateRef.current.set(sessionId, Date.now());
  };

  const wasRecentlyCompleted = (sessionId: string | null) => {
    if (!sessionId) {
      return false;
    }

    const completedAt = terminalStateRef.current.get(sessionId);
    if (!completedAt) {
      return false;
    }

    return Date.now() - completedAt < 10_000;
  };

  const scheduleProjectRefresh = (delayMs = 150) => {
    if (!window.refreshProjectsBackground) {
      return;
    }

    const minIntervalMs = 800;
    const elapsed = Date.now() - lastProjectRefreshAtRef.current;
    const effectiveDelay =
      elapsed < minIntervalMs ? Math.max(delayMs, minIntervalMs - elapsed) : delayMs;

    if (projectRefreshTimeoutRef.current) {
      clearTimeout(projectRefreshTimeoutRef.current);
    }

    projectRefreshTimeoutRef.current = window.setTimeout(() => {
      projectRefreshTimeoutRef.current = null;
      lastProjectRefreshAtRef.current = Date.now();
      void window.refreshProjectsBackground?.();
    }, effectiveDelay);
  };

  const claimPendingSessionView = (sessionId: string | null) => {
    if (!sessionId || selectedSession?.id) {
      return false;
    }

    const hasPendingBootstrap =
      Boolean(pendingViewSessionRef.current) ||
      (typeof window !== 'undefined' && Boolean(sessionStorage.getItem('pendingSessionId')));

    if (!hasPendingBootstrap) {
      return false;
    }

    const knownPendingSessionId = getPendingViewSessionId(currentSessionId, pendingViewSessionRef.current);
    if (
      knownPendingSessionId &&
      knownPendingSessionId !== sessionId &&
      !knownPendingSessionId.startsWith('new-session-')
    ) {
      return false;
    }

    if (pendingViewSessionRef.current) {
      pendingViewSessionRef.current.sessionId = sessionId;
    }

    if (typeof window !== 'undefined') {
      sessionStorage.setItem('pendingSessionId', sessionId);
    }

    if (!currentSessionId || currentSessionId.startsWith('new-session-')) {
      setCurrentSessionId(sessionId);
      onReplaceTemporarySession?.(sessionId);
    }

    onNavigateToSession?.(sessionId);
    scheduleProjectRefresh();
    return true;
  };

  useEffect(() => {
    return () => {
      if (projectRefreshTimeoutRef.current) {
        clearTimeout(projectRefreshTimeoutRef.current);
        projectRefreshTimeoutRef.current = null;
      }
      for (const state of streamStatesRef.current.values()) {
        if (state.timer) {
          clearTimeout(state.timer);
        }
      }
      streamStatesRef.current.clear();
    };
  }, []);

  // Flush streaming buffers for sessions other than the newly selected one.
  // This prevents stale stream_delta data from a previous session from leaking
  // into the current view when switching sessions quickly.
  const prevSessionIdRef = useRef(selectedSession?.id);
  useEffect(() => {
    const prevId = prevSessionIdRef.current;
    const nextId = selectedSession?.id;
    prevSessionIdRef.current = nextId;

    if (prevId && prevId !== nextId) {
      const state = streamStatesRef.current.get(prevId);
      if (state) {
        if (state.timer) {
          clearTimeout(state.timer);
          state.timer = null;
        }
        if (state.accumulated) {
          sessionStore.updateStreaming(prevId, state.accumulated, state.provider);
        }
        sessionStore.finalizeStreaming(prevId);
        streamStatesRef.current.delete(prevId);
      }
    }
  }, [selectedSession?.id, sessionStore]);

  useEffect(() => {
    const pendingMessages = messageFeed.filter(
      (entry) => entry.sequence > lastProcessedMessageSequenceRef.current,
    );

    if (pendingMessages.length === 0) {
      return;
    }

    const activeViewSessionId =
      selectedSession?.id || getPendingViewSessionId(currentSessionId, pendingViewSessionRef.current);

    /* ---------------------------------------------------------------- */
    /*  Legacy messages (no `kind` field) — handle and return           */
    /* ---------------------------------------------------------------- */

    const processMessage = (msg: LatestChatMessage) => {
      if (!msg.kind) {
      const messageType = String(msg.type || '');

      switch (messageType) {
        case 'websocket-reconnected':
          onWebSocketReconnect?.();
          return;

        case 'pending-permissions-response': {
          const permSessionId = msg.sessionId;
          const isCurrentPermSession =
            permSessionId === currentSessionId || (selectedSession && permSessionId === selectedSession.id);
          if (permSessionId && !isCurrentPermSession) return;
          setPendingPermissionRequests(msg.data || []);
          return;
        }

        case 'error': {
          const errorSessionId =
            msg.sessionId ||
            selectedSession?.id ||
            getPendingViewSessionId(currentSessionId, pendingViewSessionRef.current);

          if (errorSessionId) {
            sessionStore.appendRealtime(errorSessionId, {
              id: `legacy_error_${Date.now()}`,
              sessionId: errorSessionId,
              timestamp: new Date().toISOString(),
              provider,
              kind: 'error',
              content: msg.error || msg.message || msg.content || 'Unknown error',
            });
          }

          onSessionInactive?.(errorSessionId);
          onSessionNotProcessing?.(errorSessionId);

          if (!errorSessionId || errorSessionId === activeViewSessionId) {
            setIsLoading(false);
            setCanAbortSession(false);
            setClaudeStatus({
              text: msg.error || msg.message || msg.content || 'Error',
              tokens: 0,
              can_interrupt: false,
            });
          }

          return;
        }

        case 'session-status': {
          const statusSessionId = msg.sessionId;
          if (!statusSessionId) return;

          const isCurrentSession =
            statusSessionId === currentSessionId || (selectedSession && statusSessionId === selectedSession.id);

          const status = msg.status;
          const wasRecentlyActivated =
            wasSessionMarkedProcessingRecently?.(statusSessionId, SESSION_STATUS_FALSE_GRACE_MS) ?? false;
          const wasRecentlyTerminal = wasRecentlyCompleted(statusSessionId);

          if (status) {
            if (!isCurrentSession || wasRecentlyTerminal) {
              return;
            }
            const statusInfo = {
              text: status.text || 'Working...',
              tokens: status.tokens || 0,
              can_interrupt: status.can_interrupt !== undefined ? status.can_interrupt : true,
            };
            setClaudeStatus(statusInfo);
            setIsLoading(true);
            setCanAbortSession(statusInfo.can_interrupt);
            return;
          }

          // Legacy isProcessing format from check-session-status
          if (msg.isProcessing) {
            if (wasRecentlyTerminal) {
              return;
            }
            onSessionProcessing?.(statusSessionId);
            if (isCurrentSession) { setIsLoading(true); setCanAbortSession(true); }
            return;
          }

          if (wasRecentlyActivated && !wasRecentlyTerminal) {
            return;
          }

          onSessionInactive?.(statusSessionId);
          onSessionNotProcessing?.(statusSessionId);
          if (isCurrentSession) {
            setIsLoading(false);
            setCanAbortSession(false);
            setClaudeStatus(null);
          }
          return;
        }

        default:
          // Unknown legacy message type — ignore
          return;
      }
      }

      /* ---------------------------------------------------------------- */
      /*  NormalizedMessage handling (has `kind` field)                    */
      /* ---------------------------------------------------------------- */

      const sid =
        typeof msg.sessionId === 'string' && msg.sessionId.trim()
          ? msg.sessionId
          : null;
      const msgProvider = (msg.provider || provider) as SessionProvider;
      const projectName = selectedSession?.__projectName || selectedProject?.name || '';
      const projectPath =
        selectedSession?.__projectPath ||
        selectedProject?.cloud?.workspacePath ||
        selectedProject?.fullPath ||
        selectedProject?.path ||
        '';
      const isActiveSession = Boolean(sid && activeViewSessionId && sid === activeViewSessionId);

      if (sid) {
        claimPendingSessionView(sid);
      }

      const flushStreamingSession = (sessionId: string, finalize = false) => {
        const state = streamStatesRef.current.get(sessionId);

        if (state?.timer) {
          clearTimeout(state.timer);
          state.timer = null;
        }

        if (state?.accumulated) {
          sessionStore.updateStreaming(sessionId, state.accumulated, state.provider);
        }

        if (finalize) {
          sessionStore.finalizeStreaming(sessionId);
          streamStatesRef.current.delete(sessionId);
        }
      };

      // --- Streaming: buffer for performance ---
      if (msg.kind === 'stream_delta') {
        const text = msg.content || '';
        if (!text || !sid) return;

        markSessionActive(sid);

        const existing = streamStatesRef.current.get(sid) || {
          accumulated: '',
          provider: msgProvider,
          timer: null,
        };

        existing.accumulated += text;
        existing.provider = msgProvider;

        if (!existing.timer) {
          existing.timer = window.setTimeout(() => {
            const latestState = streamStatesRef.current.get(sid);
            if (!latestState) {
              return;
            }

            latestState.timer = null;
            if (latestState.accumulated) {
              sessionStore.updateStreaming(sid, latestState.accumulated, latestState.provider);
            }
          }, 100);
        }

        streamStatesRef.current.set(sid, existing);
        return;
      }

      if (msg.kind === 'stream_end') {
        if (sid) {
          flushStreamingSession(sid, true);
        }
        return;
      }

      // --- All other messages: route to store ---
      if (sid) {
        sessionStore.appendRealtime(sid, msg as NormalizedMessage);
      }

      // --- UI side effects for specific kinds ---
      switch (msg.kind) {
        case 'session_created': {
          const newSessionId = msg.newSessionId;
          if (!newSessionId) break;

          if (!currentSessionId || currentSessionId.startsWith('new-session-')) {
            if (typeof window !== 'undefined') {
              sessionStorage.setItem('pendingSessionId', newSessionId);
            }
            if (pendingViewSessionRef.current && !pendingViewSessionRef.current.sessionId) {
              pendingViewSessionRef.current.sessionId = newSessionId;
            }
            setCurrentSessionId(newSessionId);
            onReplaceTemporarySession?.(newSessionId);
            setPendingPermissionRequests((prev) =>
              prev.map((r) => (r.sessionId ? r : { ...r, sessionId: newSessionId })),
            );
          }
          markSessionActive(newSessionId);
          onNavigateToSession?.(newSessionId);
          scheduleProjectRefresh();
          break;
        }

      case 'complete': {
        if (sid) {
          flushStreamingSession(sid, true);
          setPendingPermissionRequests((prev) => prev.filter((request) => request.sessionId !== sid));
        }

        markSessionTerminal(sid);
        onSessionInactive?.(sid);
        onSessionNotProcessing?.(sid);

        if (isActiveSession) {
          setIsLoading(false);
          setCanAbortSession(false);
          setClaudeStatus(null);
        }

        // Handle aborted case
        if (msg.aborted) {
          // Abort was requested — the complete event confirms it
          // No special UI action needed beyond clearing loading state above
          // The backend already sent any abort-related messages
          break;
        }

        if (sid && msg.actualSessionId && msg.actualSessionId !== sid) {
          const actualId = msg.actualSessionId;

          if (!pendingViewSessionRef.current || pendingViewSessionRef.current.sessionId === sid) {
            pendingViewSessionRef.current = {
              sessionId: actualId,
              startedAt: pendingViewSessionRef.current?.startedAt || Date.now(),
            };
          }

          setCurrentSessionId(actualId);
          onReplaceTemporarySession?.(actualId);
          onNavigateToSession?.(actualId);
          sessionStorage.removeItem('pendingSessionId');

          if (selectedProject) {
            void sessionStore.refreshFromServer(actualId, {
              provider: msgProvider,
              projectName,
              projectPath,
            });
          }

          scheduleProjectRefresh(200);
          break;
        }

        // Clear pending session
        const pendingSessionId = sessionStorage.getItem('pendingSessionId');
        if (pendingSessionId && !currentSessionId && msg.exitCode === 0) {
          const actualId = msg.actualSessionId || pendingSessionId;
          setCurrentSessionId(actualId);
          if (msg.actualSessionId) {
            onNavigateToSession?.(actualId);
          }
          sessionStorage.removeItem('pendingSessionId');
          scheduleProjectRefresh(500);
        }
        break;
      }

      case 'error': {
        if (sid) {
          flushStreamingSession(sid, true);
          setPendingPermissionRequests((prev) => prev.filter((request) => request.sessionId !== sid));
        }
        markSessionTerminal(sid);
        onSessionInactive?.(sid);
        onSessionNotProcessing?.(sid);
        if (isActiveSession) {
          setIsLoading(false);
          setCanAbortSession(false);
          setClaudeStatus(null);
        }
        break;
      }

      case 'permission_request': {
        const requestId = msg.requestId;
        if (!requestId) break;
        setPendingPermissionRequests((prev) => {
          if (prev.some((r: PendingPermissionRequest) => r.requestId === requestId)) return prev;
          return [...prev, {
            requestId,
            toolName: msg.toolName || 'UnknownTool',
            input: msg.input,
            context: msg.context,
            provider: msg.provider || provider,
            sessionId: sid || null,
            receivedAt: new Date(),
          }];
        });
        markSessionActive(sid);
        if (isActiveSession) {
          setIsLoading(true);
          setCanAbortSession(true);
          setClaudeStatus({ text: 'Waiting for permission', tokens: 0, can_interrupt: true });
        }
        break;
      }

      case 'permission_cancelled': {
        if (msg.requestId) {
          setPendingPermissionRequests((prev) => prev.filter((r: PendingPermissionRequest) => r.requestId !== msg.requestId));
        }
        break;
      }

      case 'status': {
        if (msg.text === 'token_budget' && msg.tokenBudget && isActiveSession) {
          setTokenBudget(msg.tokenBudget as Record<string, unknown>);
        } else if (msg.text && isActiveSession) {
          if (wasRecentlyCompleted(sid)) {
            break;
          }

          markSessionActive(sid);
          setClaudeStatus({
            text: msg.text,
            tokens: msg.tokens || 0,
            can_interrupt: msg.canInterrupt !== undefined ? msg.canInterrupt : true,
          });
          setIsLoading(true);
          setCanAbortSession(msg.canInterrupt !== false);
        }
        break;
      }

      // text, tool_use, tool_result, thinking, interactive_prompt, task_notification
      // → already routed to store above, no UI side effects needed
        default:
          break;
      }
    };

    for (const entry of pendingMessages) {
      lastProcessedMessageSequenceRef.current = entry.sequence;
      processMessage(entry.message as LatestChatMessage);
    }
  }, [
    latestMessage,
    messageFeed,
    provider,
    selectedProject,
    selectedSession,
    currentSessionId,
    setCurrentSessionId,
    setIsLoading,
    setCanAbortSession,
    setClaudeStatus,
    setTokenBudget,
    setPendingPermissionRequests,
    pendingViewSessionRef,
    streamBufferRef,
    streamTimerRef,
    accumulatedStreamRef,
    onSessionInactive,
    onSessionProcessing,
    onSessionNotProcessing,
    wasSessionMarkedProcessingRecently,
    wasSessionMarkedNotProcessingRecently,
    onReplaceTemporarySession,
    onNavigateToSession,
    onWebSocketReconnect,
    sessionStore,
  ]);
}
