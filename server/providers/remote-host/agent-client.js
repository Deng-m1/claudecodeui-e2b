import fetch from 'node-fetch';
import { remoteHostsDb, remoteWorkspacesDb } from '../../database/db.js';
import { extractRemoteWorkspaceIdFromProjectName } from './project-utils.js';

const DEFAULT_REMOTE_AGENT_TIMEOUT_MS = 15000;

function normalizeNonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

export class RemoteAgentError extends Error {
  constructor(message, code = 'REMOTE_AGENT_ERROR', status = 500) {
    super(message);
    this.name = 'RemoteAgentError';
    this.code = code;
    this.status = status;
  }
}

export function resolveRemoteWorkspaceTarget(projectName, userId) {
  const workspaceId = extractRemoteWorkspaceIdFromProjectName(projectName);
  if (!workspaceId) {
    throw new RemoteAgentError('Remote workspace not found', 'REMOTE_WORKSPACE_NOT_FOUND', 404);
  }

  const workspace = remoteWorkspacesDb.getById(userId, workspaceId);
  if (!workspace) {
    throw new RemoteAgentError('Remote workspace not found', 'REMOTE_WORKSPACE_NOT_FOUND', 404);
  }

  const host = remoteHostsDb.getById(userId, workspace.remote_host_id);
  if (!host) {
    throw new RemoteAgentError('Remote host not found', 'REMOTE_HOST_NOT_FOUND', 404);
  }

  return { workspaceId, workspace, host };
}

function buildAuthorizationHeader(agentToken) {
  const normalizedToken = normalizeNonEmptyString(agentToken);
  if (!normalizedToken) {
    throw new RemoteAgentError(
      'Remote host is missing a stored agent token. Reconnect or re-bootstrap this host.',
      'REMOTE_AGENT_TOKEN_MISSING',
      412,
    );
  }

  return `Bearer ${normalizedToken}`;
}

export async function remoteAgentRequest(host, pathname, payload = null, options = {}) {
  const agentUrl = normalizeNonEmptyString(host?.agent_url);
  if (!agentUrl) {
    throw new RemoteAgentError(
      'Remote host does not have an agent URL configured.',
      'REMOTE_AGENT_URL_MISSING',
      412,
    );
  }

  const controller = new AbortController();
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_REMOTE_AGENT_TIMEOUT_MS;
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(new URL(pathname, agentUrl), {
      method: payload === null ? 'GET' : 'POST',
      headers: {
        Authorization: buildAuthorizationHeader(host?.agent_token),
        ...(payload === null ? {} : { 'Content-Type': 'application/json' }),
      },
      body: payload === null ? undefined : JSON.stringify(payload),
      signal: controller.signal,
    });

    const result = await response.json().catch(() => null);
    if (!response.ok || result?.ok === false) {
      const message = result?.error || `Remote agent request failed with HTTP ${response.status}`;
      throw new RemoteAgentError(message, 'REMOTE_AGENT_REQUEST_FAILED', response.status);
    }

    return result;
  } catch (error) {
    if (error instanceof RemoteAgentError) {
      throw error;
    }

    if (error?.name === 'AbortError') {
      throw new RemoteAgentError(
        `Remote agent request timed out after ${timeoutMs}ms`,
        'REMOTE_AGENT_TIMEOUT',
        504,
      );
    }

    throw new RemoteAgentError(
      error?.message || 'Remote agent request failed',
      'REMOTE_AGENT_UNREACHABLE',
      502,
    );
  } finally {
    clearTimeout(timeoutHandle);
  }
}
