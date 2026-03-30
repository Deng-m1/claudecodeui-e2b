import { useCallback, useEffect, useState } from 'react';
import { Github, LogOut, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge, Button } from '../../../../../../shared/view/ui';
import { authenticatedFetch } from '../../../../../../utils/api';

type GitHubUser = {
  login: string;
  avatarUrl: string;
  name: string | null;
};

export default function GitHubOAuthSection() {
  const { t } = useTranslation('settings');
  const [status, setStatus] = useState<{ connected: boolean; user?: GitHubUser }>({ connected: false });
  const [loading, setLoading] = useState(true);

  const fetchStatus = useCallback(async () => {
    try {
      setLoading(true);
      const res = await authenticatedFetch('/api/github/oauth/status');
      const data = await res.json();
      setStatus({
        connected: data.connected,
        user: data.connected ? { login: data.login, avatarUrl: data.avatarUrl, name: data.name } : undefined,
      });
    } catch {
      setStatus({ connected: false });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();

    const handler = (e: MessageEvent) => {
      if (e.data?.type === 'github-oauth-success') {
        fetchStatus();
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [fetchStatus]);

  const handleConnect = () => {
    window.open('/api/github/oauth/authorize', 'github-oauth', 'width=600,height=700');
  };

  const handleDisconnect = async () => {
    await authenticatedFetch('/api/github/oauth/disconnect', { method: 'DELETE' });
    setStatus({ connected: false });
  };

  return (
    <div className="space-y-4">
      <div>
        <h3 className="flex items-center gap-2 text-base font-semibold text-foreground">
          <Github className="h-5 w-5" />
          {t('github.title', { defaultValue: 'GitHub Connection' })}
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('github.description', { defaultValue: 'Connect your GitHub account to browse repositories and initialize cloud sandboxes.' })}
        </p>
      </div>

      <div className="rounded-lg border border-border bg-card p-4">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('github.checking', { defaultValue: 'Checking connection...' })}
          </div>
        ) : status.connected && status.user ? (
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <img
                src={status.user.avatarUrl}
                alt={status.user.login}
                className="h-10 w-10 rounded-full border border-border"
              />
              <div>
                <p className="text-sm font-medium text-foreground">
                  {status.user.name || status.user.login}
                </p>
                <p className="text-xs text-muted-foreground">@{status.user.login}</p>
              </div>
              <Badge variant="secondary" className="bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300">
                {t('github.connected', { defaultValue: 'Connected' })}
              </Badge>
            </div>
            <Button variant="outline" size="sm" onClick={handleDisconnect}>
              <LogOut className="mr-1.5 h-3.5 w-3.5" />
              {t('github.disconnect', { defaultValue: 'Disconnect' })}
            </Button>
          </div>
        ) : (
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-foreground">
                {t('github.notConnected', { defaultValue: 'GitHub not connected' })}
              </p>
              <p className="text-xs text-muted-foreground">
                {t('github.connectHint', { defaultValue: 'Connect to browse repos, select branches, and initialize cloud sandboxes.' })}
              </p>
            </div>
            <Button size="sm" onClick={handleConnect}>
              <Github className="mr-1.5 h-3.5 w-3.5" />
              {t('github.connect', { defaultValue: 'Connect GitHub' })}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
