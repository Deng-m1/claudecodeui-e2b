import express from 'express';
import path from 'path';
import { queryClaudeSDK } from '../claude-sdk.js';
import { spawnCursor } from '../cursor-cli.js';
import { getProjectRuntimeAdapter } from '../services/project-runtime/index.js';

const router = express.Router();
const COMMIT_DIFF_CHARACTER_LIMIT = 500_000;

// Input validation helpers (defense-in-depth)
function validateCommitRef(commit) {
  // Allow hex hashes, HEAD, HEAD~N, HEAD^N, tag names, branch names
  if (!/^[a-zA-Z0-9._~^{}@\/\-]+$/.test(commit)) {
    throw new Error('Invalid commit reference');
  }
  return commit;
}

function validateBranchName(branch) {
  if (!/^[a-zA-Z0-9._\/\-]+$/.test(branch)) {
    throw new Error('Invalid branch name');
  }
  return branch;
}

function validateFilePath(file, projectPath) {
  if (!file || file.includes('\0')) {
    throw new Error('Invalid file path');
  }

  if (projectPath) {
    const resolved = path.resolve(projectPath, file);
    const normalizedRoot = path.resolve(projectPath) + path.sep;
    if (!resolved.startsWith(normalizedRoot) && resolved !== path.resolve(projectPath)) {
      throw new Error('Invalid file path: path traversal detected');
    }
  }

  return file;
}

function validateRemoteName(remote) {
  if (!/^[a-zA-Z0-9._-]+$/.test(remote)) {
    throw new Error('Invalid remote name');
  }
  return remote;
}

function validateProjectPath(projectPath) {
  if (!projectPath || projectPath.includes('\0')) {
    throw new Error('Invalid project path');
  }
  const resolved = path.resolve(projectPath);
  if (!path.isAbsolute(resolved)) {
    throw new Error('Invalid project path: must be absolute');
  }
  if (resolved === '/' || resolved === path.sep) {
    throw new Error('Invalid project path: root directory not allowed');
  }
  return resolved;
}

async function resolveGitProjectRuntime(projectName, userId) {
  const adapter = await getProjectRuntimeAdapter(String(projectName), { userId });
  return {
    adapter,
    projectPath: validateProjectPath(adapter.context.projectRoot),
  };
}

async function runGit(projectRuntime, args, options = {}) {
  return projectRuntime.adapter.git.run(args, {
    ...options,
    cwd: options.cwd || projectRuntime.projectPath,
  });
}

// Helper function to strip git diff headers
function stripDiffHeaders(diff) {
  if (!diff) return '';

  const lines = diff.split('\n');
  const filteredLines = [];
  let startIncluding = false;

  for (const line of lines) {
    // Skip all header lines including diff --git, index, file mode, and --- / +++ file paths
    if (line.startsWith('diff --git') ||
        line.startsWith('index ') ||
        line.startsWith('new file mode') ||
        line.startsWith('deleted file mode') ||
        line.startsWith('---') ||
        line.startsWith('+++')) {
      continue;
    }

    // Start including lines from @@ hunk headers onwards
    if (line.startsWith('@@') || startIncluding) {
      startIncluding = true;
      filteredLines.push(line);
    }
  }

  return filteredLines.join('\n');
}

// Helper function to validate git repository
async function validateGitRepository(projectRuntime) {
  try {
    await projectRuntime.adapter.files.stat(projectRuntime.projectPath);
  } catch {
    throw new Error('Project path not found: ' + projectRuntime.projectPath);
  }

  try {
    const { stdout: insideWorkTreeOutput } = await runGit(projectRuntime, ['rev-parse', '--is-inside-work-tree']);
    const isInsideWorkTree = insideWorkTreeOutput.trim() === 'true';
    if (!isInsideWorkTree) {
      throw new Error('Not inside a git work tree');
    }

    await runGit(projectRuntime, ['rev-parse', '--show-toplevel']);
  } catch {
    throw new Error('Not a git repository. This directory does not contain a .git folder. Initialize a git repository with "git init" to use source control features.');
  }
}

function getGitErrorDetails(error) {
  return (error?.message || '') + ' ' + (error?.stderr || '') + ' ' + (error?.stdout || '');
}

function isMissingHeadRevisionError(error) {
  const errorDetails = getGitErrorDetails(error).toLowerCase();
  return errorDetails.includes('unknown revision')
    || errorDetails.includes('ambiguous argument')
    || errorDetails.includes('needed a single revision')
    || errorDetails.includes('bad revision');
}

async function getCurrentBranchName(projectRuntime) {
  try {
    const { stdout } = await runGit(projectRuntime, ['symbolic-ref', '--short', 'HEAD']);
    const branchName = stdout.trim();
    if (branchName) {
      return branchName;
    }
  } catch {
    // Fall back to rev-parse for detached HEAD and older git edge cases.
  }

  const { stdout } = await runGit(projectRuntime, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return stdout.trim();
}

async function repositoryHasCommits(projectRuntime) {
  try {
    await runGit(projectRuntime, ['rev-parse', '--verify', 'HEAD']);
    return true;
  } catch (error) {
    if (isMissingHeadRevisionError(error)) {
      return false;
    }
    throw error;
  }
}

async function getRepositoryRootPath(projectRuntime) {
  const { stdout } = await runGit(projectRuntime, ['rev-parse', '--show-toplevel']);
  return stdout.trim();
}

function normalizeRepositoryRelativeFilePath(filePath) {
  return String(filePath)
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '')
    .trim();
}

function parseStatusFilePaths(statusOutput) {
  return statusOutput
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim())
    .map((line) => {
      const statusPath = line.substring(3);
      const renamedFilePath = statusPath.split(' -> ')[1];
      return normalizeRepositoryRelativeFilePath(renamedFilePath || statusPath);
    })
    .filter(Boolean);
}

function buildFilePathCandidates(projectPath, repositoryRootPath, filePath) {
  const normalizedFilePath = normalizeRepositoryRelativeFilePath(filePath);
  const projectRelativePath = normalizeRepositoryRelativeFilePath(path.relative(repositoryRootPath, projectPath));
  const candidates = [normalizedFilePath];

  if (
    projectRelativePath
    && projectRelativePath !== '.'
    && !normalizedFilePath.startsWith(projectRelativePath + '/')
  ) {
    candidates.push(projectRelativePath + '/' + normalizedFilePath);
  }

  return Array.from(new Set(candidates.filter(Boolean)));
}

async function resolveRepositoryFilePath(projectRuntime, filePath) {
  validateFilePath(filePath);

  const repositoryRootPath = await getRepositoryRootPath(projectRuntime);
  const candidateFilePaths = buildFilePathCandidates(projectRuntime.projectPath, repositoryRootPath, filePath);

  for (const candidateFilePath of candidateFilePaths) {
    const { stdout } = await runGit(projectRuntime, ['status', '--porcelain', '--', candidateFilePath], { cwd: repositoryRootPath });
    if (stdout.trim()) {
      return {
        repositoryRootPath,
        repositoryRelativeFilePath: candidateFilePath,
      };
    }
  }

  const normalizedFilePath = normalizeRepositoryRelativeFilePath(filePath);
  if (!normalizedFilePath.includes('/')) {
    const { stdout: repositoryStatusOutput } = await runGit(projectRuntime, ['status', '--porcelain'], { cwd: repositoryRootPath });
    const changedFilePaths = parseStatusFilePaths(repositoryStatusOutput);
    const suffixMatches = changedFilePaths.filter(
      (changedFilePath) => changedFilePath === normalizedFilePath || changedFilePath.endsWith('/' + normalizedFilePath),
    );

    if (suffixMatches.length === 1) {
      return {
        repositoryRootPath,
        repositoryRelativeFilePath: suffixMatches[0],
      };
    }
  }

  return {
    repositoryRootPath,
    repositoryRelativeFilePath: candidateFilePaths[0],
  };
}

function getCommitMessageProjectCwd(projectRuntime) {
  return projectRuntime.adapter.context.runtime === 'local'
    ? projectRuntime.projectPath
    : process.cwd();
}

// Get git status for a project
router.get('/status', async (req, res) => {
  const { project } = req.query;

  if (!project) {
    return res.status(400).json({ error: 'Project name is required' });
  }

  try {
    const projectRuntime = await resolveGitProjectRuntime(project, req.user?.id || null);
    const projectPath = projectRuntime.projectPath;

    // Validate git repository
    await validateGitRepository(projectRuntime);

    const branch = await getCurrentBranchName(projectRuntime);
    const hasCommits = await repositoryHasCommits(projectRuntime);

    // Get git status
    const { stdout: statusOutput } = await runGit(projectRuntime, ['status', '--porcelain'], { cwd: projectPath });

    const modified = [];
    const added = [];
    const deleted = [];
    const untracked = [];

    statusOutput.split('\n').forEach(line => {
      if (!line.trim()) return;

      const status = line.substring(0, 2);
      const file = line.substring(3);

      if (status === 'M ' || status === ' M' || status === 'MM') {
        modified.push(file);
      } else if (status === 'A ' || status === 'AM') {
        added.push(file);
      } else if (status === 'D ' || status === ' D') {
        deleted.push(file);
      } else if (status === '??') {
        untracked.push(file);
      }
    });

    res.json({
      branch,
      hasCommits,
      modified,
      added,
      deleted,
      untracked
    });
  } catch (error) {
    console.error('Git status error:', error);
    res.json({
      error: error.message.includes('not a git repository') || error.message.includes('Project directory is not a git repository')
        ? error.message
        : 'Git operation failed',
      details: error.message.includes('not a git repository') || error.message.includes('Project directory is not a git repository')
        ? error.message
        : `Failed to get git status: ${error.message}`
    });
  }
});

// Get diff for a specific file
router.get('/diff', async (req, res) => {
  const { project, file } = req.query;
  
  if (!project || !file) {
    return res.status(400).json({ error: 'Project name and file path are required' });
  }

  try {
    const projectRuntime = await resolveGitProjectRuntime(project, req.user?.id || null);
    const projectPath = projectRuntime.projectPath;
    
    // Validate git repository
    await validateGitRepository(projectRuntime);

    const {
      repositoryRootPath,
      repositoryRelativeFilePath,
    } = await resolveRepositoryFilePath(projectRuntime, file);

    // Check if file is untracked or deleted
    const { stdout: statusOutput } = await runGit(projectRuntime, ['status', '--porcelain', '--', repositoryRelativeFilePath],
      { cwd: repositoryRootPath },
    );
    const isUntracked = statusOutput.startsWith('??');
    const isDeleted = statusOutput.trim().startsWith('D ') || statusOutput.trim().startsWith(' D');

    let diff;
    if (isUntracked) {
      const filePath = path.join(repositoryRootPath, repositoryRelativeFilePath);
      const fileStat = await projectRuntime.adapter.files.stat(filePath, { scopeRoot: repositoryRootPath });

      if (fileStat.entryType === 'directory') {
        diff = `Directory: ${repositoryRelativeFilePath}\n(Cannot show diff for directories)`;
      } else {
        const { content: fileContent } = await projectRuntime.adapter.files.readText(filePath, { scopeRoot: repositoryRootPath });
        const lines = fileContent.split('\n');
        diff = `--- /dev/null\n+++ b/${repositoryRelativeFilePath}\n@@ -0,0 +1,${lines.length} @@\n` +
               lines.map((line) => `+${line}`).join('\n');
      }
    } else if (isDeleted) {
      const { stdout: fileContent } = await runGit(projectRuntime, ['show', `HEAD:${repositoryRelativeFilePath}`],
        { cwd: repositoryRootPath },
      );
      const lines = fileContent.split('\n');
      diff = `--- a/${repositoryRelativeFilePath}\n+++ /dev/null\n@@ -1,${lines.length} +0,0 @@\n` +
             lines.map((line) => `-${line}`).join('\n');
    } else {
      const { stdout: unstagedDiff } = await runGit(projectRuntime, ['diff', '--', repositoryRelativeFilePath],
        { cwd: repositoryRootPath },
      );

      if (unstagedDiff) {
        diff = stripDiffHeaders(unstagedDiff);
      } else {
        const { stdout: stagedDiff } = await runGit(projectRuntime, ['diff', '--cached', '--', repositoryRelativeFilePath],
          { cwd: repositoryRootPath },
        );
        diff = stripDiffHeaders(stagedDiff) || '';
      }
    }

    res.json({ diff });
  } catch (error) {
    console.error('Git diff error:', error);
    res.json({ error: error.message });
  }
});

// Get file content with diff information for CodeEditor
router.get('/file-with-diff', async (req, res) => {
  const { project, file } = req.query;

  if (!project || !file) {
    return res.status(400).json({ error: 'Project name and file path are required' });
  }

  try {
    const projectRuntime = await resolveGitProjectRuntime(project, req.user?.id || null);
    const projectPath = projectRuntime.projectPath;

    // Validate git repository
    await validateGitRepository(projectRuntime);

    const {
      repositoryRootPath,
      repositoryRelativeFilePath,
    } = await resolveRepositoryFilePath(projectRuntime, file);

    // Check file status
    const { stdout: statusOutput } = await runGit(projectRuntime, ['status', '--porcelain', '--', repositoryRelativeFilePath],
      { cwd: repositoryRootPath },
    );
    const isUntracked = statusOutput.startsWith('??');
    const isDeleted = statusOutput.trim().startsWith('D ') || statusOutput.trim().startsWith(' D');

    let currentContent = '';
    let oldContent = '';

    if (isDeleted) {
      const { stdout: headContent } = await runGit(projectRuntime, ['show', `HEAD:${repositoryRelativeFilePath}`],
        { cwd: repositoryRootPath },
      );
      oldContent = headContent;
      currentContent = headContent;
    } else {
      const filePath = path.join(repositoryRootPath, repositoryRelativeFilePath);
      const fileStat = await projectRuntime.adapter.files.stat(filePath, { scopeRoot: repositoryRootPath });

      if (fileStat.entryType === 'directory') {
        return res.status(400).json({ error: 'Cannot show diff for directories' });
      }

      currentContent = (await projectRuntime.adapter.files.readText(filePath, { scopeRoot: repositoryRootPath })).content;

      if (!isUntracked) {
        try {
          const { stdout: headContent } = await runGit(projectRuntime, ['show', `HEAD:${repositoryRelativeFilePath}`],
            { cwd: repositoryRootPath },
          );
          oldContent = headContent;
        } catch {
          oldContent = '';
        }
      }
    }

    res.json({
      currentContent,
      oldContent,
      isDeleted,
      isUntracked
    });
  } catch (error) {
    console.error('Git file-with-diff error:', error);
    res.json({ error: error.message });
  }
});

// Create initial commit
router.post('/initial-commit', async (req, res) => {
  const { project } = req.body;

  if (!project) {
    return res.status(400).json({ error: 'Project name is required' });
  }

  try {
    const projectRuntime = await resolveGitProjectRuntime(project, req.user?.id || null);
    const projectPath = projectRuntime.projectPath;

    // Validate git repository
    await validateGitRepository(projectRuntime);

    // Check if there are already commits
    try {
      await runGit(projectRuntime, ['rev-parse', 'HEAD'], { cwd: projectPath });
      return res.status(400).json({ error: 'Repository already has commits. Use regular commit instead.' });
    } catch (error) {
      // No HEAD - this is good, we can create initial commit
    }

    // Add all files
    await runGit(projectRuntime, ['add', '.'], { cwd: projectPath });

    // Create initial commit
    const { stdout } = await runGit(projectRuntime, ['commit', '-m', 'Initial commit'], { cwd: projectPath });

    res.json({ success: true, output: stdout, message: 'Initial commit created successfully' });
  } catch (error) {
    console.error('Git initial commit error:', error);

    // Handle the case where there's nothing to commit
    if (error.message.includes('nothing to commit')) {
      return res.status(400).json({
        error: 'Nothing to commit',
        details: 'No files found in the repository. Add some files first.'
      });
    }

    res.status(500).json({ error: error.message });
  }
});

// Commit changes
router.post('/commit', async (req, res) => {
  const { project, message, files } = req.body;
  
  if (!project || !message || !files || files.length === 0) {
    return res.status(400).json({ error: 'Project name, commit message, and files are required' });
  }

  try {
    const projectRuntime = await resolveGitProjectRuntime(project, req.user?.id || null);
    const projectPath = projectRuntime.projectPath;
    
    // Validate git repository
    await validateGitRepository(projectRuntime);
    const repositoryRootPath = await getRepositoryRootPath(projectRuntime);
    
    // Stage selected files
    for (const file of files) {
      const { repositoryRelativeFilePath } = await resolveRepositoryFilePath(projectRuntime, file);
      await runGit(projectRuntime, ['add', '--', repositoryRelativeFilePath], { cwd: repositoryRootPath });
    }

    // Commit with message
    const { stdout } = await runGit(projectRuntime, ['commit', '-m', message], { cwd: repositoryRootPath });
    
    res.json({ success: true, output: stdout });
  } catch (error) {
    console.error('Git commit error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Revert latest local commit (keeps changes staged)
router.post('/revert-local-commit', async (req, res) => {
  const { project } = req.body;

  if (!project) {
    return res.status(400).json({ error: 'Project name is required' });
  }

  try {
    const projectRuntime = await resolveGitProjectRuntime(project, req.user?.id || null);
    const projectPath = projectRuntime.projectPath;
    await validateGitRepository(projectRuntime);

    try {
      await runGit(projectRuntime, ['rev-parse', '--verify', 'HEAD'], { cwd: projectPath });
    } catch (error) {
      return res.status(400).json({
        error: 'No local commit to revert',
        details: 'This repository has no commit yet.',
      });
    }

    try {
      // Soft reset rewinds one commit while preserving all file changes in the index.
      await runGit(projectRuntime, ['reset', '--soft', 'HEAD~1'], { cwd: projectPath });
    } catch (error) {
      const errorDetails = `${error.stderr || ''} ${error.message || ''}`;
      const isInitialCommit = errorDetails.includes('HEAD~1') &&
        (errorDetails.includes('unknown revision') || errorDetails.includes('ambiguous argument'));

      if (!isInitialCommit) {
        throw error;
      }

      // Initial commit has no parent; deleting HEAD uncommits it and keeps files staged.
      await runGit(projectRuntime, ['update-ref', '-d', 'HEAD'], { cwd: projectPath });
    }

    res.json({
      success: true,
      output: 'Latest local commit reverted successfully. Changes were kept staged.',
    });
  } catch (error) {
    console.error('Git revert local commit error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get list of branches
router.get('/branches', async (req, res) => {
  const { project } = req.query;
  
  if (!project) {
    return res.status(400).json({ error: 'Project name is required' });
  }

  try {
    const projectRuntime = await resolveGitProjectRuntime(project, req.user?.id || null);
    const projectPath = projectRuntime.projectPath;
    
    // Validate git repository
    await validateGitRepository(projectRuntime);
    
    // Get all branches
    const { stdout } = await runGit(projectRuntime, ['branch', '-a'], { cwd: projectPath });

    const rawLines = stdout
      .split('\n')
      .map(b => b.trim())
      .filter(b => b && !b.includes('->'));

    // Local branches (may start with '* ' for current)
    const localBranches = rawLines
      .filter(b => !b.startsWith('remotes/'))
      .map(b => (b.startsWith('* ') ? b.substring(2) : b));

    // Remote branches — strip 'remotes/<remote>/' prefix
    const remoteBranches = rawLines
      .filter(b => b.startsWith('remotes/'))
      .map(b => b.replace(/^remotes\/[^/]+\//, ''))
      .filter(name => !localBranches.includes(name)); // skip if already a local branch

    // Backward-compat flat list (local + unique remotes, deduplicated)
    const branches = [...localBranches, ...remoteBranches]
      .filter((b, i, arr) => arr.indexOf(b) === i);

    res.json({ branches, localBranches, remoteBranches });
  } catch (error) {
    console.error('Git branches error:', error);
    res.json({ error: error.message });
  }
});

// Checkout branch
router.post('/checkout', async (req, res) => {
  const { project, branch } = req.body;
  
  if (!project || !branch) {
    return res.status(400).json({ error: 'Project name and branch are required' });
  }

  try {
    const projectRuntime = await resolveGitProjectRuntime(project, req.user?.id || null);
    const projectPath = projectRuntime.projectPath;
    
    // Checkout the branch
    validateBranchName(branch);
    const { stdout } = await runGit(projectRuntime, ['checkout', branch], { cwd: projectPath });
    
    res.json({ success: true, output: stdout });
  } catch (error) {
    console.error('Git checkout error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create new branch
router.post('/create-branch', async (req, res) => {
  const { project, branch } = req.body;
  
  if (!project || !branch) {
    return res.status(400).json({ error: 'Project name and branch name are required' });
  }

  try {
    const projectRuntime = await resolveGitProjectRuntime(project, req.user?.id || null);
    const projectPath = projectRuntime.projectPath;
    
    // Create and checkout new branch
    validateBranchName(branch);
    const { stdout } = await runGit(projectRuntime, ['checkout', '-b', branch], { cwd: projectPath });
    
    res.json({ success: true, output: stdout });
  } catch (error) {
    console.error('Git create branch error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete a local branch
router.post('/delete-branch', async (req, res) => {
  const { project, branch } = req.body;

  if (!project || !branch) {
    return res.status(400).json({ error: 'Project name and branch name are required' });
  }

  try {
    const projectRuntime = await resolveGitProjectRuntime(project, req.user?.id || null);
    const projectPath = projectRuntime.projectPath;
    await validateGitRepository(projectRuntime);

    // Safety: cannot delete the currently checked-out branch
    const { stdout: currentBranch } = await runGit(projectRuntime, ['branch', '--show-current'], { cwd: projectPath });
    if (currentBranch.trim() === branch) {
      return res.status(400).json({ error: 'Cannot delete the currently checked-out branch' });
    }

    const { stdout } = await runGit(projectRuntime, ['branch', '-d', branch], { cwd: projectPath });
    res.json({ success: true, output: stdout });
  } catch (error) {
    console.error('Git delete branch error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get recent commits
router.get('/commits', async (req, res) => {
  const { project, limit = 10 } = req.query;
  
  if (!project) {
    return res.status(400).json({ error: 'Project name is required' });
  }

  try {
    const projectRuntime = await resolveGitProjectRuntime(project, req.user?.id || null);
    const projectPath = projectRuntime.projectPath;
    await validateGitRepository(projectRuntime);
    const parsedLimit = Number.parseInt(String(limit), 10);
    const safeLimit = Number.isFinite(parsedLimit) && parsedLimit > 0
      ? Math.min(parsedLimit, 100)
      : 10;
    
    // Get commit log with stats
    const { stdout } = await runGit(projectRuntime, ['log', '--pretty=format:%H|%an|%ae|%ad|%s', '--date=iso-strict', '-n', String(safeLimit)],
      { cwd: projectPath },
    );
    
    const commits = stdout
      .split('\n')
      .filter(line => line.trim())
      .map(line => {
        const [hash, author, email, date, ...messageParts] = line.split('|');
        return {
          hash,
          author,
          email,
          date,
          message: messageParts.join('|')
        };
      });
    
    // Get stats for each commit
    for (const commit of commits) {
      try {
        const { stdout: stats } = await runGit(projectRuntime, ['show', '--stat', '--format=', commit.hash],
          { cwd: projectPath }
        );
        commit.stats = stats.trim().split('\n').pop(); // Get the summary line
      } catch (error) {
        commit.stats = '';
      }
    }
    
    res.json({ commits });
  } catch (error) {
    console.error('Git commits error:', error);
    res.json({ error: error.message });
  }
});

// Get diff for a specific commit
router.get('/commit-diff', async (req, res) => {
  const { project, commit } = req.query;
  
  if (!project || !commit) {
    return res.status(400).json({ error: 'Project name and commit hash are required' });
  }

  try {
    const projectRuntime = await resolveGitProjectRuntime(project, req.user?.id || null);
    const projectPath = projectRuntime.projectPath;

    // Validate commit reference (defense-in-depth)
    validateCommitRef(commit);

    // Get diff for the commit
    const { stdout } = await runGit(projectRuntime, ['show', commit],
      { cwd: projectPath }
    );

    const isTruncated = stdout.length > COMMIT_DIFF_CHARACTER_LIMIT;
    const diff = isTruncated
      ? `${stdout.slice(0, COMMIT_DIFF_CHARACTER_LIMIT)}\n\n... Diff truncated to keep the UI responsive ...`
      : stdout;

    res.json({ diff, isTruncated });
  } catch (error) {
    console.error('Git commit diff error:', error);
    res.json({ error: error.message });
  }
});

// Generate commit message based on staged changes using AI
router.post('/generate-commit-message', async (req, res) => {
  const { project, files, provider = 'claude' } = req.body;

  if (!project || !files || files.length === 0) {
    return res.status(400).json({ error: 'Project name and files are required' });
  }

  // Validate provider
  if (!['claude', 'cursor'].includes(provider)) {
    return res.status(400).json({ error: 'provider must be "claude" or "cursor"' });
  }

  try {
    const projectRuntime = await resolveGitProjectRuntime(project, req.user?.id || null);
    const projectPath = projectRuntime.projectPath;
    await validateGitRepository(projectRuntime);
    const repositoryRootPath = await getRepositoryRootPath(projectRuntime);

    // Get diff for selected files
    let diffContext = '';
    for (const file of files) {
      try {
        const { repositoryRelativeFilePath } = await resolveRepositoryFilePath(projectRuntime, file);
        const { stdout } = await runGit(projectRuntime, ['diff', 'HEAD', '--', repositoryRelativeFilePath],
          { cwd: repositoryRootPath }
        );
        if (stdout) {
          diffContext += `\n--- ${repositoryRelativeFilePath} ---\n${stdout}`;
        }
      } catch (error) {
        console.error(`Error getting diff for ${file}:`, error);
      }
    }

    // If no diff found, might be untracked files
    if (!diffContext.trim()) {
      for (const file of files) {
        try {
          const { repositoryRelativeFilePath } = await resolveRepositoryFilePath(projectRuntime, file);
          const filePath = path.join(repositoryRootPath, repositoryRelativeFilePath);
          const fileStat = await projectRuntime.adapter.files.stat(filePath, { scopeRoot: repositoryRootPath });

          if (fileStat.entryType !== 'directory') {
            const content = (await projectRuntime.adapter.files.readText(filePath, { scopeRoot: repositoryRootPath })).content;
            diffContext += `\n--- ${repositoryRelativeFilePath} (new file) ---\n${content.substring(0, 1000)}\n`;
          } else {
            diffContext += `\n--- ${repositoryRelativeFilePath} (new directory) ---\n`;
          }
        } catch (error) {
          console.error(`Error reading file ${file}:`, error);
        }
      }
    }

    // Generate commit message using AI
    const message = await generateCommitMessageWithAI(files, diffContext, provider, getCommitMessageProjectCwd(projectRuntime));

    res.json({ message });
  } catch (error) {
    console.error('Generate commit message error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Generates a commit message using AI (Claude SDK or Cursor CLI)
 * @param {Array<string>} files - List of changed files
 * @param {string} diffContext - Git diff content
 * @param {string} provider - 'claude' or 'cursor'
 * @param {string} projectPath - Project directory path
 * @returns {Promise<string>} Generated commit message
 */
async function generateCommitMessageWithAI(files, diffContext, provider, projectPath) {
  // Create the prompt
  const prompt = `Generate a conventional commit message for these changes.

REQUIREMENTS:
- Format: type(scope): subject
- Include body explaining what changed and why
- Types: feat, fix, docs, style, refactor, perf, test, build, ci, chore
- Subject under 50 chars, body wrapped at 72 chars
- Focus on user-facing changes, not implementation details
- Consider what's being added AND removed
- Return ONLY the commit message (no markdown, explanations, or code blocks)

FILES CHANGED:
${files.map(f => `- ${f}`).join('\n')}

DIFFS:
${diffContext.substring(0, 4000)}

Generate the commit message:`;

  try {
    // Create a simple writer that collects the response
    let responseText = '';
    const writer = {
      send: (data) => {
        try {
          const parsed = typeof data === 'string' ? JSON.parse(data) : data;
          console.log('🔍 Writer received message type:', parsed.type);

          // Handle different message formats from Claude SDK and Cursor CLI
          // Claude SDK sends: {type: 'claude-response', data: {message: {content: [...]}}}
          if (parsed.type === 'claude-response' && parsed.data) {
            const message = parsed.data.message || parsed.data;
            console.log('📦 Claude response message:', JSON.stringify(message, null, 2).substring(0, 500));
            if (message.content && Array.isArray(message.content)) {
              // Extract text from content array
              for (const item of message.content) {
                if (item.type === 'text' && item.text) {
                  console.log('✅ Extracted text chunk:', item.text.substring(0, 100));
                  responseText += item.text;
                }
              }
            }
          }
          // Cursor CLI sends: {type: 'cursor-output', output: '...'}
          else if (parsed.type === 'cursor-output' && parsed.output) {
            console.log('✅ Cursor output:', parsed.output.substring(0, 100));
            responseText += parsed.output;
          }
          // Also handle direct text messages
          else if (parsed.type === 'text' && parsed.text) {
            console.log('✅ Direct text:', parsed.text.substring(0, 100));
            responseText += parsed.text;
          }
        } catch (e) {
          // Ignore parse errors
          console.error('Error parsing writer data:', e);
        }
      },
      setSessionId: () => {}, // No-op for this use case
    };

    console.log('🚀 Calling AI agent with provider:', provider);
    console.log('📝 Prompt length:', prompt.length);

    // Call the appropriate agent
    if (provider === 'claude') {
      await queryClaudeSDK(prompt, {
        cwd: projectPath,
        permissionMode: 'bypassPermissions',
        model: 'sonnet'
      }, writer);
    } else if (provider === 'cursor') {
      await spawnCursor(prompt, {
        cwd: projectPath,
        skipPermissions: true
      }, writer);
    }

    console.log('📊 Total response text collected:', responseText.length, 'characters');
    console.log('📄 Response preview:', responseText.substring(0, 200));

    // Clean up the response
    const cleanedMessage = cleanCommitMessage(responseText);
    console.log('🧹 Cleaned message:', cleanedMessage.substring(0, 200));

    return cleanedMessage || 'chore: update files';
  } catch (error) {
    console.error('Error generating commit message with AI:', error);
    // Fallback to simple message
    return `chore: update ${files.length} file${files.length !== 1 ? 's' : ''}`;
  }
}

/**
 * Cleans the AI-generated commit message by removing markdown, code blocks, and extra formatting
 * @param {string} text - Raw AI response
 * @returns {string} Clean commit message
 */
function cleanCommitMessage(text) {
  if (!text || !text.trim()) {
    return '';
  }

  let cleaned = text.trim();

  // Remove markdown code blocks
  cleaned = cleaned.replace(/```[a-z]*\n/g, '');
  cleaned = cleaned.replace(/```/g, '');

  // Remove markdown headers
  cleaned = cleaned.replace(/^#+\s*/gm, '');

  // Remove leading/trailing quotes
  cleaned = cleaned.replace(/^["']|["']$/g, '');

  // If there are multiple lines, take everything (subject + body)
  // Just clean up extra blank lines
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

  // Remove any explanatory text before the actual commit message
  // Look for conventional commit pattern and start from there
  const conventionalCommitMatch = cleaned.match(/(feat|fix|docs|style|refactor|perf|test|build|ci|chore)(\(.+?\))?:.+/s);
  if (conventionalCommitMatch) {
    cleaned = cleaned.substring(cleaned.indexOf(conventionalCommitMatch[0]));
  }

  return cleaned.trim();
}

// Get remote status (ahead/behind commits with smart remote detection)
router.get('/remote-status', async (req, res) => {
  const { project } = req.query;
  
  if (!project) {
    return res.status(400).json({ error: 'Project name is required' });
  }

  try {
    const projectRuntime = await resolveGitProjectRuntime(project, req.user?.id || null);
    const projectPath = projectRuntime.projectPath;
    await validateGitRepository(projectRuntime);

    const branch = await getCurrentBranchName(projectRuntime);
    const hasCommits = await repositoryHasCommits(projectRuntime);

    const { stdout: remoteOutput } = await runGit(projectRuntime, ['remote'], { cwd: projectPath });
    const remotes = remoteOutput.trim().split('\n').filter(r => r.trim());
    const hasRemote = remotes.length > 0;
    const fallbackRemoteName = hasRemote
      ? (remotes.includes('origin') ? 'origin' : remotes[0])
      : null;

    // Repositories initialized with `git init` can have a branch but no commits.
    // Return a non-error state so the UI can show the initial-commit workflow.
    if (!hasCommits) {
      return res.json({
        hasRemote,
        hasUpstream: false,
        branch,
        remoteName: fallbackRemoteName,
        ahead: 0,
        behind: 0,
        isUpToDate: false,
        message: 'Repository has no commits yet'
      });
    }

    // Check if there's a remote tracking branch (smart detection)
    let trackingBranch;
    let remoteName;
    try {
      const { stdout } = await runGit(projectRuntime, ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`], { cwd: projectPath });
      trackingBranch = stdout.trim();
      remoteName = trackingBranch.split('/')[0]; // Extract remote name (e.g., "origin/main" -> "origin")
    } catch (error) {
      return res.json({
        hasRemote,
        hasUpstream: false,
        branch,
        remoteName: fallbackRemoteName,
        message: 'No remote tracking branch configured'
      });
    }

    // Get ahead/behind counts
    const { stdout: countOutput } = await runGit(projectRuntime, ['rev-list', '--count', '--left-right', `${trackingBranch}...HEAD`],
      { cwd: projectPath }
    );
    
    const [behind, ahead] = countOutput.trim().split('\t').map(Number);

    res.json({
      hasRemote: true,
      hasUpstream: true,
      branch,
      remoteBranch: trackingBranch,
      remoteName,
      ahead: ahead || 0,
      behind: behind || 0,
      isUpToDate: ahead === 0 && behind === 0
    });
  } catch (error) {
    console.error('Git remote status error:', error);
    res.json({ error: error.message });
  }
});

// Fetch from remote (using smart remote detection)
router.post('/fetch', async (req, res) => {
  const { project } = req.body;
  
  if (!project) {
    return res.status(400).json({ error: 'Project name is required' });
  }

  try {
    const projectRuntime = await resolveGitProjectRuntime(project, req.user?.id || null);
    const projectPath = projectRuntime.projectPath;
    await validateGitRepository(projectRuntime);

    // Get current branch and its upstream remote
    const branch = await getCurrentBranchName(projectRuntime);

    let remoteName = 'origin'; // fallback
    try {
      const { stdout } = await runGit(projectRuntime, ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`], { cwd: projectPath });
      remoteName = stdout.trim().split('/')[0]; // Extract remote name
    } catch (error) {
      // No upstream, try to fetch from origin anyway
      console.log('No upstream configured, using origin as fallback');
    }

    validateRemoteName(remoteName);
    const { stdout } = await runGit(projectRuntime, ['fetch', remoteName], { cwd: projectPath });

    res.json({ success: true, output: stdout || 'Fetch completed successfully', remoteName });
  } catch (error) {
    console.error('Git fetch error:', error);
    res.status(500).json({ 
      error: 'Fetch failed', 
      details: error.message.includes('Could not resolve hostname') 
        ? 'Unable to connect to remote repository. Check your internet connection.'
        : error.message.includes('fatal: \'origin\' does not appear to be a git repository')
        ? 'No remote repository configured. Add a remote with: git remote add origin <url>'
        : error.message
    });
  }
});

// Pull from remote (fetch + merge using smart remote detection)
router.post('/pull', async (req, res) => {
  const { project } = req.body;
  
  if (!project) {
    return res.status(400).json({ error: 'Project name is required' });
  }

  try {
    const projectRuntime = await resolveGitProjectRuntime(project, req.user?.id || null);
    const projectPath = projectRuntime.projectPath;
    await validateGitRepository(projectRuntime);

    // Get current branch and its upstream remote
    const branch = await getCurrentBranchName(projectRuntime);

    let remoteName = 'origin'; // fallback
    let remoteBranch = branch; // fallback
    try {
      const { stdout } = await runGit(projectRuntime, ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`], { cwd: projectPath });
      const tracking = stdout.trim();
      remoteName = tracking.split('/')[0]; // Extract remote name
      remoteBranch = tracking.split('/').slice(1).join('/'); // Extract branch name
    } catch (error) {
      // No upstream, use fallback
      console.log('No upstream configured, using origin/branch as fallback');
    }

    validateRemoteName(remoteName);
    validateBranchName(remoteBranch);
    const { stdout } = await runGit(projectRuntime, ['pull', remoteName, remoteBranch], { cwd: projectPath });

    res.json({
      success: true,
      output: stdout || 'Pull completed successfully',
      remoteName,
      remoteBranch
    });
  } catch (error) {
    console.error('Git pull error:', error);

    // Enhanced error handling for common pull scenarios
    let errorMessage = 'Pull failed';
    let details = error.message;
    
    if (error.message.includes('CONFLICT')) {
      errorMessage = 'Merge conflicts detected';
      details = 'Pull created merge conflicts. Please resolve conflicts manually in the editor, then commit the changes.';
    } else if (error.message.includes('Please commit your changes or stash them')) {
      errorMessage = 'Uncommitted changes detected';  
      details = 'Please commit or stash your local changes before pulling.';
    } else if (error.message.includes('Could not resolve hostname')) {
      errorMessage = 'Network error';
      details = 'Unable to connect to remote repository. Check your internet connection.';
    } else if (error.message.includes('fatal: \'origin\' does not appear to be a git repository')) {
      errorMessage = 'Remote not configured';
      details = 'No remote repository configured. Add a remote with: git remote add origin <url>';
    } else if (error.message.includes('diverged')) {
      errorMessage = 'Branches have diverged';
      details = 'Your local branch and remote branch have diverged. Consider fetching first to review changes.';
    }
    
    res.status(500).json({ 
      error: errorMessage, 
      details: details
    });
  }
});

// Push commits to remote repository
router.post('/push', async (req, res) => {
  const { project } = req.body;
  
  if (!project) {
    return res.status(400).json({ error: 'Project name is required' });
  }

  try {
    const projectRuntime = await resolveGitProjectRuntime(project, req.user?.id || null);
    const projectPath = projectRuntime.projectPath;
    await validateGitRepository(projectRuntime);

    // Get current branch and its upstream remote
    const branch = await getCurrentBranchName(projectRuntime);

    let remoteName = 'origin'; // fallback
    let remoteBranch = branch; // fallback
    try {
      const { stdout } = await runGit(projectRuntime, ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`], { cwd: projectPath });
      const tracking = stdout.trim();
      remoteName = tracking.split('/')[0]; // Extract remote name
      remoteBranch = tracking.split('/').slice(1).join('/'); // Extract branch name
    } catch (error) {
      // No upstream, use fallback
      console.log('No upstream configured, using origin/branch as fallback');
    }

    validateRemoteName(remoteName);
    validateBranchName(remoteBranch);
    const { stdout } = await runGit(projectRuntime, ['push', remoteName, remoteBranch], { cwd: projectPath });

    res.json({
      success: true,
      output: stdout || 'Push completed successfully',
      remoteName,
      remoteBranch
    });
  } catch (error) {
    console.error('Git push error:', error);
    
    // Enhanced error handling for common push scenarios
    let errorMessage = 'Push failed';
    let details = error.message;
    
    if (error.message.includes('rejected')) {
      errorMessage = 'Push rejected';
      details = 'The remote has newer commits. Pull first to merge changes before pushing.';
    } else if (error.message.includes('non-fast-forward')) {
      errorMessage = 'Non-fast-forward push';
      details = 'Your branch is behind the remote. Pull the latest changes first.';
    } else if (error.message.includes('Could not resolve hostname')) {
      errorMessage = 'Network error';
      details = 'Unable to connect to remote repository. Check your internet connection.';
    } else if (error.message.includes('fatal: \'origin\' does not appear to be a git repository')) {
      errorMessage = 'Remote not configured';
      details = 'No remote repository configured. Add a remote with: git remote add origin <url>';
    } else if (error.message.includes('Permission denied')) {
      errorMessage = 'Authentication failed';
      details = 'Permission denied. Check your credentials or SSH keys.';
    } else if (error.message.includes('no upstream branch')) {
      errorMessage = 'No upstream branch';
      details = 'No upstream branch configured. Use: git push --set-upstream origin <branch>';
    }
    
    res.status(500).json({ 
      error: errorMessage, 
      details: details
    });
  }
});

// Publish branch to remote (set upstream and push)
router.post('/publish', async (req, res) => {
  const { project, branch } = req.body;
  
  if (!project || !branch) {
    return res.status(400).json({ error: 'Project name and branch are required' });
  }

  try {
    const projectRuntime = await resolveGitProjectRuntime(project, req.user?.id || null);
    const projectPath = projectRuntime.projectPath;
    await validateGitRepository(projectRuntime);

    // Validate branch name
    validateBranchName(branch);

    // Get current branch to verify it matches the requested branch
    const currentBranchName = await getCurrentBranchName(projectRuntime);

    if (currentBranchName !== branch) {
      return res.status(400).json({
        error: `Branch mismatch. Current branch is ${currentBranchName}, but trying to publish ${branch}`
      });
    }

    // Check if remote exists
    let remoteName = 'origin';
    try {
      const { stdout } = await runGit(projectRuntime, ['remote'], { cwd: projectPath });
      const remotes = stdout.trim().split('\n').filter(r => r.trim());
      if (remotes.length === 0) {
        return res.status(400).json({
          error: 'No remote repository configured. Add a remote with: git remote add origin <url>'
        });
      }
      remoteName = remotes.includes('origin') ? 'origin' : remotes[0];
    } catch (error) {
      return res.status(400).json({
        error: 'No remote repository configured. Add a remote with: git remote add origin <url>'
      });
    }

    // Publish the branch (set upstream and push)
    validateRemoteName(remoteName);
    const { stdout } = await runGit(projectRuntime, ['push', '--set-upstream', remoteName, branch], { cwd: projectPath });
    
    res.json({ 
      success: true, 
      output: stdout || 'Branch published successfully', 
      remoteName,
      branch
    });
  } catch (error) {
    console.error('Git publish error:', error);
    
    // Enhanced error handling for common publish scenarios
    let errorMessage = 'Publish failed';
    let details = error.message;
    
    if (error.message.includes('rejected')) {
      errorMessage = 'Publish rejected';
      details = 'The remote branch already exists and has different commits. Use push instead.';
    } else if (error.message.includes('Could not resolve hostname')) {
      errorMessage = 'Network error';
      details = 'Unable to connect to remote repository. Check your internet connection.';
    } else if (error.message.includes('Permission denied')) {
      errorMessage = 'Authentication failed';
      details = 'Permission denied. Check your credentials or SSH keys.';
    } else if (error.message.includes('fatal:') && error.message.includes('does not appear to be a git repository')) {
      errorMessage = 'Remote not configured';
      details = 'Remote repository not properly configured. Check your remote URL.';
    }
    
    res.status(500).json({ 
      error: errorMessage, 
      details: details
    });
  }
});

// Discard changes for a specific file
router.post('/discard', async (req, res) => {
  const { project, file } = req.body;
  
  if (!project || !file) {
    return res.status(400).json({ error: 'Project name and file path are required' });
  }

  try {
    const projectRuntime = await resolveGitProjectRuntime(project, req.user?.id || null);
    const projectPath = projectRuntime.projectPath;
    await validateGitRepository(projectRuntime);
    const {
      repositoryRootPath,
      repositoryRelativeFilePath,
    } = await resolveRepositoryFilePath(projectRuntime, file);

    // Check file status to determine correct discard command
    const { stdout: statusOutput } = await runGit(projectRuntime, ['status', '--porcelain', '--', repositoryRelativeFilePath],
      { cwd: repositoryRootPath },
    );

    if (!statusOutput.trim()) {
      return res.status(400).json({ error: 'No changes to discard for this file' });
    }

    const status = statusOutput.substring(0, 2);

    if (status === '??') {
      const filePath = path.join(repositoryRootPath, repositoryRelativeFilePath);
      await projectRuntime.adapter.files.deleteEntry(filePath, { scopeRoot: repositoryRootPath });
    } else if (status.includes('M') || status.includes('D')) {
      // Modified or deleted file - restore from HEAD
      await runGit(projectRuntime, ['restore', '--', repositoryRelativeFilePath], { cwd: repositoryRootPath });
    } else if (status.includes('A')) {
      // Added file - unstage it
      await runGit(projectRuntime, ['reset', 'HEAD', '--', repositoryRelativeFilePath], { cwd: repositoryRootPath });
    }
    
    res.json({ success: true, message: `Changes discarded for ${repositoryRelativeFilePath}` });
  } catch (error) {
    console.error('Git discard error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete untracked file
router.post('/delete-untracked', async (req, res) => {
  const { project, file } = req.body;
  
  if (!project || !file) {
    return res.status(400).json({ error: 'Project name and file path are required' });
  }

  try {
    const projectRuntime = await resolveGitProjectRuntime(project, req.user?.id || null);
    const projectPath = projectRuntime.projectPath;
    await validateGitRepository(projectRuntime);
    const {
      repositoryRootPath,
      repositoryRelativeFilePath,
    } = await resolveRepositoryFilePath(projectRuntime, file);

    // Check if file is actually untracked
    const { stdout: statusOutput } = await runGit(projectRuntime, ['status', '--porcelain', '--', repositoryRelativeFilePath],
      { cwd: repositoryRootPath },
    );
    
    if (!statusOutput.trim()) {
      return res.status(400).json({ error: 'File is not untracked or does not exist' });
    }

    const status = statusOutput.substring(0, 2);
    
    if (status !== '??') {
      return res.status(400).json({ error: 'File is not untracked. Use discard for tracked files.' });
    }

    const filePath = path.join(repositoryRootPath, repositoryRelativeFilePath);
    const fileStat = await projectRuntime.adapter.files.stat(filePath, { scopeRoot: repositoryRootPath });
    await projectRuntime.adapter.files.deleteEntry(filePath, { scopeRoot: repositoryRootPath });

    if (fileStat.entryType === 'directory') {
      res.json({ success: true, message: `Untracked directory ${repositoryRelativeFilePath} deleted successfully` });
    } else {
      res.json({ success: true, message: `Untracked file ${repositoryRelativeFilePath} deleted successfully` });
    }
  } catch (error) {
    console.error('Git delete untracked error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
