function extractSessionId(data) {
  if (!data) {
    return null;
  }

  if (typeof data === 'string') {
    try {
      const parsed = JSON.parse(data);
      return typeof parsed?.sessionId === 'string' && parsed.sessionId ? parsed.sessionId : null;
    } catch {
      return null;
    }
  }

  if (typeof data === 'object' && typeof data.sessionId === 'string' && data.sessionId) {
    return data.sessionId;
  }

  return null;
}

function canInjectSessionId(data) {
  return Boolean(data && typeof data === 'object' && !Array.isArray(data));
}

class BoundSessionWriter {
  constructor(transport, sessionId = null) {
    this.transport = transport;
    this.sessionId = sessionId;
    this.userId = transport.userId;
    this.isWebSocketWriter = Boolean(transport.isWebSocketWriter);
    this.isSSEStreamWriter = Boolean(transport.isSSEStreamWriter);
  }

  send(data) {
    let payload = data;
    const observedSessionId = extractSessionId(payload);

    if (!observedSessionId && this.sessionId && canInjectSessionId(payload)) {
      payload = {
        ...payload,
        sessionId: this.sessionId,
      };
    }

    const payloadSessionId = extractSessionId(payload) || this.sessionId;
    if (payloadSessionId) {
      this.transport.trackSessionId(payloadSessionId);
    }

    this.transport.send(payload);
  }

  end() {
    this.transport.end?.();
  }

  setSessionId(sessionId) {
    this.sessionId = sessionId || null;
    this.transport.setSessionId(this.sessionId);
  }

  getSessionId() {
    return this.sessionId || this.transport.getSessionId();
  }

  bindSession(sessionId = null) {
    return this.transport.bindSession(sessionId);
  }

  updateWebSocket(newRawWs) {
    this.transport.updateWebSocket?.(newRawWs);
  }

  getMessages() {
    return this.transport.getMessages?.() || [];
  }

  getAssistantMessages() {
    return this.transport.getAssistantMessages?.() || [];
  }

  getTotalTokens() {
    return this.transport.getTotalTokens?.() || null;
  }
}

class BaseSessionWriter {
  constructor(userId = null) {
    this.userId = userId;
    this.lastSessionId = null;
  }

  trackSessionId(sessionId) {
    if (typeof sessionId === 'string' && sessionId) {
      this.lastSessionId = sessionId;
    }
  }

  setSessionId(sessionId) {
    this.trackSessionId(sessionId);
    this.onSessionBound?.(sessionId);
  }

  getSessionId() {
    return this.lastSessionId;
  }

  bindSession(sessionId = null) {
    return new BoundSessionWriter(this, sessionId);
  }
}

class WebSocketWriter extends BaseSessionWriter {
  constructor(ws, userId = null) {
    super(userId);
    this.ws = ws;
    this.isWebSocketWriter = true;
  }

  send(data) {
    const observedSessionId = extractSessionId(data);
    if (observedSessionId) {
      this.trackSessionId(observedSessionId);
    }

    if (this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(data));
    }
  }

  updateWebSocket(newRawWs) {
    this.ws = newRawWs;
  }
}

class SSEStreamWriter extends BaseSessionWriter {
  constructor(res, userId = null) {
    super(userId);
    this.res = res;
    this.isSSEStreamWriter = true;
  }

  send(data) {
    const observedSessionId = extractSessionId(data);
    if (observedSessionId) {
      this.trackSessionId(observedSessionId);
    }

    if (this.res.writableEnded) {
      return;
    }

    this.res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  end() {
    if (!this.res.writableEnded) {
      this.res.write('data: {"type":"done"}\n\n');
      this.res.end();
    }
  }

  onSessionBound(sessionId) {
    if (sessionId) {
      this.send({ type: 'session-id', sessionId });
    }
  }
}

class ResponseCollector extends BaseSessionWriter {
  constructor(userId = null) {
    super(userId);
    this.messages = [];
  }

  send(data) {
    this.messages.push(data);

    const observedSessionId = extractSessionId(data);
    if (observedSessionId) {
      this.trackSessionId(observedSessionId);
    }
  }

  end() {
    // Intentionally empty for non-streaming collection.
  }

  getMessages() {
    return this.messages;
  }

  getAssistantMessages() {
    const assistantMessages = [];

    for (const msg of this.messages) {
      if (msg && msg.type === 'status') {
        continue;
      }

      if (typeof msg !== 'string') {
        continue;
      }

      try {
        const parsed = JSON.parse(msg);
        if (parsed.type === 'claude-response' && parsed.data?.type === 'assistant') {
          assistantMessages.push(parsed.data);
        }
      } catch {
        // Ignore non-JSON payloads.
      }
    }

    return assistantMessages;
  }

  getTotalTokens() {
    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheRead = 0;
    let totalCacheCreation = 0;

    for (const msg of this.messages) {
      let data = msg;

      if (typeof msg === 'string') {
        try {
          data = JSON.parse(msg);
        } catch {
          continue;
        }
      }

      if (data?.type === 'claude-response' && data.data?.message?.usage) {
        const usage = data.data.message.usage;
        totalInput += usage.input_tokens || 0;
        totalOutput += usage.output_tokens || 0;
        totalCacheRead += usage.cache_read_input_tokens || 0;
        totalCacheCreation += usage.cache_creation_input_tokens || 0;
      }
    }

    return {
      inputTokens: totalInput,
      outputTokens: totalOutput,
      cacheReadTokens: totalCacheRead,
      cacheCreationTokens: totalCacheCreation,
      totalTokens: totalInput + totalOutput + totalCacheRead + totalCacheCreation,
    };
  }
}

export {
  BoundSessionWriter,
  ResponseCollector,
  SSEStreamWriter,
  WebSocketWriter,
};
