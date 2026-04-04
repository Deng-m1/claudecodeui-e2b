import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getProjectLastActivity, sortProjects } from '../../src/components/sidebar/utils/utils.ts';
import type { Project } from '../../src/types/app.ts';

const buildCloudProject = (overrides: Partial<Project> = {}): Project => ({
  name: overrides.name || 'cloud-project',
  displayName: overrides.displayName || overrides.name || 'cloud-project',
  fullPath: overrides.fullPath || '/tmp/cloud-project',
  kind: 'cloud',
  runtime: 'e2b',
  cloud: {
    sandboxId: 'sandbox-test',
    repoUrl: 'https://github.com/example/repo.git',
    branch: 'main',
    workspacePath: '/workspace/repo',
    ...overrides.cloud,
  },
  sessions: [],
  cursorSessions: [],
  codexSessions: [],
  geminiSessions: [],
  e2bSessions: [],
  ...overrides,
});

test('sortProjects keeps cloud projects ordered by latest activity even in name mode', () => {
  const olderCloudProject = buildCloudProject({
    name: 'alpha-cloud',
    displayName: 'Alpha Cloud',
    e2bSessions: [
      {
        id: 'session-older',
        summary: 'Older session',
        lastActivity: '2025-01-15T08:00:00.000Z',
      },
    ],
  });

  const newerCloudProject = buildCloudProject({
    name: 'zulu-cloud',
    displayName: 'Zulu Cloud',
    e2bSessions: [
      {
        id: 'session-newer',
        summary: 'Newer session',
        lastActivity: '2025-03-20T09:30:00.000Z',
      },
    ],
  });

  const sorted = sortProjects([olderCloudProject, newerCloudProject], 'name', new Set(), {});
  assert.deepEqual(sorted.map((project) => project.name), ['zulu-cloud', 'alpha-cloud']);
});

test('getProjectLastActivity falls back to cloud metadata when sessions are absent', () => {
  const cloudProject = buildCloudProject({
    cloud: {
      sandboxId: 'sandbox-fallback',
      lastActivity: '2025-04-01T12:34:56.000Z',
    },
  });

  assert.equal(
    getProjectLastActivity(cloudProject, {}).toISOString(),
    '2025-04-01T12:34:56.000Z',
  );
});
