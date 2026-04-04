import { Folder, FolderPlus, MessageSquare, Plus, RefreshCw, Search, X, PanelLeftClose } from 'lucide-react';
import type { TFunction } from 'i18next';
import { Button, Input } from '../../../../shared/view/ui';
import { IS_PLATFORM } from '../../../../constants/config';
import { cn } from '../../../../lib/utils';
import SessionProviderLogo from '../../../llm-logo-provider/SessionProviderLogo';
import type { SidebarSessionProviderFilter } from '../../types/types';

type SearchMode = 'projects' | 'conversations';

type SidebarHeaderProps = {
  isPWA: boolean;
  isMobile: boolean;
  isLoading: boolean;
  projectsCount: number;
  searchFilter: string;
  onSearchFilterChange: (value: string) => void;
  onClearSearchFilter: () => void;
  searchMode: SearchMode;
  onSearchModeChange: (mode: SearchMode) => void;
  sessionProviderFilter: SidebarSessionProviderFilter;
  onSessionProviderFilterChange: (filter: SidebarSessionProviderFilter) => void;
  onRefresh: () => void;
  isRefreshing: boolean;
  onCreateProject: () => void;
  onCollapseSidebar: () => void;
  t: TFunction;
};

export default function SidebarHeader({
  isPWA,
  isMobile,
  isLoading,
  projectsCount,
  searchFilter,
  onSearchFilterChange,
  onClearSearchFilter,
  searchMode,
  onSearchModeChange,
  sessionProviderFilter,
  onSessionProviderFilterChange,
  onRefresh,
  isRefreshing,
  onCreateProject,
  onCollapseSidebar,
  t,
}: SidebarHeaderProps) {
  const providerFilters: Array<{ id: SidebarSessionProviderFilter; label: string }> = [
    { id: 'all', label: t('sessions.filters.all', { defaultValue: 'All providers' }) },
    { id: 'claude', label: t('sessions.filters.claude', { defaultValue: 'Claude' }) },
    { id: 'cursor', label: t('sessions.filters.cursor', { defaultValue: 'Cursor' }) },
    { id: 'codex', label: t('sessions.filters.codex', { defaultValue: 'Codex' }) },
    { id: 'gemini', label: t('sessions.filters.gemini', { defaultValue: 'Gemini' }) },
  ];

  const LogoBlock = () => (
    <div className="flex min-w-0 items-center gap-2.5">
      <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-primary/90 shadow-sm">
        <svg className="h-3.5 w-3.5 text-primary-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      </div>
      <h1 className="truncate text-sm font-semibold tracking-tight text-foreground">{t('app.title')}</h1>
    </div>
  );

  const renderProviderFilterBar = () => {
    if (!(projectsCount > 0 && !isLoading && searchMode === 'projects')) {
      return null;
    }

    return (
      <div className="-mx-3 overflow-x-auto px-3 pb-0.5 pt-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div className="flex min-w-max items-center gap-1">
          {providerFilters.map((filterOption) => {
            const isActive = sessionProviderFilter === filterOption.id;

            return (
              <button
                key={filterOption.id}
                type="button"
                data-testid="sidebar-provider-filter"
                data-provider-id={filterOption.id}
                aria-pressed={isActive}
                onClick={() => onSessionProviderFilterChange(filterOption.id)}
                className={cn(
                  'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors',
                  isActive
                    ? 'border-primary/30 bg-primary/10 text-foreground shadow-sm'
                    : 'border-border/60 bg-background/80 text-muted-foreground hover:text-foreground',
                )}
              >
                {filterOption.id !== 'all' && (
                  <SessionProviderLogo provider={filterOption.id} className="h-3.5 w-3.5" />
                )}
                <span className="whitespace-nowrap">{filterOption.label}</span>
              </button>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <div className="flex-shrink-0">
      {/* Desktop header */}
      <div
        className="hidden px-3 pb-2 pt-3 md:block"
        style={{}}
      >
        <div className="flex items-center justify-between gap-2">
          {IS_PLATFORM ? (
            <a
              href="https://cloudcli.ai/dashboard"
              className="flex min-w-0 items-center gap-2.5 transition-opacity hover:opacity-80"
              title={t('tooltips.viewEnvironments')}
            >
              <LogoBlock />
            </a>
          ) : (
            <LogoBlock />
          )}

          <div className="flex flex-shrink-0 items-center gap-0.5">
            <Button
              variant="ghost"
              size="sm"
              data-testid="sidebar-refresh-projects"
              className="h-7 w-7 rounded-lg p-0 text-muted-foreground hover:bg-accent/80 hover:text-foreground"
              onClick={onRefresh}
              disabled={isRefreshing}
              title={t('tooltips.refresh')}
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${
                  isRefreshing ? 'animate-spin' : ''
                }`}
              />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              data-testid="open-session-launcher"
              className="h-7 w-7 rounded-lg p-0 text-muted-foreground hover:bg-accent/80 hover:text-foreground"
              onClick={onCreateProject}
              title={t('tooltips.createProject')}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 rounded-lg p-0 text-muted-foreground hover:bg-accent/80 hover:text-foreground"
              onClick={onCollapseSidebar}
              title={t('tooltips.hideSidebar')}
            >
              <PanelLeftClose className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>

        {/* Search bar */}
        {projectsCount > 0 && !isLoading && (
          <div className="mt-2.5 space-y-2">
            {/* Search mode toggle */}
            <div className="flex rounded-lg bg-muted/50 p-0.5">
              <button
                onClick={() => onSearchModeChange('projects')}
                aria-pressed={searchMode === 'projects'}
                className={cn(
                  "flex-1 flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-all",
                  searchMode === 'projects'
                    ? "bg-background shadow-sm text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <Folder className="h-3 w-3" />
                {t('search.modeProjects')}
              </button>
              <button
                onClick={() => onSearchModeChange('conversations')}
                aria-pressed={searchMode === 'conversations'}
                className={cn(
                  "flex-1 flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-all",
                  searchMode === 'conversations'
                    ? "bg-background shadow-sm text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <MessageSquare className="h-3 w-3" />
                {t('search.modeConversations')}
              </button>
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/50" />
              <Input
                type="text"
                data-testid="sidebar-search"
                placeholder={searchMode === 'conversations' ? t('search.conversationsPlaceholder') : t('projects.searchPlaceholder')}
                value={searchFilter}
                onChange={(event) => onSearchFilterChange(event.target.value)}
                className="nav-search-input h-9 rounded-xl border-0 pl-9 pr-8 text-sm transition-all duration-200 placeholder:text-muted-foreground/40 focus-visible:ring-0 focus-visible:ring-offset-0"
              />
              {searchFilter && (
                <button
                  onClick={onClearSearchFilter}
                  aria-label={t('tooltips.clearSearch')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-md p-0.5 hover:bg-accent"
                >
                  <X className="h-3 w-3 text-muted-foreground" />
                </button>
              )}
            </div>
            {renderProviderFilterBar()}
          </div>
        )}
      </div>

      {/* Desktop divider */}
      <div className="nav-divider hidden md:block" />

      {/* Mobile header */}
      <div
        className="p-3 pb-2 md:hidden"
        style={isPWA && isMobile ? { paddingTop: '16px' } : {}}
      >
        <div className="flex items-center justify-between">
          {IS_PLATFORM ? (
            <a
              href="https://cloudcli.ai/dashboard"
              className="flex min-w-0 items-center gap-2.5 transition-opacity active:opacity-70"
              title={t('tooltips.viewEnvironments')}
            >
              <LogoBlock />
            </a>
          ) : (
            <LogoBlock />
          )}

          <div className="flex flex-shrink-0 gap-1.5">
            <button
              className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted/50 transition-all active:scale-95"
              onClick={onRefresh}
              disabled={isRefreshing}
            >
              <RefreshCw className={`h-4 w-4 text-muted-foreground ${isRefreshing ? 'animate-spin' : ''}`} />
            </button>
            <button
              data-testid="open-session-launcher"
              className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/90 text-primary-foreground transition-all active:scale-95"
              onClick={onCreateProject}
            >
              <FolderPlus className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Mobile search */}
        {projectsCount > 0 && !isLoading && (
          <div className="mt-2.5 space-y-2">
            <div className="flex rounded-lg bg-muted/50 p-0.5">
              <button
                onClick={() => onSearchModeChange('projects')}
                aria-pressed={searchMode === 'projects'}
                className={cn(
                  "flex-1 flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-all",
                  searchMode === 'projects'
                    ? "bg-background shadow-sm text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <Folder className="h-3 w-3" />
                {t('search.modeProjects')}
              </button>
              <button
                onClick={() => onSearchModeChange('conversations')}
                aria-pressed={searchMode === 'conversations'}
                className={cn(
                  "flex-1 flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-all",
                  searchMode === 'conversations'
                    ? "bg-background shadow-sm text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <MessageSquare className="h-3 w-3" />
                {t('search.modeConversations')}
              </button>
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/50" />
              <Input
                type="text"
                data-testid="sidebar-search"
                placeholder={searchMode === 'conversations' ? t('search.conversationsPlaceholder') : t('projects.searchPlaceholder')}
                value={searchFilter}
                onChange={(event) => onSearchFilterChange(event.target.value)}
                className="nav-search-input h-10 rounded-xl border-0 pl-10 pr-9 text-sm transition-all duration-200 placeholder:text-muted-foreground/40 focus-visible:ring-0 focus-visible:ring-offset-0"
              />
              {searchFilter && (
                <button
                  onClick={onClearSearchFilter}
                  aria-label={t('tooltips.clearSearch')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-md p-1 hover:bg-accent"
                >
                  <X className="h-3.5 w-3.5 text-muted-foreground" />
                </button>
              )}
            </div>
            {renderProviderFilterBar()}
          </div>
        )}
      </div>

      {/* Mobile divider */}
      <div className="nav-divider md:hidden" />
    </div>
  );
}
