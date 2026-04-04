import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../components/auth/context/AuthContext';
import { IS_PLATFORM } from '../constants/config';

export type WebSocketFeedMessage = {
  sequence: number;
  receivedAt: number;
  message: any;
};

export type MessageChannelHandler = (message: any, sequence: number) => void;

type MessageChannel = {
  id: string;
  filter: (message: any) => boolean;
  handler: MessageChannelHandler;
};

type WebSocketContextType = {
  ws: WebSocket | null;
  sendMessage: (message: any) => void;
  latestMessage: any | null;
  messageFeed: WebSocketFeedMessage[];
  isConnected: boolean;
  subscribeChannel: (channel: MessageChannel) => () => void;
};

const MAX_MESSAGE_FEED = 500;
const MAX_PENDING_OUTBOUND_MESSAGES = 100;
const BACKGROUND_RECONNECT_THRESHOLD_MS = 5_000;
const WEBSOCKET_LOG_PREFIX = '[WebSocket]';

const WebSocketContext = createContext<WebSocketContextType | null>(null);

export const useWebSocket = () => {
  const context = useContext(WebSocketContext);
  if (!context) {
    throw new Error('useWebSocket must be used within a WebSocketProvider');
  }
  return context;
};

const buildWebSocketUrl = (token: string | null) => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  if (IS_PLATFORM) return `${protocol}//${window.location.host}/ws`; // Platform mode: Use same domain as the page (goes through proxy)
  if (!token) return null;
  return `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`; // OSS mode: Use same host:port that served the page
};

const sanitizeWebSocketUrl = (value: string | null) => {
  if (!value) {
    return null;
  }

  try {
    const url = new URL(value);
    if (url.searchParams.has('token')) {
      url.searchParams.set('token', 'redacted');
    }
    return url.toString();
  } catch {
    return value.replace(/token=[^&]+/, 'token=redacted');
  }
};

const formatReadyState = (readyState: number | undefined | null) => {
  switch (readyState) {
    case WebSocket.CONNECTING:
      return 'CONNECTING';
    case WebSocket.OPEN:
      return 'OPEN';
    case WebSocket.CLOSING:
      return 'CLOSING';
    case WebSocket.CLOSED:
      return 'CLOSED';
    default:
      return 'UNINITIALIZED';
  }
};

const describeSocket = (socket: WebSocket | null) => ({
  hasSocket: Boolean(socket),
  readyState: formatReadyState(socket?.readyState),
});

const summarizeSocketMessage = (message: any) => {
  if (!message || typeof message !== 'object') {
    return {
      primitive: String(message),
    };
  }

  const summary = {
    type: typeof message.type === 'string' ? message.type : undefined,
    kind: typeof message.kind === 'string' ? message.kind : undefined,
    sessionId:
      typeof message.sessionId === 'string'
        ? message.sessionId
        : typeof message.session_id === 'string'
          ? message.session_id
          : undefined,
    requestId: typeof message.requestId === 'string' ? message.requestId : undefined,
    isProcessing: typeof message.isProcessing === 'boolean' ? message.isProcessing : undefined,
    hasDelta: typeof message.delta === 'string' && message.delta.length > 0 ? true : undefined,
    hasContent:
      typeof message.content === 'string' && message.content.length > 0
        ? true
        : typeof message.text === 'string' && message.text.length > 0
          ? true
          : undefined,
  };

  return Object.fromEntries(
    Object.entries(summary).filter(([, current]) => current !== undefined),
  );
};

const shouldLogInboundMessage = (message: any) => {
  const marker = String(message?.kind || message?.type || '');
  if (!marker) {
    return false;
  }

  return !new Set(['stream_delta', 'assistant_stream_delta', 'output_delta', 'delta']).has(marker);
};

const useWebSocketProviderState = (): WebSocketContextType => {
  const wsRef = useRef<WebSocket | null>(null);
  const unmountedRef = useRef(false);
  const hasConnectedRef = useRef(false);
  const connectionAttemptRef = useRef(0);
  const pendingOutboundMessagesRef = useRef<string[]>([]);
  const previousTokenRef = useRef<string | null | undefined>(undefined);
  const messageSequenceRef = useRef(0);
  const [latestMessage, setLatestMessage] = useState<any>(null);
  const [messageFeed, setMessageFeed] = useState<WebSocketFeedMessage[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastHiddenAtRef = useRef<number | null>(null);
  const { token } = useAuth();

  const channelsRef = useRef<Map<string, MessageChannel>>(new Map());

  const subscribeChannel = useCallback((channel: MessageChannel) => {
    channelsRef.current.set(channel.id, channel);
    return () => { channelsRef.current.delete(channel.id); };
  }, []);

  const pushMessage = useCallback((message: any) => {
    const seq = ++messageSequenceRef.current;
    const entry: WebSocketFeedMessage = {
      sequence: seq,
      receivedAt: Date.now(),
      message,
    };

    if (shouldLogInboundMessage(message)) {
      console.debug(`${WEBSOCKET_LOG_PREFIX} Received message`, {
        sequence: seq,
        ...summarizeSocketMessage(message),
      });
    }

    // Dispatch to channels first (sync, before React state update batching)
    for (const channel of channelsRef.current.values()) {
      try {
        if (channel.filter(message)) {
          channel.handler(message, seq);
        }
      } catch (err) {
        console.error(`[WS channel ${channel.id}] handler error:`, err);
      }
    }

    setLatestMessage(message);
    setMessageFeed((previous) => {
      const next = [...previous, entry];
      return next.length > MAX_MESSAGE_FEED
        ? next.slice(next.length - MAX_MESSAGE_FEED)
        : next;
    });
  }, []);

  const flushPendingOutboundMessages = useCallback((socket: WebSocket) => {
    if (socket.readyState !== WebSocket.OPEN || pendingOutboundMessagesRef.current.length === 0) {
      return;
    }

    const queuedMessages = [...pendingOutboundMessagesRef.current];
    pendingOutboundMessagesRef.current = [];

    console.info(`${WEBSOCKET_LOG_PREFIX} Flushing queued outbound messages`, {
      queuedCount: queuedMessages.length,
    });

    for (const rawMessage of queuedMessages) {
      socket.send(rawMessage);
    }
  }, []);

  useEffect(() => {
    unmountedRef.current = false;

    if (previousTokenRef.current !== token) {
      const clearedMessages = pendingOutboundMessagesRef.current.length;
      pendingOutboundMessagesRef.current = [];
      console.info(`${WEBSOCKET_LOG_PREFIX} Auth token changed`, {
        hadPreviousToken: Boolean(previousTokenRef.current),
        hasToken: Boolean(token),
        clearedQueuedMessages: clearedMessages,
      });
      hasConnectedRef.current = false;
      previousTokenRef.current = token;
    }

    connect();
    
    return () => {
      unmountedRef.current = true;
      console.info(`${WEBSOCKET_LOG_PREFIX} Provider cleanup`, {
        hasSocket: Boolean(wsRef.current),
        queuedCount: pendingOutboundMessagesRef.current.length,
      });
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      const socket = wsRef.current;
      wsRef.current = null;
      if (socket && socket.readyState < WebSocket.CLOSING) {
        console.info(`${WEBSOCKET_LOG_PREFIX} Cleanup closing active socket`, {
          ...describeSocket(socket),
        });
        socket.close();
      }
    };
  }, [token]); // everytime token changes, we reconnect

  const connect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    if (unmountedRef.current) {
      console.info(`${WEBSOCKET_LOG_PREFIX} Skipping connect because provider is marked unmounted`);
      return;
    }
    try {
      const attempt = ++connectionAttemptRef.current;
      // Construct WebSocket URL
      const wsUrl = buildWebSocketUrl(token);

      if (!wsUrl) {
        console.warn(`${WEBSOCKET_LOG_PREFIX} No authentication token found for WebSocket connection`, {
          attempt,
          hasToken: Boolean(token),
        });
        return;
      }

      console.info(`${WEBSOCKET_LOG_PREFIX} Connecting`, {
        attempt,
        url: sanitizeWebSocketUrl(wsUrl),
        queuedCount: pendingOutboundMessagesRef.current.length,
      });
      
      const websocket = new WebSocket(wsUrl);
      wsRef.current = websocket;

      websocket.onopen = () => {
        if (wsRef.current !== websocket) {
          console.info(`${WEBSOCKET_LOG_PREFIX} Ignoring stale open event`, {
            attempt,
            ...describeSocket(websocket),
          });
          return;
        }

        setIsConnected(true);
        console.info(`${WEBSOCKET_LOG_PREFIX} Connected`, {
          attempt,
          queuedCount: pendingOutboundMessagesRef.current.length,
        });
        flushPendingOutboundMessages(websocket);
        if (hasConnectedRef.current) {
          // This is a reconnect — signal so components can catch up on missed messages
          pushMessage({ type: 'websocket-reconnected', timestamp: Date.now() });
        }
        hasConnectedRef.current = true;
      };

      websocket.onmessage = (event) => {
        if (wsRef.current !== websocket) {
          console.info(`${WEBSOCKET_LOG_PREFIX} Ignoring stale message event`, {
            attempt,
            ...describeSocket(websocket),
          });
          return;
        }

        try {
          const data = JSON.parse(event.data);
          pushMessage(data);
        } catch (error) {
          console.error('Error parsing WebSocket message:', error);
        }
      };

      websocket.onclose = (event) => {
        if (wsRef.current !== websocket) {
          console.info(`${WEBSOCKET_LOG_PREFIX} Ignoring stale close event`, {
            attempt,
            code: event.code,
            reason: event.reason,
            wasClean: event.wasClean,
            ...describeSocket(websocket),
          });
          return;
        }

        setIsConnected(false);
        wsRef.current = null;

        console.warn(`${WEBSOCKET_LOG_PREFIX} Closed`, {
          attempt,
          code: event.code,
          reason: event.reason,
          wasClean: event.wasClean,
          readyState: formatReadyState(websocket.readyState),
          queuedCount: pendingOutboundMessagesRef.current.length,
        });

        if (unmountedRef.current) {
          console.info(`${WEBSOCKET_LOG_PREFIX} Not scheduling reconnect because provider is cleaning up`, {
            attempt,
          });
          return;
        }
        
        // Attempt to reconnect after 3 seconds
        reconnectTimeoutRef.current = setTimeout(() => {
          if (unmountedRef.current) return; // Prevent reconnection if unmounted
          console.info(`${WEBSOCKET_LOG_PREFIX} Reconnecting after close`, { attempt });
          connect();
        }, 3000);
      };

      websocket.onerror = (error) => {
        if (wsRef.current !== websocket) {
          console.info(`${WEBSOCKET_LOG_PREFIX} Ignoring stale error event`, {
            attempt,
            ...describeSocket(websocket),
          });
          return;
        }

        console.error(`${WEBSOCKET_LOG_PREFIX} Error`, {
          attempt,
          readyState: formatReadyState(websocket.readyState),
          error,
        });
      };

    } catch (error) {
      console.error(`${WEBSOCKET_LOG_PREFIX} Error creating connection`, error);
    }
  }, [flushPendingOutboundMessages, pushMessage, token]); // everytime token changes, we reconnect

  const forceReconnect = useCallback((reason: string) => {
    if (unmountedRef.current) {
      return;
    }

    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    const socket = wsRef.current;
    wsRef.current = null;
    setIsConnected(false);

    console.info(`${WEBSOCKET_LOG_PREFIX} Forcing reconnect`, {
      reason,
      ...describeSocket(socket),
      queuedCount: pendingOutboundMessagesRef.current.length,
    });

    if (socket && socket.readyState < WebSocket.CLOSING) {
      try {
        socket.close(4000, reason);
      } catch {
        socket.close();
      }
    }

    connect();
  }, [connect]);

  useEffect(() => {
    const resumeConnection = (source: string, force = false) => {
      const hiddenAt = lastHiddenAtRef.current;
      const hiddenDuration = hiddenAt === null ? 0 : Date.now() - hiddenAt;
      const shouldForceReconnect = force || hiddenDuration >= BACKGROUND_RECONNECT_THRESHOLD_MS;
      lastHiddenAtRef.current = null;

      if (shouldForceReconnect) {
        forceReconnect(`${source}-resume`);
        return;
      }

      const socket = wsRef.current;
      const readyState = socket?.readyState;
      if (!socket || (readyState !== WebSocket.OPEN && readyState !== WebSocket.CONNECTING)) {
        console.info(`${WEBSOCKET_LOG_PREFIX} Reconnecting after foreground/network resume`, {
          source,
          hiddenDuration,
          ...describeSocket(socket),
        });
        connect();
      }
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
  }, [connect, forceReconnect]);

  const sendMessage = useCallback((message: any) => {
    const socket = wsRef.current;
    const rawMessage = JSON.stringify(message);
    const messageSummary = summarizeSocketMessage(message);
    if (socket && socket.readyState === WebSocket.OPEN) {
      console.debug(`${WEBSOCKET_LOG_PREFIX} Sending outbound message`, {
        ...messageSummary,
        readyState: formatReadyState(socket.readyState),
      });
      socket.send(rawMessage);
    } else {
      pendingOutboundMessagesRef.current = [
        ...pendingOutboundMessagesRef.current,
        rawMessage,
      ].slice(-MAX_PENDING_OUTBOUND_MESSAGES);
      console.warn(`${WEBSOCKET_LOG_PREFIX} WebSocket not connected; queued outbound message`, {
        ...messageSummary,
        readyState: formatReadyState(socket?.readyState),
        queuedCount: pendingOutboundMessagesRef.current.length,
      });
    }
  }, []);

  const value: WebSocketContextType = useMemo(() =>
  ({
    ws: wsRef.current,
    sendMessage,
    latestMessage,
    messageFeed,
    isConnected,
    subscribeChannel,
  }), [sendMessage, latestMessage, messageFeed, isConnected, subscribeChannel]);

  return value;
};

export const WebSocketProvider = ({ children }: { children: React.ReactNode }) => {
  const webSocketData = useWebSocketProviderState();
  
  return (
    <WebSocketContext.Provider value={webSocketData}>
      {children}
    </WebSocketContext.Provider>
  );
};

export default WebSocketContext;
