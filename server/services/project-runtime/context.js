import { credentialsDb, e2bSandboxDb } from '../../database/db.js';
import { extractProjectDirectory } from '../../projects.js';
import { ensureSandboxConnected } from '../../providers/e2b/sandbox-manager.js';
import { extractSandboxIdFromProjectName, isE2BProjectName } from '../../providers/e2b/project-utils.js';
import { isRemoteHostProjectName } from '../../providers/remote-host/project-utils.js';
import { resolveRemoteWorkspaceTarget } from '../../providers/remote-host/agent-client.js';
import { getProjectCapabilities } from './capabilities.js';

function resolveSandboxEnvs(userId) {
  const envs = {};

  if (process.env.GITHUB_TOKEN) {
    envs.GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  }

  if (userId) {
    const githubToken = credentialsDb.getActiveCredential(userId, 'github_oauth');
    if (githubToken) {
      envs.GITHUB_TOKEN = githubToken;
    }
  }

  return envs;
}

export async function resolveProjectRuntimeContext(projectName, { userId = null } = {}) {
  if (isE2BProjectName(projectName)) {
    const sandboxId = extractSandboxIdFromProjectName(projectName);
    const sandboxRecord = sandboxId ? e2bSandboxDb.getBySandboxId(sandboxId) : null;

    if (!sandboxRecord) {
      throw new Error('Project not found');
    }

    if (userId && sandboxRecord.user_id !== userId) {
      throw new Error('Project not found');
    }

    const envs = resolveSandboxEnvs(sandboxRecord.user_id || userId || null);
    const sandboxClient = await ensureSandboxConnected(sandboxId, envs);

    return {
      runtime: 'e2b',
      projectName,
      projectRoot: sandboxRecord.workspace_path || '/home/user',
      userId: sandboxRecord.user_id || userId || null,
      sandboxId,
      sandboxRecord,
      sandboxClient,
      envs,
      capabilities: getProjectCapabilities('e2b'),
    };
  }

  if (isRemoteHostProjectName(projectName)) {
    const target = resolveRemoteWorkspaceTarget(projectName, userId);

    return {
      runtime: 'remote_host',
      targetId: target.host.id,
      workspaceId: target.workspace.id,
      projectName,
      projectRoot: target.workspace.workspace_root,
      userId,
      sandboxId: null,
      remoteHost: target.host,
      remoteWorkspace: target.workspace,
      capabilities: getProjectCapabilities('remote_host'),
    };
  }

  const projectRoot = await extractProjectDirectory(projectName);

  return {
    runtime: 'local',
    projectName,
    projectRoot,
    userId,
    sandboxId: null,
    capabilities: getProjectCapabilities('local'),
  };
}
