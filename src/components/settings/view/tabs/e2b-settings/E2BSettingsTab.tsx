import { useCallback, useEffect, useState } from 'react';
import { Cloud, Monitor, Play, Pause, Trash2, RefreshCw, ExternalLink, GitBranch, Save } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge, Button } from '../../../../../shared/view/ui';
import { authenticatedFetch } from '../../../../../utils/api';
import GitHubRepoBrowser from '../../../../github-repo-browser/GitHubRepoBrowser';
import type { RuntimeMode } from '../../../../../types/app';

type SandboxStatus = {
  configured: boolean;
  sandboxId?: string;
  inspectorUrl?: string;
  agents?: string[];
  template?: string | null;
};

type SavedSandbox = {
  id: number;
  sandbox_id: string;
  repo_url: string | null;
  branch: string | null;
  workspace_path: string | null;
  status: string;
  last_activity: string;
};

export default function E2BSettingsTab() {
  const { t } = useTranslation('settings');
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>(() => {
    return (localStorage.getItem('runtime-mode') as RuntimeMode) || 'local';
  });
  const [status, setStatus] = useState<SandboxStatus>({ configured: false });
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [savedSandboxes, setSavedSandboxes] = useState<SavedSandbox[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<{ fullName: string; cloneUrl: string; branch: string } | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      setLoading(true);
      const res = await authenticatedFetch('/api/e2b/status');
      const data = await res.json();
      setStatus(data);
    } catch {
      setStatus({ configured: false });
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchSavedSandboxes = useCallback(async () => {
    try {
      const res = await authenticatedFetch('/api/e2b/sandboxes');
      const data = await res.json();
      setSavedSandboxes(data.sandboxes || []);
    } catch {
      setSavedSandboxes([]);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    fetchSavedSandboxes();
  }, [fetchStatus, fetchSavedSandboxes]);

  const handleModeChange = (mode: RuntimeMode) => {
    setRuntimeMode(mode);
    localStorage.setItem('runtime-mode', mode);
  };

  const handleCreateSandbox = async () => {
    try {
      setActionLoading('create');
      const res = await authenticatedFetch('/api/e2b/sandbox/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (data.sandboxId) {
        await fetchStatus();
      }
    } catch (err) {
      console.error('Failed to create sandbox:', err);
    } finally {
      setActionLoading(null);
    }
  };

  const handlePauseSandbox = async () => {
    if (!status.sandboxId) return;
    try {
      setActionLoading('pause');
      await authenticatedFetch('/api/e2b/sandbox/pause', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sandboxId: status.sandboxId }),
      });
      await fetchStatus();
    } catch (err) {
      console.error('Failed to pause sandbox:', err);
    } finally {
      setActionLoading(null);
    }
  };

  const handleDestroySandbox = async () => {
    if (!status.sandboxId) return;
    try {
      setActionLoading('destroy');
      await authenticatedFetch('/api/e2b/sandbox/destroy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sandboxId: status.sandboxId }),
      });
      await fetchStatus();
    } catch (err) {
      console.error('Failed to destroy sandbox:', err);
    } finally {
      setActionLoading(null);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold text-foreground">
          {t('e2b.title', { defaultValue: 'E2B Cloud Sandbox' })}
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('e2b.description', { defaultValue: 'Run AI coding agents in remote E2B cloud sandboxes instead of locally.' })}
        </p>
      </div>

      {/* Runtime mode toggle */}
      <div className="space-y-3">
        <h4 className="text-sm font-medium text-foreground">
          {t('e2b.runtimeMode', { defaultValue: 'Runtime Mode' })}
        </h4>
        <div className="flex gap-3">
          <button
            onClick={() => handleModeChange('local')}
            className={`flex flex-1 items-center gap-3 rounded-lg border-[1.5px] p-4 transition-all ${
              runtimeMode === 'local'
                ? 'border-primary bg-primary/5 ring-2 ring-primary/15'
                : 'border-border bg-card/60 hover:border-border/80 hover:bg-card'
            }`}
          >
            <Monitor className="h-5 w-5 flex-shrink-0" />
            <div className="text-left">
              <p className="text-sm font-semibold text-foreground">
                {t('e2b.local.title', { defaultValue: 'Local' })}
              </p>
              <p className="text-xs text-muted-foreground">
                {t('e2b.local.description', { defaultValue: 'Run agents on this machine' })}
              </p>
            </div>
          </button>
          <button
            onClick={() => handleModeChange('e2b')}
            className={`flex flex-1 items-center gap-3 rounded-lg border-[1.5px] p-4 transition-all ${
              runtimeMode === 'e2b'
                ? 'border-sky-500 bg-sky-50 ring-2 ring-sky-500/15 dark:bg-sky-900/20'
                : 'border-border bg-card/60 hover:border-border/80 hover:bg-card'
            }`}
          >
            <Cloud className="h-5 w-5 flex-shrink-0" />
            <div className="text-left">
              <p className="text-sm font-semibold text-foreground">
                {t('e2b.cloud.title', { defaultValue: 'E2B Cloud' })}
              </p>
              <p className="text-xs text-muted-foreground">
                {t('e2b.cloud.description', { defaultValue: 'Run agents in remote cloud sandboxes' })}
              </p>
            </div>
          </button>
        </div>
      </div>

      {/* Sandbox status */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-medium text-foreground">
            {t('e2b.sandboxStatus', { defaultValue: 'Sandbox Status' })}
          </h4>
          <Button variant="ghost" size="sm" onClick={fetchStatus} disabled={loading}>
            <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            {t('e2b.refresh', { defaultValue: 'Refresh' })}
          </Button>
        </div>

        <div className="rounded-lg border border-border bg-card p-4">
          {!status.configured ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Badge variant="secondary" className="bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
                  {t('e2b.status.notConfigured', { defaultValue: 'Not Configured' })}
                </Badge>
              </div>
              <p className="text-sm text-muted-foreground">
                {t('e2b.status.notConfiguredHint', { defaultValue: 'Set E2B_API_KEY in your .env file to enable cloud sandboxes.' })}
              </p>
              {status.template && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>{t('e2b.template', { defaultValue: 'Template:' })}</span>
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground">{status.template}</code>
                </div>
              )}
            </div>
          ) : status.sandboxId ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Badge variant="secondary" className="bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300">
                  {t('e2b.status.running', { defaultValue: 'Running' })}
                </Badge>
                <span className="text-xs text-muted-foreground font-mono">{status.sandboxId}</span>
              </div>
              {status.agents && status.agents.length > 0 && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    {t('e2b.availableAgents', { defaultValue: 'Available agents:' })}
                  </span>
                  {status.agents.map((agent) => (
                    <Badge key={agent} variant="outline" className="text-xs">
                      {agent}
                    </Badge>
                  ))}
                </div>
              )}
              {status.template && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>{t('e2b.template', { defaultValue: 'Template:' })}</span>
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground">{status.template}</code>
                </div>
              )}
              {status.inspectorUrl && (
                <a
                  href={status.inspectorUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                >
                  <ExternalLink className="h-3 w-3" />
                  {t('e2b.openInspector', { defaultValue: 'Open Inspector' })}
                </a>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Badge variant="secondary" className="bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300">
                  {t('e2b.status.idle', { defaultValue: 'No Active Sandbox' })}
                </Badge>
              </div>
              {status.template && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>{t('e2b.template', { defaultValue: 'Template:' })}</span>
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground">{status.template}</code>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Sandbox controls */}
      {status.configured && (
        <div className="space-y-3">
          <h4 className="text-sm font-medium text-foreground">
            {t('e2b.controls', { defaultValue: 'Sandbox Controls' })}
          </h4>
          <div className="flex flex-wrap gap-2">
            {!status.sandboxId ? (
              <Button
                size="sm"
                onClick={handleCreateSandbox}
                disabled={actionLoading !== null}
              >
                <Play className="mr-1.5 h-3.5 w-3.5" />
                {actionLoading === 'create'
                  ? t('e2b.creating', { defaultValue: 'Creating...' })
                  : t('e2b.createSandbox', { defaultValue: 'Create Sandbox' })}
              </Button>
            ) : (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handlePauseSandbox}
                  disabled={actionLoading !== null}
                >
                  <Pause className="mr-1.5 h-3.5 w-3.5" />
                  {actionLoading === 'pause'
                    ? t('e2b.pausing', { defaultValue: 'Pausing...' })
                    : t('e2b.pauseSandbox', { defaultValue: 'Pause' })}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleDestroySandbox}
                  disabled={actionLoading !== null}
                  className="text-red-600 hover:text-red-700 dark:text-red-400"
                >
                  <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                  {actionLoading === 'destroy'
                    ? t('e2b.destroying', { defaultValue: 'Destroying...' })
                    : t('e2b.destroySandbox', { defaultValue: 'Destroy' })}
                </Button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Initialize from Repository */}
      {status.configured && (
        <div className="space-y-3">
          <h4 className="text-sm font-medium text-foreground">
            {t('e2b.initFromRepo', { defaultValue: 'Initialize from Repository' })}
          </h4>
          <p className="text-xs text-muted-foreground">
            {t('e2b.initFromRepoHint', { defaultValue: 'Clone a GitHub repo into a new cloud sandbox.' })}
          </p>
          <GitHubRepoBrowser
            onSelect={({ repo, branch }) => setSelectedRepo({ fullName: repo.fullName, cloneUrl: repo.cloneUrl, branch })}
            selectedRepo={selectedRepo?.fullName}
            selectedBranch={selectedRepo?.branch}
          />
          {selectedRepo && (
            <Button
              size="sm"
              onClick={async () => {
                try {
                  setActionLoading('clone');
                  const res = await authenticatedFetch('/api/e2b/sandbox/create-with-repo', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ repoUrl: selectedRepo.cloneUrl, branch: selectedRepo.branch }),
                  });
                  const data = await res.json();
                  if (data.success) {
                    await fetchStatus();
                    await fetchSavedSandboxes();
                  }
                } catch (err) {
                  console.error('Failed to create sandbox from repo:', err);
                } finally {
                  setActionLoading(null);
                }
              }}
              disabled={actionLoading !== null}
            >
              <Play className="mr-1.5 h-3.5 w-3.5" />
              {actionLoading === 'clone'
                ? t('e2b.cloning', { defaultValue: 'Cloning...' })
                : t('e2b.createFromRepo', { defaultValue: 'Create Sandbox from Repo' })}
            </Button>
          )}
        </div>
      )}

      {/* Saved Sandboxes */}
      {savedSandboxes.length > 0 && (
        <div className="space-y-3">
          <h4 className="text-sm font-medium text-foreground">
            {t('e2b.savedSandboxes', { defaultValue: 'Saved Sandboxes' })}
          </h4>
          <div className="space-y-2">
            {savedSandboxes.map((sb) => (
              <div key={sb.id} className="flex items-center justify-between rounded-lg border border-border bg-card p-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Badge
                      variant="secondary"
                      className={
                        sb.status === 'running'
                          ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'
                          : 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300'
                      }
                    >
                      {sb.status}
                    </Badge>
                    <span className="truncate text-xs font-mono text-muted-foreground">{sb.sandbox_id}</span>
                  </div>
                  {sb.repo_url && (
                    <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                      <GitBranch className="h-3 w-3" />
                      <span className="truncate">{sb.repo_url.split('/').slice(-2).join('/')}</span>
                      {sb.branch && <span>({sb.branch})</span>}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  {sb.status === 'paused' && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={async () => {
                        try {
                          setActionLoading(`resume-${sb.id}`);
                          await authenticatedFetch('/api/e2b/sandbox/resume', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ sandboxId: sb.sandbox_id }),
                          });
                          await fetchStatus();
                          await fetchSavedSandboxes();
                        } finally {
                          setActionLoading(null);
                        }
                      }}
                      disabled={actionLoading !== null}
                    >
                      <Play className="mr-1 h-3 w-3" />
                      {t('e2b.resume', { defaultValue: 'Resume' })}
                    </Button>
                  )}
                  {sb.status === 'running' && sb.workspace_path && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={async () => {
                        try {
                          setActionLoading(`save-${sb.id}`);
                          await authenticatedFetch('/api/e2b/sandbox/git-save', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ workspacePath: sb.workspace_path }),
                          });
                        } finally {
                          setActionLoading(null);
                        }
                      }}
                      disabled={actionLoading !== null}
                    >
                      <Save className="mr-1 h-3 w-3" />
                      {t('e2b.gitSave', { defaultValue: 'Save to Git' })}
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
