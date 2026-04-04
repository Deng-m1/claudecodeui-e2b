import { authenticatedFetch, parseApiJson } from './api';

export type GitHubRepo = {
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

export type GitHubBranch = {
  name: string;
  isDefault?: boolean;
  sha?: string;
};

type GitHubRepoListResponse = {
  repos?: GitHubRepo[];
  error?: string;
};

type GitHubBranchListResponse = {
  branches?: GitHubBranch[];
  defaultBranch?: string;
  error?: string;
};

type GitHubOAuthStatusResponse = {
  connected?: boolean;
  error?: string;
};

export function normalizeGitHubRepoQuery(value?: string | null) {
  return value?.trim().toLowerCase() ?? '';
}

export function buildGitHubRepoSearchParams(query: string, perPage = 30) {
  const params = new URLSearchParams({
    per_page: String(perPage),
    sort: 'updated',
  });

  const normalizedQuery = query.trim();
  if (normalizedQuery) {
    params.set('q', normalizedQuery);
  }

  return params.toString();
}

export function matchesGitHubRepoQuery(repo: GitHubRepo, query: string) {
  const normalizedQuery = normalizeGitHubRepoQuery(query);
  if (!normalizedQuery) {
    return true;
  }

  return [
    repo.fullName,
    repo.name,
    repo.owner.login,
    repo.description || '',
  ].some((value) => value.toLowerCase().includes(normalizedQuery));
}

export function matchesGitHubRepoSelection(repo: GitHubRepo, value?: string | null) {
  const normalizedValue = normalizeGitHubRepoQuery(value);
  if (!normalizedValue) {
    return false;
  }

  const repoPath = `${repo.owner.login}/${repo.name}`.toLowerCase();
  const cloneUrl = repo.cloneUrl.toLowerCase();
  const cloneUrlWithoutGit = cloneUrl.replace(/\.git$/, '');
  const htmlUrl = repo.htmlUrl.toLowerCase();

  return (
    normalizedValue === repo.fullName.toLowerCase() ||
    normalizedValue === repoPath ||
    normalizedValue === repo.name.toLowerCase() ||
    normalizedValue === cloneUrl ||
    normalizedValue === cloneUrlWithoutGit ||
    normalizedValue === htmlUrl ||
    normalizedValue.endsWith(`/${repoPath}`) ||
    normalizedValue.endsWith(`/${repo.name.toLowerCase()}`)
  );
}

export function mergeGitHubRepos(...lists: GitHubRepo[][]) {
  const merged = new Map<string, GitHubRepo>();

  for (const list of lists) {
    for (const repo of list) {
      merged.set(String(repo.id ?? repo.fullName), repo);
    }
  }

  return Array.from(merged.values());
}

export function resolveGitHubBranchSelection(
  preferredBranch: string | null | undefined,
  branches: GitHubBranch[],
  fallbackBranch = '',
) {
  const normalizedPreferredBranch = preferredBranch?.trim();
  if (normalizedPreferredBranch && branches.some((branch) => branch.name === normalizedPreferredBranch)) {
    return normalizedPreferredBranch;
  }

  return (
    branches.find((branch) => branch.isDefault)?.name ||
    fallbackBranch ||
    branches[0]?.name ||
    ''
  );
}

export async function fetchGitHubOAuthStatus() {
  const response = await authenticatedFetch('/api/github/oauth/status');
  const data = (await parseApiJson(
    response,
    'Failed to load GitHub connection status',
  )) as GitHubOAuthStatusResponse | null;

  if (!response.ok) {
    throw new Error(data?.error || 'Failed to load GitHub connection status');
  }

  return Boolean(data?.connected);
}

export async function fetchGitHubRepos(query: string) {
  const response = await authenticatedFetch(`/api/github/repos?${buildGitHubRepoSearchParams(query)}`);
  const data = (await parseApiJson(
    response,
    'Failed to load repositories',
  )) as GitHubRepoListResponse | null;

  if (!response.ok) {
    throw new Error(data?.error || 'Failed to load repositories');
  }

  return Array.isArray(data?.repos) ? data.repos : [];
}

export async function fetchGitHubBranches(repo: Pick<GitHubRepo, 'name' | 'owner' | 'defaultBranch'>) {
  const response = await authenticatedFetch(
    `/api/github/repos/${encodeURIComponent(repo.owner.login)}/${encodeURIComponent(repo.name)}/branches`,
  );
  const data = (await parseApiJson(
    response,
    'Failed to load branches',
  )) as GitHubBranchListResponse | null;

  if (!response.ok) {
    throw new Error(data?.error || 'Failed to load branches');
  }

  return {
    branches: Array.isArray(data?.branches) ? data.branches : [],
    defaultBranch: data?.defaultBranch || repo.defaultBranch || 'main',
  };
}
