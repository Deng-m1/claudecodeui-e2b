import { promises as fs } from 'fs';
import path from 'path';
import {
  createProjectPathError,
  resolvePathInProjectRoot,
  shouldSkipFileTreeEntry,
  sortFileTreeEntries,
} from './path-utils.js';
import { RemoteAgentError } from '../../providers/remote-host/agent-client.js';
import {
  executeRemoteProcessWithFallback,
  remoteAgentRequestWithRecovery,
} from '../../providers/remote-host/transport.js';

function createFsError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeRemoteAgentError(error, fallbackMessage = 'Remote host operation failed') {
  if (error instanceof RemoteAgentError) {
    if (error.status === 404 || /not found|enoent/i.test(error.message)) {
      return createFsError(error.message, 'ENOENT');
    }

    if (error.status === 409 || /already exists|eexist/i.test(error.message)) {
      return createFsError(error.message, 'EEXIST');
    }

    if (error.status === 403 || /permission|denied|forbidden/i.test(error.message)) {
      return createFsError(error.message, 'EACCES');
    }

    if (error.status === 412 || error.status === 502 || error.status === 504) {
      const normalized = new Error(error.message);
      normalized.code = error.code;
      return normalized;
    }
  }

  return error instanceof Error ? error : new Error(fallbackMessage);
}

async function buildRemoteFileTree(host, dirPath, maxDepth = 10, currentDepth = 0) {
  let entries = [];

  try {
    const response = await remoteAgentRequestWithRecovery(host, '/fs/list', { path: dirPath });
    entries = Array.isArray(response?.entries) ? response.entries : [];
  } catch (error) {
    const normalizedError = normalizeRemoteAgentError(error);
    if (normalizedError.code !== 'EACCES') {
      console.error('Error reading remote directory:', normalizedError);
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
      permissionsRwx: entry.permissionsRwx || '',
    };

    if (entry.entryType === 'directory' && currentDepth < maxDepth) {
      item.children = await buildRemoteFileTree(host, entry.path, maxDepth, currentDepth + 1);
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

export function createRemoteProjectRuntimeAdapter(context) {
  const resolvePath = (targetPath = '', scopeRoot = context.projectRoot) => resolvePathInProjectRoot(scopeRoot, targetPath);

  return {
    context,
    files: {
      resolvePath,
      async getTree() {
        return buildRemoteFileTree(context.remoteHost, context.projectRoot, 10, 0);
      },
      async readText(targetPath, options = {}) {
        const resolvedPath = resolvePath(targetPath, options.scopeRoot);

        try {
          const response = await remoteAgentRequestWithRecovery(context.remoteHost, '/fs/read', {
            path: resolvedPath,
            encoding: 'utf8',
          });
          return {
            content: response.content || '',
            path: resolvedPath,
          };
        } catch (error) {
          throw normalizeRemoteAgentError(error, 'Failed to read file');
        }
      },
      async readBinary(targetPath, options = {}) {
        const resolvedPath = resolvePath(targetPath, options.scopeRoot);

        try {
          const response = await remoteAgentRequestWithRecovery(context.remoteHost, '/fs/read', {
            path: resolvedPath,
            encoding: 'base64',
          });
          return {
            content: Buffer.from(response.content || '', 'base64'),
            path: resolvedPath,
          };
        } catch (error) {
          throw normalizeRemoteAgentError(error, 'Failed to read file');
        }
      },
      async writeText(targetPath, content, options = {}) {
        const resolvedPath = resolvePath(targetPath, options.scopeRoot);

        try {
          await remoteAgentRequestWithRecovery(context.remoteHost, '/fs/write', {
            path: resolvedPath,
            content,
            encoding: 'utf8',
          });
          return { path: resolvedPath };
        } catch (error) {
          throw normalizeRemoteAgentError(error, 'Failed to write file');
        }
      },
      async stat(targetPath, options = {}) {
        const resolvedPath = resolvePath(targetPath, options.scopeRoot);

        try {
          const response = await remoteAgentRequestWithRecovery(context.remoteHost, '/fs/stat', { path: resolvedPath });
          return {
            path: response.path || resolvedPath,
            entryType: response.entryType,
            size: response.size,
            modified: response.modified || null,
            permissionsRwx: response.permissionsRwx || '',
          };
        } catch (error) {
          throw normalizeRemoteAgentError(error, 'Failed to stat file');
        }
      },
      async ensureDirectory(targetPath, options = {}) {
        const resolvedPath = resolvePath(targetPath, options.scopeRoot);

        try {
          await remoteAgentRequestWithRecovery(context.remoteHost, '/fs/mkdir', {
            path: resolvedPath,
            recursive: true,
          });
          return { path: resolvedPath };
        } catch (error) {
          throw normalizeRemoteAgentError(error, 'Failed to create directory');
        }
      },
      async createEntry(parentPath, entryType, name, options = {}) {
        const targetPath = parentPath ? path.join(parentPath, name) : name;
        const resolvedPath = resolvePath(targetPath, options.scopeRoot);

        try {
          if (entryType === 'directory') {
            await remoteAgentRequestWithRecovery(context.remoteHost, '/fs/mkdir', {
              path: resolvedPath,
              recursive: false,
            });
          } else {
            await remoteAgentRequestWithRecovery(context.remoteHost, '/fs/write', {
              path: resolvedPath,
              content: '',
              encoding: 'utf8',
              createParentDirectories: true,
              failIfExists: true,
            });
          }

          return { path: resolvedPath };
        } catch (error) {
          throw normalizeRemoteAgentError(error, 'Failed to create entry');
        }
      },
      async renameEntry(oldPath, newName, options = {}) {
        const fromPath = resolvePath(oldPath, options.scopeRoot);
        const toPath = resolvePath(path.join(path.dirname(fromPath), newName), options.scopeRoot);

        if (fromPath === path.resolve(options.scopeRoot || context.projectRoot)) {
          throw createProjectPathError('Cannot rename project root directory');
        }

        try {
          await remoteAgentRequestWithRecovery(context.remoteHost, '/fs/move', {
            from: fromPath,
            to: toPath,
            overwrite: false,
          });
          return { from: fromPath, to: toPath };
        } catch (error) {
          throw normalizeRemoteAgentError(error, 'Failed to rename file');
        }
      },
      async deleteEntry(targetPath, options = {}) {
        const resolvedPath = resolvePath(targetPath, options.scopeRoot);

        if (resolvedPath === path.resolve(options.scopeRoot || context.projectRoot)) {
          throw createProjectPathError('Cannot delete project root directory');
        }

        const stat = await this.stat(resolvedPath, { scopeRoot: options.scopeRoot });

        try {
          await remoteAgentRequestWithRecovery(context.remoteHost, '/fs/delete', {
            path: resolvedPath,
            recursive: stat.entryType === 'directory',
          });
          return { path: resolvedPath, entryType: stat.entryType };
        } catch (error) {
          throw normalizeRemoteAgentError(error, 'Failed to delete file');
        }
      },
      async uploadBatch(targetDirectory, filesToUpload, options = {}) {
        const resolvedTargetDirectory = resolvePath(targetDirectory || '', options.scopeRoot);
        await this.ensureDirectory(resolvedTargetDirectory);

        const uploadedFiles = [];
        for (const file of filesToUpload) {
          const relativePath = file.relativePath || file.name;
          const destinationPath = resolvePath(path.join(resolvedTargetDirectory, relativePath));
          const content = await fs.readFile(file.tempPath);

          await remoteAgentRequestWithRecovery(context.remoteHost, '/fs/write', {
            path: destinationPath,
            content: content.toString('base64'),
            encoding: 'base64',
            createParentDirectories: true,
          });

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

        const response = await executeRemoteProcessWithFallback(context.remoteHost, {
          command: 'git',
          args,
          cwd,
          timeoutMs: options.timeoutMs || 120000,
          maxOutputBytes: options.maxOutputBytes || 2_000_000,
        }, {
          agentTimeoutMs: (options.timeoutMs || 120000) + 5000,
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
      transport: 'remote-agent-terminal',
    },
  };
}
