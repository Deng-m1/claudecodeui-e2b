import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

async function importProjectsRoutesWithWorkspaceRoot(workspacesRoot) {
  process.env.WORKSPACES_ROOT = workspacesRoot;
  const moduleUrl = pathToFileURL(path.resolve('server/routes/projects.js')).href;
  return import(`${moduleUrl}?workspace-root=${encodeURIComponent(workspacesRoot)}&ts=${Date.now()}`);
}

test('validateWorkspacePath allows descendants inside the configured workspace root even when running as root', async () => {
  const workspaceRoot = '/root';
  const routes = await importProjectsRoutesWithWorkspaceRoot(workspaceRoot);

  const result = await routes.validateWorkspacePath('/root/work/example-project');

  assert.equal(result.valid, true);
  assert.equal(result.resolvedPath, '/root/work/example-project');
});

test('validateWorkspacePath still blocks unrelated system directories outside the configured workspace root', async () => {
  const workspaceRoot = path.join(os.tmpdir(), 'claudecodeui-validation-root');
  const routes = await importProjectsRoutesWithWorkspaceRoot(workspaceRoot);

  const result = await routes.validateWorkspacePath('/etc');

  assert.equal(result.valid, false);
  assert.match(result.error || '', /system-critical|system directory/i);
});
