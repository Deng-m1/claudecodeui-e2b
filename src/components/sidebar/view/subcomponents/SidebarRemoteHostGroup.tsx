import { ChevronDown, ChevronRight, FolderPlus, RefreshCw, Server } from 'lucide-react';
import type { ReactNode } from 'react';
import type { TFunction } from 'i18next';
import { cn } from '../../../../lib/utils';

type SidebarRemoteHostGroupProps = {
  hostId: string;
  hostLabel: string;
  hostSubtitle?: string;
  workspaceCount: number;
  isExpanded: boolean;
  isRefreshing?: boolean;
  onToggle: () => void;
  onAddWorkspace?: () => void;
  onRefreshHost?: () => void;
  children: ReactNode;
  t: TFunction;
};

export default function SidebarRemoteHostGroup({
  hostId,
  hostLabel,
  hostSubtitle,
  workspaceCount,
  isExpanded,
  isRefreshing,
  onToggle,
  onAddWorkspace,
  onRefreshHost,
  children,
  t,
}: SidebarRemoteHostGroupProps) {
  return (
    <div
      data-testid="sidebar-remote-host-group"
      data-host-id={hostId}
      data-expanded={isExpanded ? 'true' : 'false'}
      className="space-y-0.5"
    >
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onToggle();
          }
        }}
        data-testid="sidebar-remote-host-toggle"
        data-host-id={hostId}
        className={cn(
          'group flex items-center gap-2 rounded-md px-3 py-1.5 cursor-pointer transition-colors',
          'hover:bg-accent/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30',
        )}
      >
        <button
          type="button"
          aria-label={isExpanded ? 'Collapse host' : 'Expand host'}
          onClick={(event) => {
            event.stopPropagation();
            onToggle();
          }}
          className="flex h-5 w-5 flex-shrink-0 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
        >
          {isExpanded ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </button>

        <Server className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />

        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium text-foreground" title={hostLabel}>
              {hostLabel}
            </span>
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              {workspaceCount}
            </span>
          </div>
          {hostSubtitle && (
            <div className="truncate text-[11px] text-muted-foreground/70" title={hostSubtitle}>
              {hostSubtitle}
            </div>
          )}
        </div>

        <div className="flex flex-shrink-0 items-center gap-0.5">
          {onAddWorkspace && (
            <button
              type="button"
              data-testid="sidebar-remote-host-add-workspace"
              data-host-id={hostId}
              onClick={(event) => {
                event.stopPropagation();
                onAddWorkspace();
              }}
              className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground opacity-0 group-hover:opacity-100 focus:opacity-100"
              title={t('remoteHosts.actions.addWorkspaceFromHost', {
                defaultValue: 'Browse remote directories',
              })}
            >
              <FolderPlus className="h-3.5 w-3.5" />
            </button>
          )}
          {onRefreshHost && (
            <button
              type="button"
              data-testid="sidebar-remote-host-refresh"
              data-host-id={hostId}
              onClick={(event) => {
                event.stopPropagation();
                onRefreshHost();
              }}
              disabled={isRefreshing}
              className={cn(
                'flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
                isRefreshing ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus:opacity-100',
              )}
              title={t('tooltips.refreshHost', { defaultValue: 'Refresh host' })}
            >
              <RefreshCw className={cn('h-3.5 w-3.5', isRefreshing && 'animate-spin')} />
            </button>
          )}
        </div>
      </div>

      {isExpanded && <div className="pl-3">{children}</div>}
    </div>
  );
}
