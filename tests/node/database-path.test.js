import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import {
  canWriteDatabasePath,
  resolveWritableDatabasePath,
} from '../../server/database/path.js';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claudecodeui-db-path-test-'));

after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('resolveWritableDatabasePath preserves a writable configured path', () => {
  const configuredPath = path.join(tempRoot, 'configured', 'auth.db');
  const result = resolveWritableDatabasePath({
    configuredPath,
    homeDir: path.join(tempRoot, 'home'),
    cwd: path.join(tempRoot, 'workspace'),
    installRoot: path.join(tempRoot, 'install'),
    tempDir: path.join(tempRoot, 'tmp'),
    isPathWritable: (candidatePath) => path.resolve(candidatePath) === path.resolve(configuredPath),
  });

  assert.equal(result.path, path.resolve(configuredPath));
  assert.equal(result.selectedLabel, 'configured DATABASE_PATH');
  assert.equal(result.fallbackUsed, false);
});

test('resolveWritableDatabasePath falls back to the workspace database when configured and home paths are not writable', () => {
  const configuredPath = path.join(tempRoot, 'configured', 'auth.db');
  const homeDir = path.join(tempRoot, 'home');
  const cwd = path.join(tempRoot, 'workspace');
  const workspacePath = path.join(cwd, '.cloudcli-data', 'auth.db');
  const deniedPaths = new Set([
    path.resolve(configuredPath),
    path.resolve(path.join(homeDir, '.cloudcli', 'auth.db')),
  ]);

  const result = resolveWritableDatabasePath({
    configuredPath,
    homeDir,
    cwd,
    installRoot: path.join(tempRoot, 'install'),
    tempDir: path.join(tempRoot, 'tmp'),
    isPathWritable: (candidatePath) => !deniedPaths.has(path.resolve(candidatePath)),
  });

  assert.equal(result.path, path.resolve(workspacePath));
  assert.equal(result.selectedLabel, 'workspace database');
  assert.equal(result.preferredLabel, 'configured DATABASE_PATH');
  assert.equal(result.fallbackUsed, true);
});

test('resolveWritableDatabasePath falls back from the default home path when no configured path is set', () => {
  const homeDir = path.join(tempRoot, 'home-default');
  const cwd = path.join(tempRoot, 'workspace-default');
  const workspacePath = path.join(cwd, '.cloudcli-data', 'auth.db');
  const deniedPaths = new Set([
    path.resolve(path.join(homeDir, '.cloudcli', 'auth.db')),
  ]);

  const result = resolveWritableDatabasePath({
    configuredPath: '',
    homeDir,
    cwd,
    installRoot: path.join(tempRoot, 'install-default'),
    tempDir: path.join(tempRoot, 'tmp-default'),
    isPathWritable: (candidatePath) => !deniedPaths.has(path.resolve(candidatePath)),
  });

  assert.equal(result.path, path.resolve(workspacePath));
  assert.equal(result.selectedLabel, 'workspace database');
  assert.equal(result.preferredLabel, 'default home database');
  assert.equal(result.fallbackUsed, true);
});

test('canWriteDatabasePath accepts a new database under a writable temp root', () => {
  const targetPath = path.join(tempRoot, 'probe-ok', 'auth.db');

  assert.equal(canWriteDatabasePath(targetPath), true);
});

test('canWriteDatabasePath rejects targets whose nearest existing parent is not a directory', () => {
  const blockerPath = path.join(tempRoot, 'not-a-directory');
  fs.writeFileSync(blockerPath, 'blocked', 'utf8');

  const targetPath = path.join(blockerPath, 'child', 'auth.db');
  assert.equal(canWriteDatabasePath(targetPath), false);
});
