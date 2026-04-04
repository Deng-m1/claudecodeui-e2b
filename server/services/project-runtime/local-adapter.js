import fsSync from 'fs';
import { promises as fs } from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import {
  createProjectPathError,
  modeToPermissionsRwx,
  resolvePathInProjectRoot,
  shouldSkipFileTreeEntry,
  sortFileTreeEntries,
} from './path-utils.js';

function spawnAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      shell: false,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      const error = new Error('Command failed: ' + command + ' ' + args.join(' '));
      error.code = code;
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
  });
}

function createAlreadyExistsError(message) {
  const error = new Error(message);
  error.code = 'EEXIST';
  return error;
}

async function accessOrNull(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function buildLocalFileTree(dirPath, maxDepth = 10, currentDepth = 0) {
  const items = [];

  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      if (shouldSkipFileTreeEntry(entry.name)) {
        continue;
      }

      const itemPath = path.join(dirPath, entry.name);
      const item = {
        name: entry.name,
        path: itemPath,
        type: entry.isDirectory() ? 'directory' : 'file',
      };

      try {
        const stats = await fs.stat(itemPath);
        item.size = stats.size;
        item.modified = stats.mtime.toISOString();
        item.permissions = String((stats.mode >> 6) & 7) + String((stats.mode >> 3) & 7) + String(stats.mode & 7);
        item.permissionsRwx = modeToPermissionsRwx(stats.mode);
      } catch {
        item.size = 0;
        item.modified = null;
        item.permissions = '000';
        item.permissionsRwx = '---------';
      }

      if (entry.isDirectory() && currentDepth < maxDepth) {
        try {
          await fs.access(itemPath, fsSync.constants.R_OK);
          item.children = await buildLocalFileTree(itemPath, maxDepth, currentDepth + 1);
        } catch {
          item.children = [];
        }
      }

      items.push(item);
    }
  } catch (error) {
    if (error.code !== 'EACCES' && error.code !== 'EPERM') {
      console.error('Error reading directory:', error);
    }
  }

  return sortFileTreeEntries(items);
}

export function createLocalProjectRuntimeAdapter(context) {
  const resolvePath = (targetPath = '', scopeRoot = context.projectRoot) => resolvePathInProjectRoot(scopeRoot, targetPath);

  return {
    context,
    files: {
      resolvePath,
      async getTree() {
        return buildLocalFileTree(context.projectRoot, 10, 0);
      },
      async readText(targetPath, options = {}) {
        const resolvedPath = resolvePath(targetPath, options.scopeRoot);

        const content = await fs.readFile(resolvedPath, 'utf8');
        return { content, path: resolvedPath };
      },
      async readBinary(targetPath, options = {}) {
        const resolvedPath = resolvePath(targetPath, options.scopeRoot);

        const content = await fs.readFile(resolvedPath);
        return { content, path: resolvedPath };
      },
      async writeText(targetPath, content, options = {}) {
        const resolvedPath = resolvePath(targetPath, options.scopeRoot);

        await fs.writeFile(resolvedPath, content, 'utf8');
        return { path: resolvedPath };
      },
      async stat(targetPath, options = {}) {
        const resolvedPath = resolvePath(targetPath, options.scopeRoot);

        const stats = await fs.stat(resolvedPath);
        return {
          path: resolvedPath,
          entryType: stats.isDirectory() ? 'directory' : 'file',
          size: stats.size,
          modified: stats.mtime.toISOString(),
          permissionsRwx: modeToPermissionsRwx(stats.mode),
        };
      },
      async ensureDirectory(targetPath, options = {}) {
        const resolvedPath = resolvePath(targetPath, options.scopeRoot);

        await fs.mkdir(resolvedPath, { recursive: true });
        return { path: resolvedPath };
      },
      async createEntry(parentPath, entryType, name, options = {}) {
        const targetPath = parentPath ? path.join(parentPath, name) : name;
        const resolvedPath = resolvePath(targetPath, options.scopeRoot);


        if (await accessOrNull(resolvedPath)) {
          throw createAlreadyExistsError((entryType === 'file' ? 'File' : 'Directory') + ' already exists');
        }

        if (entryType === 'directory') {
          await fs.mkdir(resolvedPath, { recursive: false });
        } else {
          await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
          await fs.writeFile(resolvedPath, '', 'utf8');
        }

        return { path: resolvedPath };
      },
      async renameEntry(oldPath, newName, options = {}) {
        const fromPath = resolvePath(oldPath, options.scopeRoot);
        const toPath = resolvePath(path.join(path.dirname(fromPath), newName), options.scopeRoot);

        if (fromPath === path.resolve(options.scopeRoot || context.projectRoot)) {
          throw createProjectPathError('Cannot rename project root directory');
        }

        if (await accessOrNull(toPath)) {
          throw createAlreadyExistsError('A file or directory with this name already exists');
        }

        await fs.rename(fromPath, toPath);
        return { from: fromPath, to: toPath };
      },
      async deleteEntry(targetPath, options = {}) {
        const resolvedPath = resolvePath(targetPath, options.scopeRoot);

        if (resolvedPath === path.resolve(options.scopeRoot || context.projectRoot)) {
          throw createProjectPathError('Cannot delete project root directory');
        }

        const stats = await fs.stat(resolvedPath);
        const entryType = stats.isDirectory() ? 'directory' : 'file';

        if (entryType === 'directory') {
          await fs.rm(resolvedPath, { recursive: true, force: true });
        } else {
          await fs.unlink(resolvedPath);
        }

        return { path: resolvedPath, entryType };
      },
      async uploadBatch(targetDirectory, filesToUpload, options = {}) {
        const resolvedTargetDirectory = resolvePath(targetDirectory || '', options.scopeRoot);
        await fs.mkdir(resolvedTargetDirectory, { recursive: true });

        const uploadedFiles = [];

        for (const file of filesToUpload) {
          const relativePath = file.relativePath || file.name;
          const destinationPath = resolvePath(path.join(resolvedTargetDirectory, relativePath));
          await fs.mkdir(path.dirname(destinationPath), { recursive: true });
          await fs.copyFile(file.tempPath, destinationPath);
          uploadedFiles.push({
            name: relativePath,
            path: destinationPath,
            size: file.size,
            mimeType: file.mimeType,
          });
        }

        return {
          targetPath: resolvedTargetDirectory,
          files: uploadedFiles,
        };
      },
    },
    git: {
      async run(args, options = {}) {
        const cwd = options.cwd ? resolvePath(options.cwd) : context.projectRoot;
        return spawnAsync('git', args, { cwd });
      },
    },
    shell: {
      supported: true,
      transport: 'host-pty-websocket',
    },
  };
}
