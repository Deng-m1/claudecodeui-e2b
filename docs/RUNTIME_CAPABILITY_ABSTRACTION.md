# Runtime Capability Abstraction

## Goal

Unify IDE-facing project capabilities behind a runtime adapter layer so that:

1. Local projects keep using host filesystem, host git, and host PTY.
2. Cloud projects use a runtime-specific backend without leaking runtime checks into route handlers.
3. Future runtimes such as Docker, Daytona, Modal, or other container providers can plug in by implementing the same capability contract.

This document is intentionally implementation-facing. The code should follow the structure here unless there is a strong reason to deviate.

## Problem Summary

Today the backend has three different categories of project-facing capabilities:

- Filesystem: file tree, file read/write, create/rename/delete, upload.
- Git: status, diff, branch operations, commit operations, fetch/pull/push/publish.
- Shell: interactive terminal.

All three are currently coupled to the host runtime in different ways:

- File routes resolve the project root with `extractProjectDirectory(projectName)` and then directly call `fs`.
- Git routes resolve the project root the same way and then directly call `spawn('git', ...)` on the host.
- Shell uses a dedicated backend WebSocket and `node-pty` on the host.

That makes E2B difficult not because it is "API-based" but because the current system assumes a single execution environment: the host machine.

## Design Principles

1. Route handlers must stop branching on runtime details.
2. Runtime selection happens once, in a dedicated resolver.
3. Runtimes expose capabilities, not implementation details.
4. Capability availability must be explicit so the frontend can gate tabs from facts instead of hard-coded `runtime === 'e2b'` checks.
5. Shell is part of the capability model even if not fully implemented for every runtime yet.

## Core Model

Each project resolves to a `ProjectRuntimeContext`:

```ts
type ProjectRuntime = 'local' | 'e2b';

type ProjectCapabilityFlags = {
  files: boolean;
  git: boolean;
  shell: boolean;
};

type ProjectRuntimeContext = {
  runtime: ProjectRuntime;
  projectName: string;
  projectRoot: string;
  userId: number | null;
  sandboxId?: string | null;
  capabilities: ProjectCapabilityFlags;
};
```

Each runtime then returns an adapter:

```ts
type ProjectRuntimeAdapter = {
  context: ProjectRuntimeContext;
  files: ProjectFilesCapability;
  git: ProjectGitCapability;
  shell: ProjectShellCapability;
};
```

## Capability Contracts

### Files

```ts
type ProjectFilesCapability = {
  getTree(): Promise<FileTreeNode[]>;
  readText(targetPath: string): Promise<{ content: string; path: string }>;
  readBinary(targetPath: string): Promise<{ content: Buffer; path: string }>;
  writeText(targetPath: string, content: string): Promise<{ path: string }>;
  createEntry(parentPath: string, entryType: 'file' | 'directory', name: string): Promise<{ path: string }>;
  renameEntry(oldPath: string, newName: string): Promise<{ from: string; to: string }>;
  deleteEntry(targetPath: string): Promise<{ path: string; entryType: 'file' | 'directory' }>;
  uploadBatch(targetDirectory: string, files: UploadBatchFile[]): Promise<UploadedFileRecord[]>;
};
```

### Git

```ts
type ProjectGitCapability = {
  getStatus(): Promise<GitStatusResult>;
  getDiff(filePath: string): Promise<{ diff: string }>;
  getFileWithDiff(filePath: string): Promise<GitFileWithDiffResult>;
  createInitialCommit(): Promise<GitOperationResult>;
  commit(message: string): Promise<GitOperationResult>;
  revertLocalCommit(): Promise<GitOperationResult>;
  listBranches(): Promise<GitBranchesResult>;
  checkout(branch: string): Promise<GitOperationResult>;
  createBranch(branch: string): Promise<GitOperationResult>;
  deleteBranch(branch: string): Promise<GitOperationResult>;
  listCommits(limit: number): Promise<GitCommitsResult>;
  getCommitDiff(commit: string): Promise<{ diff: string; isTruncated: boolean }>;
  fetch(): Promise<GitOperationResult>;
  pull(): Promise<GitOperationResult>;
  push(): Promise<GitOperationResult>;
  publish(): Promise<GitPublishResult>;
  discard(filePath: string): Promise<GitOperationResult>;
  deleteUntracked(filePath: string): Promise<GitOperationResult>;
};
```

### Shell

```ts
type ProjectShellCapability = {
  supported: boolean;
  transport: 'host-pty-websocket' | 'sandbox-process-terminal' | 'unsupported';
};
```

For the first implementation pass:

- `local`: files=true, git=true, shell=true
- `e2b`: files=true, git=true, shell=false

This is deliberate. We should not block files/git behind shell work.

## Adapter Registry

Add a single runtime resolver and registry:

- `resolveProjectRuntimeContext(projectName, { userId })`
- `getProjectRuntimeAdapter(projectName, { userId })`

The resolver determines:

- `local` if the project is host-backed
- `e2b` if the project name maps to a cloud sandbox (`e2b__<sandboxId>`)

The registry then dispatches to:

- `createLocalProjectRuntimeAdapter(context)`
- `createE2BProjectRuntimeAdapter(context)`

Future runtimes add a third adapter without touching route handlers.

## Local Runtime Implementation

The local adapter should wrap the existing logic instead of rewriting behavior:

- Files: `fs`, `fs/promises`, path validation, current recursive file-tree behavior.
- Git: `spawn('git', ...)` against the resolved host path.
- Shell: existing `/shell` WebSocket + `node-pty` continues unchanged for now.

The objective is structural isolation, not a behavior change.

## E2B Runtime Implementation

The E2B adapter should use `sandbox-agent` runtime primitives directly.

Preferred primitives:

- Filesystem:
  - `listFsEntries`
  - `readFsFile`
  - `writeFsFile`
  - `mkdirFs`
  - `moveFs`
  - `deleteFsEntry`
  - `statFs`
  - `uploadFsBatch`
- Process execution for git:
  - `runProcess({ command: 'git', args: [...] })`

This is better than tunneling everything through ad hoc shell scripts because:

- Path handling is clearer.
- Error boundaries are tighter.
- The adapter surface matches future container runtimes that may also expose explicit fs/process APIs.

## Frontend Capability Gating

The frontend should stop assuming:

- cloud project => chat only

Instead it should read `project.capabilities` and gate tabs by capability:

- `chat`: always
- `files`: when `capabilities.files`
- `git`: when `capabilities.git`
- `shell`: when `capabilities.shell`

For the first pass this means E2B projects should get `chat + files + git` but still hide `shell`.

## Rollout Plan

### Phase 1

- Introduce runtime context + adapter registry.
- Implement `local` and `e2b` file capabilities.
- Implement `local` and `e2b` git capabilities.
- Add `project.capabilities` to backend project payloads.
- Update frontend tab gating to use capabilities.

### Phase 2

- Move shell behind the same adapter model.
- Implement E2B shell via sandbox process terminal streaming.
- Replace `runtime === 'e2b'` UI guards with capability checks everywhere.

### Phase 3

- Extract route handlers out of `server/index.js` so file APIs live beside git APIs under a single project-capability service boundary.
- Add another runtime implementation to validate the abstraction under a non-E2B cloud/container backend.

## Review Checklist

Every change in this area should be reviewed from at least these angles:

1. Architecture: are routes consuming capability interfaces rather than runtime branches?
2. Security: are path validation and destructive operations still runtime-safe?
3. Regression risk: does the local adapter preserve current local behavior?
4. Product behavior: does the frontend only expose tabs backed by actual capabilities?
5. Extensibility: could a third runtime be added without editing route handlers?

## Explicit Non-Goals For This Pass

- Full E2B shell implementation.
- Reworking session/chat transport.
- Multi-sandbox concurrency redesign.
- Real-account browser validation in CI-like environments.

Those can build on this abstraction, but they should not block files/git enablement.
