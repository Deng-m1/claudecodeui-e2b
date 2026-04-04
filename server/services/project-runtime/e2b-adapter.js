import { promises as fs } from 'fs';
import path from 'path';
import { ensureSandboxConnected } from '../../providers/e2b/sandbox-manager.js';
import {
  createProjectPathError,
  resolvePathInProjectRoot,
  shouldSkipFileTreeEntry,
  sortFileTreeEntries,
} from './path-utils.js';

function createFsError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeSandboxError(error, fallbackMessage = 'Sandbox operation failed') {
  const status = error?.status || error?.response?.status || null;
  const message = error?.message || fallbackMessage;

  if (status === 404 || /not found|enoent/i.test(message)) {
    return createFsError(message, 'ENOENT');
  }

  if (status === 409 || /already exists|eexist/i.test(message)) {
    return createFsError(message, 'EEXIST');
  }

  if (status === 403 || /permission|denied|forbidden/i.test(message)) {
    return createFsError(message, 'EACCES');
  }

  return error instanceof Error ? error : new Error(fallbackMessage);
}

async function ensureRemoteDirectory(client, directoryPath) {
  const resolvedDirectoryPath = path.resolve(directoryPath);
  const segments = resolvedDirectoryPath.split(path.sep).filter(Boolean);
  let currentPath = '';

  for (const segment of segments) {
    currentPath += path.sep + segment;
    try {
      await client.mkdirFs({ path: currentPath });
    } catch (error) {
      const normalizedError = normalizeSandboxError(error);
      if (normalizedError.code !== 'EEXIST') {
        try {
          await client.statFs({ path: currentPath });
        } catch {
          throw normalizedError;
        }
      }
    }
  }
}

async function buildE2BFileTree(client, dirPath, maxDepth = 10, currentDepth = 0) {
  let entries = [];

  try {
    entries = await client.listFsEntries({ path: dirPath });
  } catch (error) {
    const normalizedError = normalizeSandboxError(error);
    if (normalizedError.code !== 'EACCES') {
      console.error('Error reading sandbox directory:', normalizedError);
    }
    return [];
  }

  const items = [];

  for (const entry of entries) {
    if (shouldSkipFileTreeEntry(entry.name)) {
      continue;
    }

    const item = {
      name: entry.name,
      path: entry.path,
      type: entry.entryType,
      size: entry.size,
      modified: entry.modified || null,
      permissionsRwx: '',
    };

    if (entry.entryType === 'directory' && currentDepth < maxDepth) {
      item.children = await buildE2BFileTree(client, entry.path, maxDepth, currentDepth + 1);
    }

    items.push(item);
  }

  return sortFileTreeEntries(items);
}

function createGitCommandError(args, response) {
  const error = new Error('Command failed: git ' + args.join(' '));
  error.code = response.exitCode;
  error.stdout = response.stdout || '';
  error.stderr = response.stderr || '';
  error.timedOut = response.timedOut === true;
  return error;
}

export async function createE2BProjectRuntimeAdapter(context) {
  const client = context.sandboxClient || await ensureSandboxConnected(context.sandboxId, context.envs || {});

  if (!client) {
    throw new Error('E2B sandbox is not connected');
  }

  const resolvePath = (targetPath = '', scopeRoot = context.projectRoot) => resolvePathInProjectRoot(scopeRoot, targetPath);

  return {
    context: {
      ...context,
      sandboxClient: client,
    },
    files: {
      resolvePath,
      async getTree() {
        return buildE2BFileTree(client, context.projectRoot, 10, 0);
      },
      async readText(targetPath, options = {}) {
        const resolvedPath = resolvePath(targetPath, options.scopeRoot);

        try {
          const content = await client.readFsFile({ path: resolvedPath });
          return {
            content: Buffer.from(content).toString('utf8'),
            path: resolvedPath,
          };
        } catch (error) {
          throw normalizeSandboxError(error, 'Failed to read file');
        }
      },
      async readBinary(targetPath, options = {}) {
        const resolvedPath = resolvePath(targetPath, options.scopeRoot);

        try {
          const content = await client.readFsFile({ path: resolvedPath });
          return {
            content: Buffer.from(content),
            path: resolvedPath,
          };
        } catch (error) {
          throw normalizeSandboxError(error, 'Failed to read file');
        }
      },
      async writeText(targetPath, content, options = {}) {
        const resolvedPath = resolvePath(targetPath, options.scopeRoot);

        try {
          await client.writeFsFile({ path: resolvedPath }, content);
          return { path: resolvedPath };
        } catch (error) {
          throw normalizeSandboxError(error, 'Failed to write file');
        }
      },
      async stat(targetPath, options = {}) {
        const resolvedPath = resolvePath(targetPath, options.scopeRoot);

        try {
          const stat = await client.statFs({ path: resolvedPath });
          return {
            path: stat.path,
            entryType: stat.entryType,
            size: stat.size,
            modified: stat.modified || null,
            permissionsRwx: '',
          };
        } catch (error) {
          throw normalizeSandboxError(error, 'Failed to stat file');
        }
      },
      async ensureDirectory(targetPath, options = {}) {
        const resolvedPath = resolvePath(targetPath, options.scopeRoot);

        await ensureRemoteDirectory(client, resolvedPath);
        return { path: resolvedPath };
      },
      async createEntry(parentPath, entryType, name, options = {}) {
        const targetPath = parentPath ? path.join(parentPath, name) : name;
        const resolvedPath = resolvePath(targetPath, options.scopeRoot);


        try {
          await client.statFs({ path: resolvedPath });
          throw createFsError((entryType === 'file' ? 'File' : 'Directory') + ' already exists', 'EEXIST');
        } catch (error) {
          const normalizedError = normalizeSandboxError(error);
          if (normalizedError.code && normalizedError.code !== 'ENOENT') {
            throw normalizedError;
          }
        }

        if (entryType === 'directory') {
          await ensureRemoteDirectory(client, resolvedPath);
        } else {
          await ensureRemoteDirectory(client, path.dirname(resolvedPath));
          await client.writeFsFile({ path: resolvedPath }, '');
        }

        return { path: resolvedPath };
      },
      async renameEntry(oldPath, newName, options = {}) {
        const fromPath = resolvePath(oldPath, options.scopeRoot);
        const toPath = resolvePath(path.join(path.dirname(fromPath), newName), options.scopeRoot);

        if (fromPath === path.resolve(options.scopeRoot || context.projectRoot)) {
          throw createProjectPathError('Cannot rename project root directory');
        }

        try {
          await client.statFs({ path: toPath });
          throw createFsError('A file or directory with this name already exists', 'EEXIST');
        } catch (error) {
          const normalizedError = normalizeSandboxError(error);
          if (normalizedError.code && normalizedError.code !== 'ENOENT') {
            throw normalizedError;
          }
        }

        try {
          await client.moveFs({ from: fromPath, to: toPath, overwrite: false });
          return { from: fromPath, to: toPath };
        } catch (error) {
          throw normalizeSandboxError(error, 'Failed to rename file');
        }
      },
      async deleteEntry(targetPath, options = {}) {
        const resolvedPath = resolvePath(targetPath, options.scopeRoot);

        if (resolvedPath === path.resolve(options.scopeRoot || context.projectRoot)) {
          throw createProjectPathError('Cannot delete project root directory');
        }

        const stat = await this.stat(resolvedPath, { scopeRoot: options.scopeRoot });
        try {
          await client.deleteFsEntry({ path: resolvedPath, recursive: stat.entryType === 'directory' });
          return { path: resolvedPath, entryType: stat.entryType };
        } catch (error) {
          throw normalizeSandboxError(error, 'Failed to delete file');
        }
      },
      async uploadBatch(targetDirectory, filesToUpload, options = {}) {
        const resolvedTargetDirectory = resolvePath(targetDirectory || '', options.scopeRoot);
        await ensureRemoteDirectory(client, resolvedTargetDirectory);

        const uploadedFiles = [];

        for (const file of filesToUpload) {
          const relativePath = file.relativePath || file.name;
          const destinationPath = resolvePath(path.join(resolvedTargetDirectory, relativePath));
          await ensureRemoteDirectory(client, path.dirname(destinationPath));
          const content = await fs.readFile(file.tempPath);
          await client.writeFsFile({ path: destinationPath }, content);
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
        const response = await client.runProcess({
          command: 'git',
          args,
          cwd,
          timeoutMs: options.timeoutMs || 120000,
          maxOutputBytes: options.maxOutputBytes || 2_000_000,
        });

        if (response.timedOut || response.exitCode !== 0) {
          throw createGitCommandError(args, response);
        }

        return {
          stdout: response.stdout || '',
          stderr: response.stderr || '',
        };
      },
    },
    shell: {
      supported: true,
      transport: 'terminald-process-terminal',
    },
  };
}
