import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronDown,
  Cloud,
  Folder,
  FolderOpen,
  History,
  Mic,
  Monitor,
  Plus,
  Server,
} from 'lucide-react';
import type { Project } from '../../types/app';
import { cn } from '../../lib/utils';
import { useRecentProjects, type RecentProjectEntry } from '../../hooks/useRecentProjects';

type QuickLauncherProps = {
  projects: Project[];
  onProjectSelect: (project: Project) => void;
  onOpenSessionLauncher: () => void;
  onOpenRemoteHostSettings: () => void;
};

const isRemoteProject = (project: Project) => project.runtime === 'remote_host';
const isCloudRuntime = (project: Project) =>
  project.runtime === 'e2b' || Boolean((project as unknown as { cloud?: unknown }).cloud);

export default function QuickLauncher({
  projects,
  onProjectSelect,
  onOpenSessionLauncher,
  onOpenRemoteHostSettings,
}: QuickLauncherProps) {
  const { t } = useTranslation('common');
  const { entries: recentEntries } = useRecentProjects();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const projectsByName = useMemo(() => {
    const map = new Map<string, Project>();
    for (const project of projects) {
      map.set(project.name, project);
    }
    return map;
  }, [projects]);

  const validRecents = useMemo<Array<RecentProjectEntry & { project?: Project }>>(() => {
    return recentEntries.map((entry) => ({
      ...entry,
      project: projectsByName.get(entry.projectName),
    }));
  }, [recentEntries, projectsByName]);

  useEffect(() => {
    if (!isMenuOpen) return;
    const handleOutside = (event: MouseEvent) => {
      if (!menuRef.current) return;
      if (
        menuRef.current.contains(event.target as Node)
        || triggerRef.current?.contains(event.target as Node)
      ) {
        return;
      }
      setIsMenuOpen(false);
    };
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, [isMenuOpen]);

  const mostRecentProject = useMemo(() => {
    for (const entry of validRecents) {
      if (entry.project) return entry.project;
    }
    return projects[0];
  }, [validRecents, projects]);

  const handleSelectProject = (project: Project) => {
    setIsMenuOpen(false);
    onProjectSelect(project);
  };

  const handleInputKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (!draft.trim()) return;
      if (mostRecentProject) {
        onProjectSelect(mostRecentProject);
      } else {
        onOpenSessionLauncher();
      }
    }
  };

  const remoteHostsFromProjects = useMemo(() => {
    type RemoteMeta = { hostId?: string; label?: string; host?: string; port?: number };
    const seen = new Map<string, RemoteMeta>();
    for (const project of projects) {
      const meta = (project as unknown as { remote?: RemoteMeta }).remote;
      if (meta?.hostId && !seen.has(meta.hostId)) {
        seen.set(meta.hostId, meta);
      }
    }
    return Array.from(seen.values());
  }, [projects]);

  const projectLabel = (entry: RecentProjectEntry, project?: Project) => {
    const fallback = entry.displayName || entry.projectName;
    return project?.displayName || fallback;
  };

  return (
    <div className="mx-auto w-full max-w-2xl px-6">
      <div className="relative flex items-center gap-2 pb-3 text-sm">
        <button
          ref={triggerRef}
          type="button"
          data-testid="quick-launcher-project-trigger"
          onClick={() => setIsMenuOpen((current) => !current)}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-foreground hover:bg-accent/60',
            isMenuOpen && 'bg-accent/60',
          )}
        >
          <Folder className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-foreground">
            {mostRecentProject?.displayName || t('quickLauncher.noProject', { defaultValue: 'No project' })}
          </span>
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        </button>
        <button
          type="button"
          data-testid="quick-launcher-runtime-trigger"
          onClick={onOpenSessionLauncher}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-foreground hover:bg-accent/60"
        >
          <Monitor className="h-3.5 w-3.5 text-muted-foreground" />
          <span>
            {t('quickLauncher.localRuntime', { defaultValue: 'Local' })}
          </span>
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        </button>

        {isMenuOpen && (
          <div
            ref={menuRef}
            data-testid="quick-launcher-menu"
            className="absolute left-0 top-full z-30 mt-1 max-h-[60vh] w-[420px] overflow-y-auto rounded-xl border border-border bg-popover p-2 text-popover-foreground shadow-lg"
          >
            <input
              type="text"
              placeholder={t('quickLauncher.searchPlaceholder', { defaultValue: 'Run Cursor anywhere...' })}
              className="mb-1 w-full rounded-md border-0 bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground/60 focus:outline-none"
              autoFocus
            />

            {validRecents.length > 0 && (
              <>
                <div className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {t('quickLauncher.recents', { defaultValue: 'Recents' })}
                </div>
                {validRecents.slice(0, 6).map((entry) => {
                  const isCloud = entry.project ? isCloudRuntime(entry.project) : false;
                  const isRemote = entry.project ? isRemoteProject(entry.project) : entry.runtime === 'remote_host';
                  const Icon = isCloud ? Cloud : isRemote ? Server : Folder;
                  const subtitle = entry.fullPath
                    || entry.project?.fullPath
                    || entry.project?.path
                    || '';
                  return (
                    <button
                      key={entry.projectName}
                      type="button"
                      data-testid="quick-launcher-recent-item"
                      data-project-name={entry.projectName}
                      onClick={() => {
                        if (entry.project) {
                          handleSelectProject(entry.project);
                        }
                      }}
                      disabled={!entry.project}
                      className={cn(
                        'flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors',
                        entry.project ? 'hover:bg-accent' : 'cursor-not-allowed opacity-50',
                      )}
                    >
                      <Icon className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-foreground">{projectLabel(entry, entry.project)}</div>
                        {subtitle && (
                          <div className="truncate text-xs text-muted-foreground">{subtitle}</div>
                        )}
                      </div>
                      {!entry.project && (
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                          {t('quickLauncher.missing', { defaultValue: 'gone' })}
                        </span>
                      )}
                    </button>
                  );
                })}
              </>
            )}

            <div className="my-1 h-px bg-border" />

            <div className="px-3 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {t('quickLauncher.runOn', { defaultValue: 'Run On' })}
            </div>
            <button
              type="button"
              onClick={() => {
                setIsMenuOpen(false);
                onOpenSessionLauncher();
              }}
              className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm hover:bg-accent"
            >
              <Monitor className="h-4 w-4 text-muted-foreground" />
              <span>{t('quickLauncher.thisPc', { defaultValue: 'This PC' })}</span>
            </button>
            {remoteHostsFromProjects.map((meta) => (
              <button
                key={meta.hostId}
                type="button"
                data-testid="quick-launcher-host-item"
                data-host-id={meta.hostId}
                onClick={() => {
                  setIsMenuOpen(false);
                  onOpenRemoteHostSettings();
                }}
                className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm hover:bg-accent"
              >
                <Server className="h-4 w-4 text-muted-foreground" />
                <div className="min-w-0">
                  <div className="truncate text-foreground">{meta.label || t('quickLauncher.remoteHost', { defaultValue: 'Remote host' })}</div>
                  {meta.host && (
                    <div className="truncate text-xs text-muted-foreground">
                      {meta.host}
                      {meta.port ? `:${meta.port}` : ''}
                    </div>
                  )}
                </div>
              </button>
            ))}
            <button
              type="button"
              onClick={() => {
                setIsMenuOpen(false);
                onOpenSessionLauncher();
              }}
              className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm hover:bg-accent"
            >
              <Cloud className="h-4 w-4 text-muted-foreground" />
              <span>{t('quickLauncher.cloud', { defaultValue: 'Cloud' })}</span>
            </button>

            <div className="my-1 h-px bg-border" />

            <button
              type="button"
              onClick={() => {
                setIsMenuOpen(false);
                onOpenSessionLauncher();
              }}
              className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm hover:bg-accent"
            >
              <FolderOpen className="h-4 w-4 text-muted-foreground" />
              <span>{t('quickLauncher.openFolder', { defaultValue: 'Open Folder…' })}</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setIsMenuOpen(false);
                onOpenRemoteHostSettings();
              }}
              className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm hover:bg-accent"
            >
              <Server className="h-4 w-4 text-muted-foreground" />
              <span>{t('quickLauncher.setUpWorkspace', { defaultValue: 'Set Up Workspace…' })}</span>
            </button>
          </div>
        )}
      </div>

      <div
        data-testid="quick-launcher-input-wrapper"
        className="rounded-2xl border border-border bg-card/50 px-4 py-3 shadow-sm transition-colors focus-within:border-primary/40 focus-within:bg-card"
      >
        <textarea
          data-testid="quick-launcher-input"
          rows={2}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleInputKeyDown}
          placeholder={t('quickLauncher.placeholder', { defaultValue: 'Plan, Build, / for commands, @ for context' })}
          className="w-full resize-none bg-transparent text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none"
        />

        <div className="mt-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onOpenSessionLauncher}
              className="flex h-7 w-7 items-center justify-center rounded-full bg-muted/70 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              title={t('quickLauncher.openLauncher', { defaultValue: 'New session…' })}
            >
              <Plus className="h-4 w-4" />
            </button>
            <span className="text-xs text-muted-foreground">
              {t('quickLauncher.modelHint', { defaultValue: 'Opus 4.7 · 1M Max' })}
            </span>
          </div>
          <button
            type="button"
            disabled
            className="flex h-7 w-7 items-center justify-center rounded-full bg-foreground/90 text-background opacity-60"
            title={t('quickLauncher.voice', { defaultValue: 'Voice input (coming soon)' })}
          >
            <Mic className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <span className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2.5 py-1 text-xs text-muted-foreground">
          <History className="h-3 w-3" />
          {t('quickLauncher.planNewIdea', { defaultValue: 'Plan New Idea' })}
          <kbd className="ml-1 rounded bg-muted px-1 text-[10px]">⇧Tab</kbd>
        </span>
      </div>
    </div>
  );
}
