import { useCallback, useEffect, useState } from 'react';
import { GitBranch, Loader2, Lock, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Input } from '../../shared/view/ui';
import { authenticatedFetch } from '../../utils/api';

type Repo = {
  id: number;
  name: string;
  fullName: string;
  private: boolean;
  description: string | null;
  defaultBranch: string;
  language: string | null;
  updatedAt: string;
  htmlUrl: string;
  cloneUrl: string;
  owner: { login: string; avatarUrl: string };
};

type Branch = {
  name: string;
  isDefault: boolean;
  sha: string;
};

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
      const params = new URLSearchParams({ per_page: '30', sort: 'updated' });
      if (query) params.set('q', query);
      const res = await authenticatedFetch(`/api/github/repos?${params}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load repos');
      setRepos(data.repos || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load repos');
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchBranches = useCallback(async (repo: Repo) => {
    try {
      setBranchLoading(true);
      const res = await authenticatedFetch(`/api/github/repos/${repo.owner.login}/${repo.name}/branches`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load branches');
      setBranches(data.branches || []);
      const defaultBranch = data.defaultBranch || repo.defaultBranch || 'main';
      setActiveBranch(selectedBranch || defaultBranch);
    } catch (err) {
      console.error('Failed to load branches:', err);
      setBranches([]);
    } finally {
      setBranchLoading(false);
    }
  }, [selectedBranch]);

  useEffect(() => {
    fetchRepos('');
  }, [fetchRepos]);

  useEffect(() => {
    const timer = setTimeout(() => { fetchRepos(search); }, 300);
    return () => clearTimeout(timer);
  }, [search, fetchRepos]);

  const handleRepoSelect = (repo: Repo) => {
    setActiveRepo(repo);
    fetchBranches(repo);
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
        ) : repos.length === 0 ? (
          <p className="p-4 text-center text-sm text-muted-foreground">
            {t('github.noRepos', { defaultValue: 'No repositories found' })}
          </p>
        ) : (
          repos.map((repo) => (
            <button
              key={repo.id}
              onClick={() => handleRepoSelect(repo)}
              className={`flex w-full items-center gap-3 border-b border-border/50 px-3 py-2 text-left transition-colors last:border-0 ${
                activeRepo?.id === repo.id || selectedRepo === repo.fullName
                  ? 'bg-primary/10 text-foreground'
                  : 'hover:bg-muted/50 text-foreground'
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
