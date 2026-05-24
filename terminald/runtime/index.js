import crypto from 'crypto';
import { e2bSessionDb } from '../../server/database/db.js';
import { resolveE2BAgentProvider } from '../../server/providers/e2b/project-utils.js';
import { resolveTerminalRuntimeContext } from './context.js';
import { attachE2BTerminal, closeE2BTerminal, ensureE2BTerminal, getLiveE2BSessionInfo } from './e2b.js';
import { attachLocalTerminal, closeLocalTerminal, ensureLocalTerminal } from './local.js';

function parseMetadataJson(value) {
  if (!value) {
    return null;
  }

  if (typeof value === 'object') {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeNonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function __internal__mergeLiveE2BSessionMetadata(sessionRecord, liveSessionInfo) {
  const metadata = parseMetadataJson(sessionRecord?.metadata_json) || {};
  const liveSessionId = normalizeNonEmptyString(liveSessionInfo?.sessionId);
  const liveAgentSessionId = normalizeNonEmptyString(liveSessionInfo?.agentSessionId);

  if (!liveSessionId && !liveAgentSessionId) {
    return {
      changed: false,
      metadata,
      sessionRecord,
    };
  }

  const nextMetadata = {
    ...metadata,
    ...(liveSessionId ? { sandboxSessionId: liveSessionId } : {}),
    ...(liveAgentSessionId ? { agentSessionId: liveAgentSessionId } : {}),
  };
  const changed =
    nextMetadata.sandboxSessionId !== metadata?.sandboxSessionId ||
    nextMetadata.agentSessionId !== metadata?.agentSessionId;

  return {
    changed,
    metadata: nextMetadata,
    sessionRecord: changed
      ? {
          ...sessionRecord,
          metadata_json: nextMetadata,
        }
      : sessionRecord,
  };
}

export function buildE2BSessionLaunchSpec(sessionRecord, metadata = parseMetadataJson(sessionRecord?.metadata_json)) {
  const provider = resolveE2BAgentProvider(sessionRecord?.agent || metadata?.provider || '');
  const nativeSessionId = normalizeNonEmptyString(
    provider === 'claude'
      ? metadata?.nativeClaudeSessionId || metadata?.agentSessionId
      : metadata?.agentSessionId || metadata?.nativeClaudeSessionId,
  );

  if (provider === 'claude') {
    return nativeSessionId
      ? { command: 'claude', args: ['--resume', nativeSessionId] }
      : { command: 'claude', args: [] };
  }

  if (provider === 'codex') {
    return nativeSessionId
      ? { command: 'codex', args: ['resume', nativeSessionId] }
      : { command: 'codex', args: [] };
  }

  if (provider === 'gemini') {
    return nativeSessionId
      ? { command: 'gemini', args: ['--resume', nativeSessionId] }
      : { command: 'gemini', args: [] };
  }

  if (provider === 'cursor') {
    return nativeSessionId
      ? { command: 'cursor-agent', args: [`--resume=${nativeSessionId}`] }
      : { command: 'cursor-agent', args: [] };
  }

  return null;
}

export function resolveE2BSessionTerminalSeed(sessionRecord) {
  const metadata = parseMetadataJson(sessionRecord?.metadata_json);
  const provider = resolveE2BAgentProvider(sessionRecord?.agent || metadata?.provider || '');
  const runtime = normalizeNonEmptyString(metadata?.runtime);
  const shouldReuseSessionProcess = runtime !== 'claude-native';

  return {
    provider,
    processId: shouldReuseSessionProcess ? normalizeNonEmptyString(metadata?.processId) : null,
    resetProcessId: !shouldReuseSessionProcess,
    launchSpec: buildE2BSessionLaunchSpec(sessionRecord, metadata),
    metadata: {
      sessionId: normalizeNonEmptyString(sessionRecord?.session_id),
      provider,
      agentSessionId: normalizeNonEmptyString(metadata?.agentSessionId),
      nativeClaudeSessionId: normalizeNonEmptyString(metadata?.nativeClaudeSessionId),
    },
  };
}

export function __internal__resolveE2BTerminalProcessId(existingProcessId, sessionSeed) {
  return normalizeNonEmptyString(sessionSeed?.processId) || normalizeNonEmptyString(existingProcessId);
}

async function refreshE2BSessionRecordFromSandbox(sessionRecord, context) {
  const sessionId = normalizeNonEmptyString(sessionRecord?.session_id);

  if (!sessionId || context?.runtime !== 'e2b') {
    return sessionRecord;
  }

  const liveSessionInfo = await getLiveE2BSessionInfo(context, sessionId).catch(() => null);
  const merged = __internal__mergeLiveE2BSessionMetadata(sessionRecord, liveSessionInfo);

  if (merged.changed) {
    e2bSessionDb.touch(sessionId, { metadata: merged.metadata });
  }

  return merged.sessionRecord;
}

export async function resolveTerminalRecord(projectName, userId, record, options = {}) {
  const seededRecord = {
    ...record,
    id: record?.id || crypto.randomUUID(),
    terminalKey: record?.terminalKey || 'default',
  };
  const context = await resolveTerminalRuntimeContext(projectName, { userId, projectPath: options.projectPath || null });

  if (context.runtime === 'e2b') {
    let ensuredRecord = seededRecord;
    let e2bOptions = {};
    const requestedSessionId = normalizeNonEmptyString(options.sessionId);

    if (requestedSessionId) {
      const storedSessionRecord = e2bSessionDb.getBySessionId(requestedSessionId);
      const sessionRecord = storedSessionRecord
        ? await refreshE2BSessionRecordFromSandbox(storedSessionRecord, context)
        : null;
      if (
        sessionRecord &&
        sessionRecord.sandbox_id === context.sandboxId &&
        (!userId || sessionRecord.user_id === userId)
      ) {
        const sessionSeed = resolveE2BSessionTerminalSeed(sessionRecord);
        ensuredRecord = {
          ...ensuredRecord,
          // Do not reuse the chat bridge process for claude-native sessions,
          // but keep reusing any terminal-owned interactive process we already
          // created for this session shell.
          processId: __internal__resolveE2BTerminalProcessId(ensuredRecord.processId, sessionSeed),
          metadata: {
            ...(ensuredRecord.metadata || {}),
            e2bSessionId: requestedSessionId,
            attachProvider: sessionSeed.provider,
            ...sessionSeed.metadata,
          },
        };
        e2bOptions = {
          launchSpec: sessionSeed.launchSpec,
        };
      }
    }

    const ensured = await ensureE2BTerminal(ensuredRecord, context, e2bOptions);
    return { context, record: ensured };
  }

  const ensured = await ensureLocalTerminal(seededRecord, context);
  return { context, record: ensured };
}

export async function attachTerminal(record, context, dimensions) {
  if (context.runtime === 'e2b') {
    return attachE2BTerminal(record, context, dimensions);
  }

  return attachLocalTerminal(record, context, dimensions);
}

export async function closeTerminal(record, context) {
  if (context.runtime === 'e2b') {
    return closeE2BTerminal(record, context);
  }

  return closeLocalTerminal(record, context);
}
