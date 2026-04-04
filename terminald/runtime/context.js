import fs from 'fs/promises';
import { credentialsDb, e2bSandboxDb } from '../../server/database/db.js';
import { extractProjectDirectory } from '../../server/projects.js';
import { extractSandboxIdFromProjectName, isE2BProjectName } from '../../server/providers/e2b/project-utils.js';

function resolveSandboxEnvs(userId) {
  const envs = {};

  if (process.env.GITHUB_TOKEN) {
    envs.GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  }

  if (process.env.ANTHROPIC_API_KEY) {
    envs.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  }

  if (process.env.OPENAI_API_KEY) {
    envs.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  }

  if (userId) {
    const githubToken = credentialsDb.getActiveCredential(userId, 'github_oauth');
    if (githubToken) {
      envs.GITHUB_TOKEN = githubToken;
    }
  }

  return Object.fromEntries(
    Object.entries(envs).filter(([, value]) => typeof value === 'string' && value.trim().length > 0),
  );
}

async function resolveLocalProjectRoot(projectName, projectPath) {
  if (typeof projectPath === 'string' && projectPath.trim().startsWith('/')) {
    try {
      await fs.access(projectPath.trim());
      return projectPath.trim();
    } catch {
      // Fall back to project-name resolution below.
    }
  }

  return extractProjectDirectory(projectName);
}

export async function resolveTerminalRuntimeContext(projectName, { userId = null, projectPath = null } = {}) {
  if (isE2BProjectName(projectName)) {
    const sandboxId = extractSandboxIdFromProjectName(projectName);
    const sandboxRecord = sandboxId ? e2bSandboxDb.getBySandboxId(sandboxId) : null;

    if (!sandboxRecord) {
      throw new Error('Project not found');
    }

    if (userId && sandboxRecord.user_id !== userId) {
      throw new Error('Project not found');
    }

    return {
      runtime: 'e2b',
      projectName,
      projectRoot: sandboxRecord.workspace_path || '/home/user',
      userId: sandboxRecord.user_id || userId || null,
      sandboxId,
      sandboxRecord,
      envs: resolveSandboxEnvs(sandboxRecord.user_id || userId || null),
    };
  }

  const projectRoot = await resolveLocalProjectRoot(projectName, projectPath);

  return {
    runtime: 'local',
    projectName,
    projectRoot,
    userId,
    sandboxId: null,
    sandboxRecord: null,
    envs: {},
  };
}
