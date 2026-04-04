import path from 'path';

export function createProjectPathError(message) {
  const error = new Error(message);
  error.code = 'INVALID_PROJECT_PATH';
  return error;
}

export function resolvePathInProjectRoot(projectRoot, targetPath = '') {
  const normalizedRoot = path.resolve(projectRoot);
  const rawTargetPath = typeof targetPath === 'string' ? targetPath : '';
  const resolvedPath = rawTargetPath && rawTargetPath !== '.' && rawTargetPath !== './'
    ? (path.isAbsolute(rawTargetPath) ? path.resolve(rawTargetPath) : path.resolve(normalizedRoot, rawTargetPath))
    : normalizedRoot;

  if (resolvedPath !== normalizedRoot && !resolvedPath.startsWith(normalizedRoot + path.sep)) {
    throw createProjectPathError('Path must be under project root');
  }

  return resolvedPath;
}

export function validateFilename(name) {
  if (!name || !String(name).trim()) {
    return { valid: false, error: 'Filename cannot be empty' };
  }

  const invalidChars = /[<>:"/\\|?*\x00-\x1f]/;
  if (invalidChars.test(name)) {
    return { valid: false, error: 'Filename contains invalid characters' };
  }

  const reserved = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
  if (reserved.test(name)) {
    return { valid: false, error: 'Filename is a reserved name' };
  }

  if (/^\.+$/.test(name)) {
    return { valid: false, error: 'Filename cannot be only dots' };
  }

  return { valid: true };
}

export function shouldSkipFileTreeEntry(name) {
  return name === 'node_modules'
    || name === 'dist'
    || name === 'build'
    || name === '.git'
    || name === '.svn'
    || name === '.hg';
}

export function sortFileTreeEntries(entries) {
  return entries.sort((left, right) => {
    if (left.type !== right.type) {
      return left.type === 'directory' ? -1 : 1;
    }

    return left.name.localeCompare(right.name);
  });
}

function permToRwx(perm) {
  const r = perm & 4 ? 'r' : '-';
  const w = perm & 2 ? 'w' : '-';
  const x = perm & 1 ? 'x' : '-';
  return r + w + x;
}

export function modeToPermissionsRwx(mode) {
  const ownerPerm = (mode >> 6) & 7;
  const groupPerm = (mode >> 3) & 7;
  const otherPerm = mode & 7;
  return permToRwx(ownerPerm) + permToRwx(groupPerm) + permToRwx(otherPerm);
}
