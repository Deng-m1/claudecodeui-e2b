import { useCallback, useEffect, useState } from 'react';
import { GitBranch, Loader2, Lock, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Input } from '../../shared/view/ui';
import {
  type GitHubBranch as Branch,
  type GitHubRepo as Repo,
  fetchGitHubBranches,
  fetchGitHubRepos,
  mergeGitHubRepos,
  matchesGitHubRepoQuery,
  matchesGitHubRepoSelection,
  resolveGitHubBranchSelection,
} from '../../utils/github';

type Selection = {
  repo: Repo;
  branch: string;
};

type GitHubRepoBrowserProps = {
  onSelect: (selection: Selection) => void;
  selectedRepo?: string;
  selectedBranch?: string;
};

export default function GitHubRepoBrowser({ onSelect, selectedRepo, selectedBranch }: GitHubRepoBrowserProps) {
  const { t } = useTranslation('settings');
  const [repos, setRepos] = useState<Repo[]>([]);
  const [repoCatalog, setRepoCatalog] = useState<Repo[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [loading, setLoading] = useState(false);
  const [branchLoading, setBranchLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [activeRepo, setActiveRepo] = useState<Repo | null>(null);
  const [activeBranch, setActiveBranch] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  const fetchRepos = useCallback(async (query: string) => {
    try {
      setLoading(true);
      setError(null);
      const nextRepos = await fetchGitHubRepos(query);
      setRepos(nextRepos);
      setRepoCatalog((currentRepos) => mergeGitHubRepos(currentRepos, nextRepos));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load repos');
      setRepos([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchBranches = useCallback(async (repo: Repo, preferredBranch?: string) => {
    try {
      setBranchLoading(true);
      const { branches: nextBranches, defaultBranch } = await fetchGitHubBranches(repo);
      setBranches(nextBranches);
      setActiveBranch(resolveGitHubBranchSelection(preferredBranch || selectedBranch, nextBranches, defaultBranch));
    } catch (err) {
      console.error('Failed to load branches:', err);
      setBranches([]);
      setActiveBranch(preferredBranch || repo.defaultBranch || 'main');
    } finally {
      setBranchLoading(false);
    }
  }, [selectedBranch]);

  const visibleRepos = mergeGitHubRepos(repos, repoCatalog).filter((repo) => matchesGitHubRepoQuery(repo, search));

  useEffect(() => {
    fetchRepos('');
  }, [fetchRepos]);

  useEffect(() => {
    const timer = setTimeout(() => { fetchRepos(search); }, 300);
    return () => clearTimeout(timer);
  }, [search, fetchRepos]);

  useEffect(() => {
    if (!selectedRepo) {
      return;
    }

    if (activeRepo && matchesGitHubRepoSelection(activeRepo, selectedRepo)) {
      return;
    }

    const matchedRepo = visibleRepos.find((repo) => matchesGitHubRepoSelection(repo, selectedRepo));
    if (matchedRepo) {
      setActiveRepo(matchedRepo);
      if (!search) {
        setSearch(matchedRepo.fullName);
      }
      void fetchBranches(matchedRepo, selectedBranch);
      return;
    }

    if (!loading && !search) {
      setSearch(selectedRepo);
    }
  }, [activeRepo, fetchBranches, loading, search, selectedBranch, selectedRepo, visibleRepos]);

  useEffect(() => {
    if (!activeRepo || !selectedBranch) {
      return;
    }

    setActiveBranch((currentBranch) => {
      const nextBranch = resolveGitHubBranchSelection(
        selectedBranch,
        branches,
        currentBranch || activeRepo.defaultBranch,
      );
      return currentBranch === nextBranch ? currentBranch : nextBranch;
    });
  }, [activeRepo, branches, selectedBranch]);

  const handleRepoSelect = (repo: Repo) => {
    setActiveRepo(repo);
    setError(null);
    void fetchBranches(repo, activeRepo?.id === repo.id ? activeBranch : repo.defaultBranch);
  };

  const handleBranchChange = (branch: string) => {
    setActiveBranch(branch);
    if (activeRepo) {
      onSelect({ repo: activeRepo, branch });
    }
  };

  useEffect(() => {
    if (activeRepo && activeBranch) {
      onSelect({ repo: activeRepo, branch: activeBranch });
    }
  }, [activeRepo, activeBranch, onSelect]);

  return (
    <div className="space-y-3">
      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('github.searchRepos', { defaultValue: 'Search repositories...' })}
          className="pl-9"
        />
      </div>

      {error && <p className="text-sm text-red-500">{error}</p>}

      {/* Repo list */}
      <div className="max-h-48 overflow-y-auto rounded-lg border border-border">
        {loading ? (
          <div className="flex items-center justify-center gap-2 p-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('github.loadingRepos', { defaultValue: 'Loading repositories...' })}
          </div>
        ) : visibleRepos.length === 0 ? (
          <p className="p-4 text-center text-sm text-muted-foreground">
            {t('github.noRepos', { defaultValue: 'No repositories found' })}
          </p>
        ) : (
          visibleRepos.map((repo) => (
            <button
              key={repo.id}
              onClick={() => handleRepoSelect(repo)}
              className={`flex w-full items-center gap-3 border-b border-border/50 px-3 py-2 text-left transition-colors last:border-0 ${
                activeRepo?.id === repo.id || selectedRepo === repo.fullName
                  ? 'bg-primary/10 text-foreground'
                  : 'text-foreground hover:bg-muted/50'
              }`}
            >
              <img src={repo.owner.avatarUrl} alt="" className="h-5 w-5 rounded-full" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{repo.fullName}</p>
                {repo.description && (
                  <p className="truncate text-xs text-muted-foreground">{repo.description}</p>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                {repo.private && <Lock className="h-3 w-3 text-muted-foreground" />}
                {repo.language && (
                  <span className="text-xs text-muted-foreground">{repo.language}</span>
                )}
              </div>
            </button>
          ))
        )}
      </div>

      {/* Branch selector */}
      {activeRepo && (
        <div className="flex items-center gap-2">
          <GitBranch className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm text-muted-foreground">
            {t('github.branch', { defaultValue: 'Branch:' })}
          </span>
          {branchLoading ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : (
            <select
              value={activeBranch}
              onChange={(e) => handleBranchChange(e.target.value)}
              className="rounded-md border border-border bg-background px-2 py-1 text-sm"
            >
              {branches.length === 0 && activeBranch && (
                <option value={activeBranch}>{activeBranch}</option>
              )}
              {branches.map((b) => (
                <option key={b.name} value={b.name}>
                  {b.name}{b.isDefault ? ' (default)' : ''}
                </option>
              ))}
            </select>
          )}
        </div>
      )}
    </div>
  );
}
