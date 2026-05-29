import { useEffect } from 'react';
import type { TFunction } from 'i18next';
import type { LoadingProgress, Project, ProjectSession, RuntimeMode, SessionProvider } from '../../../../types/app';
import type {
  LoadingSessionsByProject,
  MCPServerStatus,
  SidebarSessionProviderFilter,
  SessionWithProvider,
} from '../../types/types';
import { filterSessionsByProvider, isCloudProject } from '../../utils/utils';
import SidebarProjectItem from './SidebarProjectItem';
import SidebarProjectsState from './SidebarProjectsState';
import SidebarRemoteHostGroup from './SidebarRemoteHostGroup';

type ProjectRemoteMeta = {
  hostId?: string;
  workspaceId?: string;
  label?: string;
  host?: string;
  port?: number;
  username?: string | null;
  workspaceRoot?: string;
};

const UNKNOWN_REMOTE_HOST_ID = '__unknown_remote_host__';

const getProjectRemoteMeta = (project: Project): ProjectRemoteMeta | null => {
  const raw = (project as unknown as { remote?: unknown }).remote;
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  return raw as ProjectRemoteMeta;
};

export type SidebarProjectListProps = {
  projects: Project[];
  filteredProjects: Project[];
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  isLoading: boolean;
  loadingProgress: LoadingProgress | null;
  expandedProjects: Set<string>;
  editingProject: string | null;
  editingName: string;
  loadingSessions: LoadingSessionsByProject;
  initialSessionsLoaded: Set<string>;
  currentTime: Date;
  sessionProviderFilter: SidebarSessionProviderFilter;
  editingSession: string | null;
  editingSessionName: string;
  deletingProjects: Set<string>;
  tasksEnabled: boolean;
  mcpServerStatus: MCPServerStatus;
  getProjectSessions: (project: Project) => SessionWithProvider[];
  isProjectStarred: (projectName: string) => boolean;
  onEditingNameChange: (value: string) => void;
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
  onRefreshProjectSessions: (project: Project) => void;
  expandedRemoteHosts: Set<string>;
  onToggleRemoteHost: (hostId: string) => void;
  onAddWorkspaceForHost: (hostId: string) => void;
  onRefreshAllProjects: () => void;
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

export default function SidebarProjectList({
  projects,
  filteredProjects,
  selectedProject,
  selectedSession,
  isLoading,
  loadingProgress,
  expandedProjects,
  editingProject,
  editingName,
  loadingSessions,
  initialSessionsLoaded,
  currentTime,
  sessionProviderFilter,
  editingSession,
  editingSessionName,
  deletingProjects,
  tasksEnabled,
  mcpServerStatus,
  getProjectSessions,
  isProjectStarred,
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
  onRefreshProjectSessions,
  expandedRemoteHosts,
  onToggleRemoteHost,
  onAddWorkspaceForHost,
  onRefreshAllProjects,
  onNewSession,
  onEditingSessionNameChange,
  onStartEditingSession,
  onCancelEditingSession,
  onSaveEditingSession,
  t,
}: SidebarProjectListProps) {
  const state = (
    <SidebarProjectsState
      isLoading={isLoading}
      loadingProgress={loadingProgress}
      projectsCount={projects.length}
      filteredProjectsCount={filteredProjects.length}
      t={t}
    />
  );

  useEffect(() => {
    let baseTitle = 'CloudCLI UI';
    const displayName = selectedProject?.displayName?.trim();
    if (displayName) {
      baseTitle = `${displayName} - ${baseTitle}`;
    }
    document.title = baseTitle;
  }, [selectedProject]);

  const showProjects = !isLoading && projects.length > 0 && filteredProjects.length > 0;
  const remoteProjects = filteredProjects.filter((project) => project.runtime === 'remote_host');
  const localProjects = filteredProjects.filter(
    (project) => project.runtime !== 'remote_host' && !isCloudProject(project),
  );
  const cloudProjects = filteredProjects.filter((project) => isCloudProject(project));

  const renderProjectItem = (project: Project) => {
    const projectSessions = filterSessionsByProvider(getProjectSessions(project), sessionProviderFilter);
    return (
      <SidebarProjectItem
        key={project.name}
        project={project}
        selectedProject={selectedProject}
        selectedSession={selectedSession}
        isExpanded={expandedProjects.has(project.name)}
        isDeleting={deletingProjects.has(project.name)}
        isStarred={isProjectStarred(project.name)}
        editingProject={editingProject}
        editingName={editingName}
        sessions={projectSessions}
        initialSessionsLoaded={initialSessionsLoaded.has(project.name)}
        isLoadingSessions={Boolean(loadingSessions[project.name])}
        currentTime={currentTime}
        sessionProviderFilter={sessionProviderFilter}
        editingSession={editingSession}
        editingSessionName={editingSessionName}
        tasksEnabled={tasksEnabled}
        mcpServerStatus={mcpServerStatus}
        onEditingNameChange={onEditingNameChange}
        onToggleProject={onToggleProject}
        onProjectSelect={onProjectSelect}
        onToggleStarProject={onToggleStarProject}
        onStartEditingProject={onStartEditingProject}
        onCancelEditingProject={onCancelEditingProject}
        onSaveProjectName={onSaveProjectName}
        onDeleteProject={onDeleteProject}
        onSessionSelect={onSessionSelect}
        onDeleteSession={onDeleteSession}
        onLoadMoreSessions={onLoadMoreSessions}
        onRefreshProjectSessions={onRefreshProjectSessions}
        onNewSession={onNewSession}
        onEditingSessionNameChange={onEditingSessionNameChange}
        onStartEditingSession={onStartEditingSession}
        onCancelEditingSession={onCancelEditingSession}
        onSaveEditingSession={onSaveEditingSession}
        t={t}
      />
    );
  };

  const renderSimpleSection = (sectionProjects: Project[], title: string, testId: string) => {
    if (sectionProjects.length === 0) {
      return null;
    }

    return (
      <section key={testId} data-testid={testId} className="space-y-1">
        <div className="px-3 pb-1 pt-3">
          <div className="flex items-center justify-between">
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/80">
              {title}
            </h3>
            <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
              {sectionProjects.length}
            </span>
          </div>
        </div>

        {sectionProjects.map((project) => renderProjectItem(project))}
      </section>
    );
  };

  const renderRemoteSection = (sectionProjects: Project[]) => {
    if (sectionProjects.length === 0) {
      return null;
    }

    type HostBucket = {
      hostId: string;
      label: string;
      subtitle: string;
      projects: Project[];
    };

    const buckets = new Map<string, HostBucket>();
    for (const project of sectionProjects) {
      const meta = getProjectRemoteMeta(project);
      const hostId = meta?.hostId || UNKNOWN_REMOTE_HOST_ID;
      const label = meta?.label
        || (meta?.host ? `${meta.host}${meta.port ? `:${meta.port}` : ''}` : undefined)
        || t('projects.unknownRemoteHost', { defaultValue: 'Unknown host' });
      const subtitleParts: string[] = [];
      if (meta?.username && meta?.host) {
        subtitleParts.push(`${meta.username}@${meta.host}${meta.port ? `:${meta.port}` : ''}`);
      } else if (meta?.host) {
        subtitleParts.push(`${meta.host}${meta.port ? `:${meta.port}` : ''}`);
      }
      const subtitle = subtitleParts.join(' · ');

      const existing = buckets.get(hostId);
      if (existing) {
        existing.projects.push(project);
      } else {
        buckets.set(hostId, { hostId, label, subtitle, projects: [project] });
      }
    }

    const orderedBuckets = Array.from(buckets.values());

    return (
      <section data-testid="sidebar-project-section-remote" className="space-y-1">
        <div className="px-3 pb-1 pt-3">
          <div className="flex items-center justify-between">
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/80">
              {t('projects.remoteSection', { defaultValue: 'Remote' })}
            </h3>
            <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
              {sectionProjects.length}
            </span>
          </div>
        </div>

        {orderedBuckets.map((bucket) => {
          const isExpanded = expandedRemoteHosts.has(bucket.hostId)
            || bucket.hostId === UNKNOWN_REMOTE_HOST_ID;
          const isUnknown = bucket.hostId === UNKNOWN_REMOTE_HOST_ID;

          return (
            <SidebarRemoteHostGroup
              key={bucket.hostId}
              hostId={bucket.hostId}
              hostLabel={bucket.label}
              hostSubtitle={bucket.subtitle || undefined}
              workspaceCount={bucket.projects.length}
              isExpanded={isExpanded}
              onToggle={() => onToggleRemoteHost(bucket.hostId)}
              onAddWorkspace={!isUnknown ? () => onAddWorkspaceForHost(bucket.hostId) : undefined}
              onRefreshHost={!isUnknown ? () => onRefreshAllProjects() : undefined}
              t={t}
            >
              {bucket.projects.map((project) => renderProjectItem(project))}
            </SidebarRemoteHostGroup>
          );
        })}
      </section>
    );
  };

  return (
    <div className="pb-safe-area-inset-bottom md:space-y-1" data-testid="sidebar-project-list">
      {!showProjects
        ? state
        : (
            <>
              {renderSimpleSection(
                localProjects,
                t('projects.localSection', { defaultValue: 'Local' }),
                'sidebar-project-section-local',
              )}
              {renderRemoteSection(remoteProjects)}
              {renderSimpleSection(
                cloudProjects,
                t('projects.cloudSection', { defaultValue: 'Cloud' }),
                'sidebar-project-section-cloud',
              )}
            </>
          )}
    </div>
  );
}
