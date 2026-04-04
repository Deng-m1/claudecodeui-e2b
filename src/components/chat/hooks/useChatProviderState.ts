import { useCallback, useEffect, useRef, useState } from 'react';
import { authenticatedFetch } from '../../../utils/api';
import { DEFAULT_CODEX_PERMISSION_MODE, normalizeCodexPermissionMode } from '../../settings/constants/constants';
import { CLAUDE_MODELS, CODEX_MODELS, CURSOR_MODELS, GEMINI_MODELS } from '../../../../shared/modelConstants';
import type { PendingPermissionRequest, PermissionMode } from '../types/types';
import type { ProjectSession, RuntimeMode, SessionProvider } from '../../../types/app';

interface UseChatProviderStateArgs {
  selectedSession: ProjectSession | null;
}

type LauncherConfigDetail = {
  provider?: SessionProvider;
  runtimeMode?: RuntimeMode;
  claudeModel?: string;
  cursorModel?: string;
  codexModel?: string;
  geminiModel?: string;
};

const VALID_CURSOR_MODELS = new Set(CURSOR_MODELS.OPTIONS.map((option) => option.value));

const getDefaultPermissionModeForProvider = (provider: SessionProvider): PermissionMode => {
  if (provider !== 'codex') {
    return 'default';
  }

  try {
    const raw = localStorage.getItem('codex-settings');
    if (!raw) {
      return DEFAULT_CODEX_PERMISSION_MODE;
    }

    const parsed = JSON.parse(raw) as { permissionMode?: unknown };
    return normalizeCodexPermissionMode(parsed.permissionMode);
  } catch {
    return DEFAULT_CODEX_PERMISSION_MODE;
  }
};

const hasSessionPermissionOverride = (sessionId?: string | null): boolean => {
  if (!sessionId) {
    return false;
  }

  return Boolean(localStorage.getItem(`permissionMode-${sessionId}`));
};

export function useChatProviderState({ selectedSession }: UseChatProviderStateArgs) {
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(() => (
    getDefaultPermissionModeForProvider((localStorage.getItem('selected-provider') as SessionProvider) || 'claude')
  ));
  const [pendingPermissionRequests, setPendingPermissionRequests] = useState<PendingPermissionRequest[]>([]);
  const [provider, setProvider] = useState<SessionProvider>(() => {
    return (localStorage.getItem('selected-provider') as SessionProvider) || 'claude';
  });
  const [cursorModel, setCursorModel] = useState<string>(() => {
    const storedModel = localStorage.getItem('cursor-model');
    return storedModel && VALID_CURSOR_MODELS.has(storedModel)
      ? storedModel
      : CURSOR_MODELS.DEFAULT;
  });
  const [claudeModel, setClaudeModel] = useState<string>(() => {
    return localStorage.getItem('claude-model') || CLAUDE_MODELS.DEFAULT;
  });
  const [codexModel, setCodexModel] = useState<string>(() => {
    return localStorage.getItem('codex-model') || CODEX_MODELS.DEFAULT;
  });
  const [geminiModel, setGeminiModel] = useState<string>(() => {
    return localStorage.getItem('gemini-model') || GEMINI_MODELS.DEFAULT;
  });
  const [runtimeMode, setRuntimeModeState] = useState<RuntimeMode>(() => {
    return (localStorage.getItem('runtime-mode') as RuntimeMode) || 'local';
  });

  const setRuntimeMode = useCallback((mode: RuntimeMode) => {
    setRuntimeModeState(mode);
    localStorage.setItem('runtime-mode', mode);
  }, []);

  const lastProviderRef = useRef(provider);

  useEffect(() => {
    if (selectedSession?.id) {
      const savedMode = localStorage.getItem(`permissionMode-${selectedSession.id}`);
      if (savedMode) {
        setPermissionMode(savedMode as PermissionMode);
        return;
      }
    }

    setPermissionMode(getDefaultPermissionModeForProvider(provider));
  }, [provider, selectedSession?.id]);

  useEffect(() => {
    if (!selectedSession?.__provider || selectedSession.__provider === provider) {
      return;
    }

    setProvider(selectedSession.__provider);
    localStorage.setItem('selected-provider', selectedSession.__provider);
  }, [provider, selectedSession?.__provider]);

  useEffect(() => {
    if (!selectedSession?.__runtime || selectedSession.__runtime === runtimeMode) {
      return;
    }

    setRuntimeModeState(selectedSession.__runtime);
    localStorage.setItem('runtime-mode', selectedSession.__runtime);
  }, [runtimeMode, selectedSession?.__runtime]);

  useEffect(() => {
    if (lastProviderRef.current === provider) {
      return;
    }
    setPendingPermissionRequests([]);
    lastProviderRef.current = provider;
  }, [provider]);

  useEffect(() => {
    setPendingPermissionRequests((previous) =>
      previous.filter((request) => !request.sessionId || request.sessionId === selectedSession?.id),
    );
  }, [selectedSession?.id]);

  useEffect(() => {
    if (provider !== 'cursor') {
      return;
    }

    authenticatedFetch('/api/cursor/config')
      .then((response) => response.json())
      .then((data) => {
        if (!data.success || !data.config?.model?.modelId) {
          return;
        }

        const modelId = data.config.model.modelId as string;
        const normalizedModelId = VALID_CURSOR_MODELS.has(modelId) ? modelId : CURSOR_MODELS.DEFAULT;
        if (!localStorage.getItem('cursor-model')) {
          setCursorModel(normalizedModelId);
          localStorage.setItem('cursor-model', normalizedModelId);
        }
      })
      .catch((error) => {
        console.error('Error loading Cursor config:', error);
      });
  }, [provider]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const handleCodexSettingsChanged = (event: Event) => {
      if (provider !== 'codex') {
        return;
      }

      if (hasSessionPermissionOverride(selectedSession?.id)) {
        return;
      }

      const detail = (event as CustomEvent<{ permissionMode?: PermissionMode }>).detail;
      setPermissionMode(normalizeCodexPermissionMode(detail?.permissionMode));
    };

    window.addEventListener('claudecodeui:codex-settings-changed', handleCodexSettingsChanged as EventListener);
    return () => {
      window.removeEventListener('claudecodeui:codex-settings-changed', handleCodexSettingsChanged as EventListener);
    };
  }, [provider, selectedSession?.id]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const handleLauncherConfig = (event: Event) => {
      const detail = (event as CustomEvent<LauncherConfigDetail>).detail;
      if (!detail) {
        return;
      }

      if (detail.provider) {
        setProvider(detail.provider);
        localStorage.setItem('selected-provider', detail.provider);
      }

      if (detail.runtimeMode) {
        setRuntimeMode(detail.runtimeMode);
      }

      if (detail.claudeModel) {
        setClaudeModel(detail.claudeModel);
        localStorage.setItem('claude-model', detail.claudeModel);
      }

      if (detail.cursorModel) {
        const normalizedModelId = VALID_CURSOR_MODELS.has(detail.cursorModel)
          ? detail.cursorModel
          : CURSOR_MODELS.DEFAULT;
        setCursorModel(normalizedModelId);
        localStorage.setItem('cursor-model', normalizedModelId);
      }

      if (detail.codexModel) {
        setCodexModel(detail.codexModel);
        localStorage.setItem('codex-model', detail.codexModel);
      }

      if (detail.geminiModel) {
        setGeminiModel(detail.geminiModel);
        localStorage.setItem('gemini-model', detail.geminiModel);
      }
    };

    window.addEventListener('claudecodeui:launch-config', handleLauncherConfig as EventListener);
    return () => {
      window.removeEventListener('claudecodeui:launch-config', handleLauncherConfig as EventListener);
    };
  }, [setRuntimeMode]);

  const cyclePermissionMode = useCallback(() => {
    const modes: PermissionMode[] =
      provider === 'codex'
        ? ['default', 'acceptEdits', 'bypassPermissions']
        : ['default', 'acceptEdits', 'bypassPermissions', 'plan'];

    const currentIndex = modes.indexOf(permissionMode);
    const nextIndex = (currentIndex + 1) % modes.length;
    const nextMode = modes[nextIndex];
    setPermissionMode(nextMode);

    if (selectedSession?.id) {
      localStorage.setItem(`permissionMode-${selectedSession.id}`, nextMode);
    }
  }, [permissionMode, provider, selectedSession?.id]);

  return {
    provider,
    setProvider,
    cursorModel,
    setCursorModel,
    claudeModel,
    setClaudeModel,
    codexModel,
    setCodexModel,
    geminiModel,
    setGeminiModel,
    permissionMode,
    setPermissionMode,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    cyclePermissionMode,
    runtimeMode,
    setRuntimeMode,
  };
}
