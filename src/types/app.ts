export type SessionProvider = 'claude' | 'cursor' | 'codex' | 'gemini' | 'e2b';
export type RuntimeMode = 'local' | 'e2b';
export type ProjectKind = 'local' | 'cloud';

export interface CloudProjectMeta {
  sandboxId: string;
  status?: string;
  repoUrl?: string | null;
  branch?: string | null;
  workspacePath?: string | null;
  createdAt?: string;
  lastActivity?: string;
  metadata?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export type AppTab = 'chat' | 'files' | 'shell' | 'git' | 'tasks' | 'preview' | `plugin:${string}`;

export interface ProjectSession {
  id: string;
  title?: string;
  summary?: string;
  name?: string;
  createdAt?: string;
  created_at?: string;
  updated_at?: string;
  lastActivity?: string;
  messageCount?: number;
  forkedFromId?: string | null;
  forkChildCount?: number;
  forkChildIds?: string[];
  __provider?: SessionProvider;
  __projectName?: string;
  __projectPath?: string;
  __runtime?: RuntimeMode;
  [key: string]: unknown;
}

export interface ProjectSessionMeta {
  total?: number;
  hasMore?: boolean;
  byProvider?: Partial<Record<Exclude<SessionProvider, 'e2b'>, {
    total?: number;
    hasMore?: boolean;
  }>>;
  [key: string]: unknown;
}

export interface ProjectCapabilities {
  files: boolean;
  git: boolean;
  shell: boolean;
}

export interface ProjectTaskmasterInfo {
  hasTaskmaster?: boolean;
  status?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface Project {
  name: string;
  displayName: string;
  fullPath: string;
  path?: string;
  kind?: ProjectKind;
  runtime?: RuntimeMode;
  capabilities?: ProjectCapabilities;
  authSelections?: Record<string, unknown> | null;
  cloud?: CloudProjectMeta;
  sessions?: ProjectSession[];
  cursorSessions?: ProjectSession[];
  codexSessions?: ProjectSession[];
  geminiSessions?: ProjectSession[];
  e2bSessions?: ProjectSession[];
  sessionMeta?: ProjectSessionMeta;
  taskmaster?: ProjectTaskmasterInfo;
  [key: string]: unknown;
}

export interface LoadingProgress {
  type?: 'loading_progress';
  phase?: string;
  current: number;
  total: number;
  currentProject?: string;
  [key: string]: unknown;
}

export interface ProjectsUpdatedMessage {
  type: 'projects_updated';
  projects: Project[];
  changedFile?: string;
  [key: string]: unknown;
}

export interface LoadingProgressMessage extends LoadingProgress {
  type: 'loading_progress';
}

export interface SessionBootstrapResponse {
  provider: SessionProvider;
  project: Project;
  session: ProjectSession;
}

export type AppSocketMessage =
  | LoadingProgressMessage
  | ProjectsUpdatedMessage
  | { type?: string;[key: string]: unknown };
