import { Check, ChevronDown, ChevronRight, Cloud, Edit3, Folder, FolderOpen, Star, Trash2, X, MoreVertical } from 'lucide-react';
import type React from 'react';
import type { TFunction } from 'i18next';
import { cn } from '../../../../lib/utils';
import type { Project, ProjectSession, RuntimeMode, SessionProvider } from '../../../../types/app';
import type { MCPServerStatus, SidebarSessionProviderFilter, SessionWithProvider } from '../../types/types';
import { getTaskIndicatorStatus, resolveProjectLoadMoreProvider } from '../../utils/utils';
import { isCloudProject as isResolvedCloudProject } from '../../../../utils/sessionSelection';
import TaskIndicator from './TaskIndicator';
import SidebarProjectSessions from './SidebarProjectSessions';
import ProjectActionsMenu from './ProjectActionsMenu';

type SidebarProjectItemProps = {
  project: Project;
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  isExpanded: boolean;
  isDeleting: boolean;
  isStarred: boolean;
  editingProject: string | null;
  editingName: string;
  sessions: SessionWithProvider[];
  initialSessionsLoaded: boolean;
  isLoadingSessions: boolean;
  currentTime: Date;
  sessionProviderFilter: SidebarSessionProviderFilter;
  editingSession: string | null;
  editingSessionName: string;
  tasksEnabled: boolean;
  mcpServerStatus: MCPServerStatus;
  onEditingNameChange: (name: string) => void;
  onToggleProject: (projectName: string) => void;
  onProjectSelect: (project: Project) => void;
  onToggleStarProject: (projectName: string) => void;
  onStartEditingProject: (project: Project) => void;
  onCancelEditingProject: () => void;
  onSaveProjectName: (projectName: string) => void;
  onDeleteProject: (project: Project) => void;
  onSessionSelect: (session: SessionWithProvider, projectName: string) => void;
  onDeleteSession: (
    projectName: string,
    sessionId: string,
    sessionTitle: string,
    provider: SessionProvider,
    runtime?: RuntimeMode,
  ) => void;
  onLoadMoreSessions: (project: Project) => void;
  onNewSession: (project: Project) => void;
  onEditingSessionNameChange: (value: string) => void;
  onStartEditingSession: (sessionId: string, initialName: string) => void;
  onCancelEditingSession: () => void;
  onSaveEditingSession: (
    projectName: string,
    sessionId: string,
    summary: string,
    provider: SessionProvider,
    runtime: RuntimeMode,
  ) => void;
  t: TFunction;
};

const getSessionCountDisplay = (sessions: SessionWithProvider[], hasMoreSessions: boolean): string => {
  const sessionCount = sessions.length;
  if (hasMoreSessions && sessionCount >= 5) {
    return `${sessionCount}+`;
  }

  return `${sessionCount}`;
};

const truncatePath = (value?: string | null, keep = 28) => {
  if (!value) {
    return '';
  }

  return value.length > keep ? `...${value.slice(-(keep - 3))}` : value;
};

const getCloudRepoLabel = (repoUrl?: string | null) => {
  if (!repoUrl) {
    return '';
  }

  const normalized = repoUrl.replace(/\.git$/, '');
  const githubIndex = normalized.indexOf('github.com/');
  if (githubIndex >= 0) {
    return normalized.slice(githubIndex + 'github.com/'.length);
  }

  const pieces = normalized.split('/').filter(Boolean);
  return pieces.slice(-2).join('/');
};

const getShortSandboxId = (sandboxId?: string | null) => {
  if (!sandboxId) {
    return '';
  }

  return sandboxId.split('/').pop() || sandboxId;
};

export default function SidebarProjectItem({
  project,
  selectedProject,
  selectedSession,
  isExpanded,
  isDeleting,
  isStarred,
  editingProject,
  editingName,
  sessions,
  initialSessionsLoaded,
  isLoadingSessions,
  currentTime,
  sessionProviderFilter,
  editingSession,
  editingSessionName,
  tasksEnabled,
  mcpServerStatus,
  onEditingNameChange,
  onToggleProject,
  onProjectSelect,
  onToggleStarProject,
  onStartEditingProject,
  onCancelEditingProject,
  onSaveProjectName,
  onDeleteProject,
  onSessionSelect,
  onDeleteSession,
  onLoadMoreSessions,
  onNewSession,
  onEditingSessionNameChange,
  onStartEditingSession,
  onCancelEditingSession,
  onSaveEditingSession,
  t,
}: SidebarProjectItemProps) {
  const isSelected = selectedProject?.name === project.name;
  const isEditing = editingProject === project.name;
  const hasMoreSessions = resolveProjectLoadMoreProvider(project, sessionProviderFilter) !== null;
  const sessionCountDisplay = getSessionCountDisplay(sessions, hasMoreSessions);
  const cloudSectionLabel = t('projects.cloudSection', { defaultValue: 'Cloud' });
  const sessionCountLabel = t('projects.sessionCountLabel', {
    count: sessions.length,
    shown: sessionCountDisplay,
    defaultValue: sessions.length === 1 ? '{{shown}} session' : '{{shown}} sessions',
  });
  const taskStatus = getTaskIndicatorStatus(project, mcpServerStatus);
  const isCloudProject = isResolvedCloudProject(project);
  const cloudRepoLabel = getCloudRepoLabel(project.cloud?.repoUrl);
  const sandboxLabel = getShortSandboxId(project.cloud?.sandboxId);
  const cloudStatus = typeof project.cloud?.status === 'string' ? project.cloud.status.trim() : '';
  const cloudWorkspacePath = project.cloud?.workspacePath || project.fullPath || '';
  const cloudSummaryParts = [
    cloudRepoLabel,
    project.cloud?.branch || '',
    sandboxLabel ? `#${sandboxLabel.slice(0, 8)}` : '',
  ].filter(Boolean);
  const cloudSummary = cloudSummaryParts.join(' • ');
  const localPathLabel =
    project.fullPath !== project.displayName
      ? truncatePath(project.fullPath)
      : '';

  const toggleProject = () => onToggleProject(project.name);
  const toggleStarProject = () => onToggleStarProject(project.name);

  const saveProjectName = () => {
    onSaveProjectName(project.name);
  };

  const handleDesktopSelect = () => {
    if (!isEditing) {
      onProjectSelect(project);
    }
  };

  const handleDesktopKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleDesktopSelect();
    }
  };

  return (
    <div className={cn('md:space-y-1', isDeleting && 'pointer-events-none opacity-50')}>
      <div className="group md:group">
        <div className="md:hidden">
          <div
            data-testid="sidebar-project-item"
            data-project-name={project.name}
            data-project-runtime={project.runtime || 'local'}
            className={cn(
              'mx-2.5 my-1 rounded-lg border border-border/50 bg-card px-2.5 py-2.5 transition-all duration-150 active:scale-[0.98]',
              isSelected && 'border-primary/20 bg-primary/5',
              isStarred &&
                !isSelected &&
                'border-yellow-200/30 bg-yellow-50/50 dark:border-yellow-800/30 dark:bg-yellow-900/5',
            )}
            onClick={toggleProject}
          >
            <div className="flex items-center justify-between overflow-hidden">
              <div className="flex min-w-0 flex-1 items-center gap-2.5 overflow-hidden">
                <div
                  className={cn(
                    'flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md transition-colors',
                    isExpanded ? 'bg-primary/10' : 'bg-muted',
                  )}
                >
                  {isExpanded ? (
                    isCloudProject ? <Cloud className="h-4 w-4 text-primary" /> : <FolderOpen className="h-4 w-4 text-primary" />
                  ) : (
                    isCloudProject ? <Cloud className="h-4 w-4 text-muted-foreground" /> : <Folder className="h-4 w-4 text-muted-foreground" />
                  )}
                </div>

                <div className="min-w-0 flex-1 overflow-hidden">
                  {isEditing ? (
                    <input
                      type="text"
                      value={editingName}
                      onChange={(event) => onEditingNameChange(event.target.value)}
                      className="w-full rounded-lg border-2 border-primary/40 bg-background px-3 py-2 text-sm text-foreground shadow-sm transition-all duration-200 focus:border-primary focus:shadow-md focus:outline-none"
                      placeholder={t('projects.projectNamePlaceholder')}
                      autoFocus
                      autoComplete="off"
                      onClick={(event) => event.stopPropagation()}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          saveProjectName();
                        }

                        if (event.key === 'Escape') {
                          onCancelEditingProject();
                        }
                      }}
                      style={{
                        fontSize: '16px',
                        WebkitAppearance: 'none',
                        borderRadius: '8px',
                      }}
                    />
                  ) : (
                    <>
                      <div className="flex min-w-0 flex-1 items-center justify-between gap-2 overflow-hidden">
                        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
                          <h3 className="min-w-0 truncate text-sm font-medium text-foreground">{project.displayName}</h3>
                          
                          <ProjectActionsMenu
                            isStarred={isStarred}
                            onToggleStar={(e) => { e.stopPropagation(); toggleStarProject(); }}
                            onEdit={(e) => { e.stopPropagation(); onStartEditingProject(project); }}
                            onDelete={(e) => { e.stopPropagation(); onDeleteProject(project); }}
                            t={t}
                          />

                          {isCloudProject && (
                            <span className="inline-block max-w-[60px] flex-shrink-0 truncate rounded-md bg-gradient-to-r from-sky-500/15 to-sky-600/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-sky-700 shadow-sm ring-1 ring-sky-500/20 dark:from-sky-500/20 dark:to-sky-600/20 dark:text-sky-300 dark:ring-sky-400/30">
                              {cloudSectionLabel}
                            </span>
                          )}
                          {isCloudProject && cloudStatus && (
                            <span className="inline-block max-w-[70px] flex-shrink-0 truncate rounded-md bg-gradient-to-r from-slate-100 to-slate-200/80 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-slate-700 shadow-sm ring-1 ring-slate-300/40 dark:from-slate-800/80 dark:to-slate-900/80 dark:text-slate-300 dark:ring-slate-700/50">
                              {cloudStatus}
                            </span>
                          )}
                        </div>
                        {tasksEnabled && (
                          <TaskIndicator
                            status={taskStatus}
                            size="xs"
                            className="ml-2 hidden flex-shrink-0 md:inline-flex"
                          />
                        )}
                      </div>
                      <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                        {isCloudProject ? cloudSummary || cloudSectionLabel : sessionCountLabel}
                      </p>
                      {isCloudProject && (
                        <p className="mt-0.5 truncate text-[10px] text-muted-foreground/70">
                          {sessionCountLabel}
                          {cloudWorkspacePath ? ` • ${truncatePath(cloudWorkspacePath, 26)}` : ''}
                        </p>
                      )}
                    </>
                  )}
                </div>
              </div>

              <div className="flex items-center">
                {isEditing ? (
                  <div className="flex gap-0.5">
                    <button
                      className="flex h-7 w-7 items-center justify-center rounded-md bg-green-500 shadow-sm transition-all duration-150 active:scale-90 active:shadow-none dark:bg-green-600"
                      onClick={(event) => {
                        event.stopPropagation();
                        saveProjectName();
                      }}
                    >
                      <Check className="h-3.5 w-3.5 text-white" />
                    </button>
                    <button
                      className="flex h-7 w-7 items-center justify-center rounded-md bg-gray-500 shadow-sm transition-all duration-150 active:scale-90 active:shadow-none dark:bg-gray-600"
                      onClick={(event) => {
                        event.stopPropagation();
                        onCancelEditingProject();
                      }}
                    >
                      <X className="h-3.5 w-3.5 text-white" />
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    data-testid="sidebar-project-toggle"
                    data-project-name={project.name}
                    className="flex items-center justify-center transition-all duration-200"
                    onClick={(event) => {
                      event.stopPropagation();
                      toggleProject();
                    }}
                  >
                    {isExpanded ? (
                      <ChevronDown className="h-4 w-4 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    )}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="hidden items-start gap-1 md:flex">
          <div
            role="button"
            tabIndex={0}
            data-testid="sidebar-project-item"
            data-project-name={project.name}
            data-project-runtime={project.runtime || 'local'}
            aria-selected={isSelected}
            aria-expanded={isExpanded}
            className={cn(
              'flex-1 overflow-hidden rounded-lg px-3 py-2 transition-colors focus:outline-none focus:ring-2 focus:ring-primary/20',
              'cursor-pointer hover:bg-accent/50',
              isSelected && 'bg-accent text-accent-foreground',
              isStarred &&
                !isSelected &&
                'bg-yellow-50/50 hover:bg-yellow-100/50 dark:bg-yellow-900/10 dark:hover:bg-yellow-900/20',
            )}
            onClick={handleDesktopSelect}
            onKeyDown={handleDesktopKeyDown}
          >
            <div className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden">
              {isExpanded ? (
                isCloudProject ? <Cloud className="h-4 w-4 flex-shrink-0 text-primary" /> : <FolderOpen className="h-4 w-4 flex-shrink-0 text-primary" />
              ) : (
                isCloudProject ? <Cloud className="h-4 w-4 flex-shrink-0 text-muted-foreground" /> : <Folder className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
              )}

              <div className="min-w-0 flex-1 overflow-hidden text-left">
                {isEditing ? (
                  <div className="space-y-1">
                    <input
                      type="text"
                      value={editingName}
                      onChange={(event) => onEditingNameChange(event.target.value)}
                      className="w-full rounded border border-border bg-background px-2 py-1 text-sm text-foreground focus:ring-2 focus:ring-primary/20"
                      placeholder={t('projects.projectNamePlaceholder')}
                      autoFocus
                      onClick={(event) => event.stopPropagation()}
                      onKeyDown={(event) => {
                        event.stopPropagation();
                        if (event.key === 'Enter') {
                          saveProjectName();
                        }
                        if (event.key === 'Escape') {
                          onCancelEditingProject();
                        }
                      }}
                    />
                    <div className="truncate text-xs text-muted-foreground" title={project.fullPath}>
                      {project.fullPath}
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
                        <div className="min-w-0 truncate text-sm font-semibold text-foreground" title={project.displayName}>
                          {project.displayName}
                        </div>
                        
                        <ProjectActionsMenu
                          isStarred={isStarred}
                          onToggleStar={(e) => { e.stopPropagation(); toggleStarProject(); }}
                          onEdit={(e) => { e.stopPropagation(); onStartEditingProject(project); }}
                          onDelete={(e) => { e.stopPropagation(); onDeleteProject(project); }}
                          t={t}
                        />

                        {isCloudProject && (
                          <span className="inline-block max-w-[60px] flex-shrink-0 truncate rounded-md bg-gradient-to-r from-sky-500/15 to-sky-600/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-sky-700 shadow-sm ring-1 ring-sky-500/20 dark:from-sky-500/20 dark:to-sky-600/20 dark:text-sky-300 dark:ring-sky-400/30">
                            {cloudSectionLabel}
                          </span>
                        )}
                        {isCloudProject && cloudStatus && (
                          <span className="inline-block max-w-[70px] flex-shrink-0 truncate rounded-md bg-gradient-to-r from-slate-100 to-slate-200/80 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-slate-700 shadow-sm ring-1 ring-slate-300/40 dark:from-slate-800/80 dark:to-slate-900/80 dark:text-slate-300 dark:ring-slate-700/50">
                            {cloudStatus}
                          </span>
                        )}
                        {tasksEnabled && <TaskIndicator status={taskStatus} size="xs" className="ml-1 flex-shrink-0" />}
                      </div>

                      <div className="flex flex-shrink-0 items-center">
                        <button
                          type="button"
                          data-testid="sidebar-project-toggle"
                          data-project-name={project.name}
                          className="flex items-center justify-center transition-all duration-200"
                          onClick={(event) => {
                            event.stopPropagation();
                            toggleProject();
                          }}
                          title={isExpanded ? t('actions.collapseAll', { defaultValue: 'Collapse' }) : t('actions.expandAll', { defaultValue: 'Expand' })}
                        >
                          {isExpanded ? (
                            <ChevronDown className="h-4 w-4 text-muted-foreground transition-colors hover:text-foreground" />
                          ) : (
                            <ChevronRight className="h-4 w-4 text-muted-foreground transition-colors hover:text-foreground" />
                          )}
                        </button>
                      </div>
                    </div>

                    <div className="mt-0.5 truncate text-xs text-muted-foreground">
                      {isCloudProject ? (
                        <span className="truncate" title={cloudRepoLabel || cloudWorkspacePath}>
                          {cloudSummary || cloudSectionLabel}
                        </span>
                      ) : (
                        <>
                          {sessionCountDisplay}
                          {localPathLabel && (
                            <span className="ml-1 opacity-60" title={project.fullPath}>
                              {' • '}
                              {localPathLabel}
                            </span>
                          )}
                        </>
                      )}
                    </div>

                    {isCloudProject && (
                      <div className="mt-0.5 truncate text-[11px] text-muted-foreground/70">
                        {sessionCountLabel}
                        {cloudWorkspacePath && (
                          <span className="ml-1 opacity-70" title={cloudWorkspacePath}>
                            {' • '}
                            {truncatePath(cloudWorkspacePath, 34)}
                          </span>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      <SidebarProjectSessions
        project={project}
        isExpanded={isExpanded}
        sessions={sessions}
        selectedSession={selectedSession}
        initialSessionsLoaded={initialSessionsLoaded}
        isLoadingSessions={isLoadingSessions}
        currentTime={currentTime}
        sessionProviderFilter={sessionProviderFilter}
        editingSession={editingSession}
        editingSessionName={editingSessionName}
        onEditingSessionNameChange={onEditingSessionNameChange}
        onStartEditingSession={onStartEditingSession}
        onCancelEditingSession={onCancelEditingSession}
        onSaveEditingSession={onSaveEditingSession}
        onProjectSelect={onProjectSelect}
        onSessionSelect={onSessionSelect}
        onDeleteSession={onDeleteSession}
        onLoadMoreSessions={onLoadMoreSessions}
        onNewSession={onNewSession}
        t={t}
      />
    </div>
  );
}
