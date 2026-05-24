import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function getDatabaseInstallRoot() {
  return path.join(__dirname, '..', '..');
}

function findNearestExistingParent(targetPath, fsImpl = fs) {
  let current = path.dirname(path.resolve(targetPath));

  while (!fsImpl.existsSync(current)) {
    const next = path.dirname(current);
    if (next === current) {
      return null;
    }
    current = next;
  }

  return current;
}

function canWriteParentDirectory(parentDir, fsImpl = fs) {
  const probePath = path.join(
    parentDir,
    '.claude-code-ui-write-probe-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(16).slice(2),
  );
  let probeHandle = null;

  try {
    probeHandle = fsImpl.openSync(probePath, 'w');
    return true;
  } catch {
    return false;
  } finally {
    if (probeHandle !== null) {
      try {
        fsImpl.closeSync(probeHandle);
      } catch {
      }
    }

    try {
      fsImpl.rmSync(probePath, { force: true });
    } catch {
    }
  }
}

export function canWriteDatabasePath(targetPath, { fsImpl = fs } = {}) {
  const normalizedPath = path.resolve(targetPath);
  const parent = findNearestExistingParent(normalizedPath, fsImpl);

  if (!parent) {
    return false;
  }

  let fileHandle = null;

  try {
    if (fsImpl.existsSync(normalizedPath)) {
      fileHandle = fsImpl.openSync(normalizedPath, 'r+');
    }
  } catch {
    return false;
  } finally {
    if (fileHandle !== null) {
      try {
        fsImpl.closeSync(fileHandle);
      } catch {
      }
    }
  }

  return canWriteParentDirectory(parent, fsImpl);
}

export function resolveWritableDatabasePath({
  configuredPath = process.env.DATABASE_PATH || '',
  homeDir = os.homedir(),
  cwd = process.cwd(),
  installRoot = getDatabaseInstallRoot(),
  tempDir = os.tmpdir(),
  isPathWritable = (candidatePath) => canWriteDatabasePath(candidatePath),
} = {}) {
  const normalizedConfiguredPath = typeof configuredPath === 'string' ? configuredPath.trim() : '';
  const candidates = [
    normalizedConfiguredPath
      ? { label: 'configured DATABASE_PATH', path: normalizedConfiguredPath }
      : null,
    { label: 'default home database', path: path.join(homeDir, '.cloudcli', 'auth.db') },
    { label: 'workspace database', path: path.join(cwd, '.cloudcli-data', 'auth.db') },
    { label: 'install database', path: path.join(installRoot, '.cloudcli-data', 'auth.db') },
    { label: 'temporary database', path: path.join(tempDir, 'claude-code-ui', 'auth.db') },
  ].filter(Boolean);

  const uniqueCandidates = [];
  const seenPaths = new Set();

  for (const candidate of candidates) {
    const resolvedPath = path.resolve(candidate.path);
    if (seenPaths.has(resolvedPath)) {
      continue;
    }

    seenPaths.add(resolvedPath);
    uniqueCandidates.push({
      label: candidate.label,
      path: resolvedPath,
    });
  }

  const preferredCandidate = uniqueCandidates[0];

  for (const candidate of uniqueCandidates) {
    if (!isPathWritable(candidate.path)) {
      continue;
    }

    return {
      path: candidate.path,
      selectedLabel: candidate.label,
      preferredLabel: preferredCandidate.label,
      preferredPath: preferredCandidate.path,
      configuredPath: normalizedConfiguredPath || null,
      fallbackUsed: preferredCandidate.path !== candidate.path,
    };
  }

  const lastCandidate = uniqueCandidates[uniqueCandidates.length - 1];
  return {
    path: lastCandidate.path,
    selectedLabel: lastCandidate.label,
    preferredLabel: preferredCandidate.label,
    preferredPath: preferredCandidate.path,
    configuredPath: normalizedConfiguredPath || null,
    fallbackUsed: preferredCandidate.path !== lastCandidate.path,
  };
}
