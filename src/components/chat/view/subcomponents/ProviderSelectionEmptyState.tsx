import React, { useState, useEffect, useCallback } from "react";
import { Check, ChevronDown, Cloud, Monitor, GitBranch, Play, Loader2, Server } from "lucide-react";
import { useTranslation } from "react-i18next";
import SessionProviderLogo from "../../../llm-logo-provider/SessionProviderLogo";
import {
  CLAUDE_MODELS,
  CURSOR_MODELS,
  CODEX_MODELS,
  GEMINI_MODELS,
} from "../../../../../shared/modelConstants";
import type { Project, ProjectSession, RuntimeMode, SessionProvider } from "../../../../types/app";
import { isCloudProject as isResolvedCloudProject } from '../../../../utils/sessionSelection';
import { NextTaskBanner } from "../../../task-master";
import {
  type GitHubBranch,
  type GitHubRepo,
  fetchGitHubBranches,
  fetchGitHubOAuthStatus,
  fetchGitHubRepos,
  mergeGitHubRepos,
  matchesGitHubRepoQuery,
  resolveGitHubBranchSelection,
} from "../../../../utils/github";

type ProviderSelectionEmptyStateProps = {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  provider: SessionProvider;
  setProvider: (next: SessionProvider) => void;
  runtimeMode: RuntimeMode;
  setRuntimeMode: (mode: RuntimeMode) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement>;
  claudeModel: string;
  setClaudeModel: (model: string) => void;
  cursorModel: string;
  setCursorModel: (model: string) => void;
  codexModel: string;
  setCodexModel: (model: string) => void;
  geminiModel: string;
  setGeminiModel: (model: string) => void;
  tasksEnabled: boolean;
  isTaskMasterInstalled: boolean | null;
  onShowAllTasks?: (() => void) | null;
  setInput: React.Dispatch<React.SetStateAction<string>>;
};

type ProviderDef = {
  id: SessionProvider;
  name: string;
  infoKey: string;
  accent: string;
  ring: string;
  check: string;
};

const PROVIDERS: ProviderDef[] = [
  {
    id: "claude",
    name: "Claude Code",
    infoKey: "providerSelection.providerInfo.anthropic",
    accent: "border-primary",
    ring: "ring-primary/15",
    check: "bg-primary text-primary-foreground",
  },
  {
    id: "cursor",
    name: "Cursor",
    infoKey: "providerSelection.providerInfo.cursorEditor",
    accent: "border-violet-500 dark:border-violet-400",
    ring: "ring-violet-500/15",
    check: "bg-violet-500 text-white",
  },
  {
    id: "codex",
    name: "Codex",
    infoKey: "providerSelection.providerInfo.openai",
    accent: "border-emerald-600 dark:border-emerald-400",
    ring: "ring-emerald-600/15",
    check: "bg-emerald-600 dark:bg-emerald-500 text-white",
  },
  {
    id: "gemini",
    name: "Gemini",
    infoKey: "providerSelection.providerInfo.google",
    accent: "border-blue-500 dark:border-blue-400",
    ring: "ring-blue-500/15",
    check: "bg-blue-500 text-white",
  },
];

function getModelConfig(p: SessionProvider) {
  if (p === "claude") return CLAUDE_MODELS;
  if (p === "codex") return CODEX_MODELS;
  if (p === "gemini") return GEMINI_MODELS;
  return CURSOR_MODELS;
}

function getModelValue(
  p: SessionProvider,
  c: string,
  cu: string,
  co: string,
  g: string,
) {
  if (p === "claude") return c;
  if (p === "codex") return co;
  if (p === "gemini") return g;
  return cu;
}

function E2BCloudPanel({
  provider,
  setProvider,
  setRuntimeMode,
  textareaRef,
  claudeModel,
  setClaudeModel,
  cursorModel,
  setCursorModel,
  codexModel,
  setCodexModel,
  geminiModel,
  setGeminiModel,
}: {
  provider: SessionProvider;
  setProvider: (next: SessionProvider) => void;
  setRuntimeMode: (mode: RuntimeMode) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement>;
  claudeModel: string;
  setClaudeModel: (model: string) => void;
  cursorModel: string;
  setCursorModel: (model: string) => void;
  codexModel: string;
  setCodexModel: (model: string) => void;
  geminiModel: string;
  setGeminiModel: (model: string) => void;
}) {
  const { t } = useTranslation("chat");
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [repoCatalog, setRepoCatalog] = useState<GitHubRepo[]>([]);
  const [branches, setBranches] = useState<GitHubBranch[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<GitHubRepo | null>(null);
  const [selectedBranch, setSelectedBranch] = useState("");
  const [repoSearch, setRepoSearch] = useState("");
  const [githubConnected, setGithubConnected] = useState(false);
  const [isLoadingRepos, setIsLoadingRepos] = useState(false);
  const [isLoadingBranches, setIsLoadingBranches] = useState(false);
  const [isCreatingSandbox, setIsCreatingSandbox] = useState(false);
  const [showRepoDropdown, setShowRepoDropdown] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const syncGitHubConnection = async () => {
      try {
        const connected = await fetchGitHubOAuthStatus();
        if (cancelled) {
          return;
        }

        setGithubConnected(connected);
        if (!connected) {
          setRepos([]);
          setRepoCatalog([]);
          setBranches([]);
          setSelectedRepo(null);
          setSelectedBranch("");
        }
      } catch {
        if (cancelled) {
          return;
        }

        setGithubConnected(false);
        setRepos([]);
        setRepoCatalog([]);
        setBranches([]);
        setSelectedRepo(null);
        setSelectedBranch("");
      }
    };

    const handleOAuthSuccess = (event: MessageEvent) => {
      if (event.data?.type === "github-oauth-success") {
        void syncGitHubConnection();
      }
    };

    void syncGitHubConnection();
    window.addEventListener("message", handleOAuthSuccess);

    return () => {
      cancelled = true;
      window.removeEventListener("message", handleOAuthSuccess);
    };
  }, []);

  const fetchRepos = useCallback(async (search: string) => {
    setIsLoadingRepos(true);
    try {
      const nextRepos = await fetchGitHubRepos(search);
      setRepos(nextRepos);
      setRepoCatalog((currentRepos) => mergeGitHubRepos(currentRepos, nextRepos));
    } catch (error) {
      console.error("Failed to load repositories:", error);
      setRepos([]);
    } finally {
      setIsLoadingRepos(false);
    }
  }, []);

  const fetchBranches = useCallback(async (repo: GitHubRepo, preferredBranch?: string) => {
    setIsLoadingBranches(true);
    try {
      const { branches: nextBranches, defaultBranch } = await fetchGitHubBranches(repo);
      setBranches(nextBranches);
      setSelectedBranch(resolveGitHubBranchSelection(preferredBranch, nextBranches, defaultBranch));
    } catch (error) {
      console.error("Failed to load branches:", error);
      setBranches([]);
      setSelectedBranch(preferredBranch || repo.defaultBranch || "");
    } finally {
      setIsLoadingBranches(false);
    }
  }, []);

  useEffect(() => {
    if (!githubConnected) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void fetchRepos(repoSearch);
    }, 180);

    return () => window.clearTimeout(timeoutId);
  }, [fetchRepos, githubConnected, repoSearch]);

  const handleRepoSelect = (repo: GitHubRepo) => {
    setSelectedRepo(repo);
    setShowRepoDropdown(false);
    setRepoSearch(repo.fullName);
    void fetchBranches(repo, repo.defaultBranch);
  };

  const handleStartCloud = async () => {
    if (!selectedRepo) return;
    setIsCreatingSandbox(true);
    try {
      const repoUrl = selectedRepo.cloneUrl;
      const res = await fetch("/api/e2b/sandbox/create-with-repo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ repoUrl, branch: selectedBranch || selectedRepo.defaultBranch }),
      });
      const data = await res.json();
      if (data.success) {
        setRuntimeMode("e2b");
        localStorage.setItem("runtime-mode", "e2b");
        setTimeout(() => textareaRef.current?.focus(), 100);
      }
    } catch {
      // error handled silently
    } finally {
      setIsCreatingSandbox(false);
    }
  };

  const selectProvider = (next: SessionProvider) => {
    setProvider(next);
    localStorage.setItem("selected-provider", next);
  };

  const handleModelChange = (value: string) => {
    if (provider === "claude") {
      setClaudeModel(value);
      localStorage.setItem("claude-model", value);
    } else if (provider === "codex") {
      setCodexModel(value);
      localStorage.setItem("codex-model", value);
    } else if (provider === "gemini") {
      setGeminiModel(value);
      localStorage.setItem("gemini-model", value);
    } else {
      setCursorModel(value);
      localStorage.setItem("cursor-model", value);
    }
  };

  const modelConfig = getModelConfig(provider);
  const currentModel = getModelValue(provider, claudeModel, cursorModel, codexModel, geminiModel);

  const filteredRepos = mergeGitHubRepos(repos, repoCatalog).filter(
    (repo) => matchesGitHubRepoQuery(repo, repoSearch),
  );

  if (!githubConnected) {
    return (
      <div className="text-center">
        <Cloud className="mx-auto mb-3 h-10 w-10 text-sky-500" />
        <p className="text-sm font-medium text-foreground">
          {t("providerSelection.e2bCloud.connectGithubTitle", {
            defaultValue: "Connect GitHub to get started",
          })}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("providerSelection.e2bCloud.connectGithubDesc", {
            defaultValue: "Link your GitHub account to clone repos into cloud sandboxes",
          })}
        </p>
        <button
          onClick={() => {
            window.open("/api/github/oauth/authorize", "github-oauth", "width=600,height=700");
          }}
          className="mt-4 rounded-lg bg-[#24292f] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#24292f]/90"
        >
          {t("providerSelection.e2bCloud.connectGithub", {
            defaultValue: "Connect GitHub",
          })}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Repo selector */}
      <div>
        <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
          {t("providerSelection.e2bCloud.repository", { defaultValue: "Repository" })}
        </label>
        <div className="relative">
          <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-card px-3 py-2">
            <GitBranch className="h-4 w-4 shrink-0 text-muted-foreground" />
            <input
              type="text"
              value={repoSearch}
              onChange={(e) => {
                const nextSearch = e.target.value;
                setRepoSearch(nextSearch);
                setShowRepoDropdown(true);
                if (selectedRepo && nextSearch.trim() !== selectedRepo.fullName) {
                  setSelectedRepo(null);
                  setBranches([]);
                  setSelectedBranch("");
                }
              }}
              onFocus={() => setShowRepoDropdown(true)}
              placeholder={t("providerSelection.e2bCloud.searchRepos", {
                defaultValue: "Search repositories...",
              })}
              className="w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none"
            />
            {isLoadingRepos && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />}
          </div>
          {showRepoDropdown && (
            <div className="absolute left-0 right-0 top-full z-30 mt-1 max-h-48 overflow-y-auto rounded-lg border border-border bg-popover shadow-lg">
              {filteredRepos.length === 0 ? (
                <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                  {isLoadingRepos
                    ? t("providerSelection.e2bCloud.loading", { defaultValue: "Loading..." })
                    : t("providerSelection.e2bCloud.noRepos", { defaultValue: "No repositories found" })}
                </div>
              ) : (
                filteredRepos.slice(0, 20).map((repo) => (
                  <button
                    key={repo.fullName}
                    onClick={() => handleRepoSelect(repo)}
                    className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-accent"
                  >
                    <img
                      src={repo.owner.avatarUrl}
                      alt=""
                      className="h-5 w-5 shrink-0 rounded-full"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">{repo.fullName}</p>
                    </div>
                    {repo.private && (
                      <span className="shrink-0 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                        Private
                      </span>
                    )}
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      </div>

      {/* Branch selector */}
      {selectedRepo && (
        <div>
          <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
            {t("providerSelection.e2bCloud.branch", { defaultValue: "Branch" })}
          </label>
          <div className="relative">
            <select
              value={selectedBranch}
              onChange={(e) => setSelectedBranch(e.target.value)}
              disabled={isLoadingBranches}
              className="w-full cursor-pointer appearance-none rounded-lg border border-border/60 bg-card px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted/50 focus:outline-none focus:ring-2 focus:ring-sky-500/20"
            >
              {!isLoadingBranches && branches.length === 0 && (
                <option value={selectedBranch || selectedRepo.defaultBranch || ""}>
                  {selectedBranch || selectedRepo.defaultBranch || "Select a repository first"}
                </option>
              )}
              {branches.map((b) => (
                <option key={b.name} value={b.name}>
                  {b.name}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          </div>
        </div>
      )}

      {/* Agent + model selector (compact row) */}
      <div>
        <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
          {t("providerSelection.e2bCloud.agent", { defaultValue: "Agent" })}
        </label>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 rounded-lg border border-border/60 bg-card p-0.5">
            {PROVIDERS.map((p) => (
              <button
                key={p.id}
                onClick={() => selectProvider(p.id)}
                className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-all duration-150 ${
                  provider === p.id
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <SessionProviderLogo provider={p.id} className="h-4 w-4" />
                <span className="hidden sm:inline">{p.name}</span>
              </button>
            ))}
          </div>
          <div className="relative flex-1">
            <select
              value={currentModel}
              onChange={(e) => handleModelChange(e.target.value)}
              className="w-full cursor-pointer appearance-none rounded-lg border border-border/60 bg-card px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-muted/50 focus:outline-none focus:ring-2 focus:ring-sky-500/20"
            >
              {modelConfig.OPTIONS.map(({ value, label }: { value: string; label: string }) => (
                <option key={value + label} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
          </div>
        </div>
      </div>

      {/* Start button */}
      <button
        onClick={handleStartCloud}
        disabled={!selectedRepo || isCreatingSandbox}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-sky-500 px-4 py-2.5 text-sm font-semibold text-white transition-all hover:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isCreatingSandbox ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("providerSelection.e2bCloud.creating", { defaultValue: "Creating sandbox..." })}
          </>
        ) : (
          <>
            <Play className="h-4 w-4" />
            {t("providerSelection.e2bCloud.start", { defaultValue: "Start Cloud Session" })}
          </>
        )}
      </button>

      <p className="text-center text-[11px] text-muted-foreground/60">
        {t("providerSelection.e2bCloud.hint", {
          defaultValue: "Agent runs in a remote E2B cloud sandbox with full git access",
        })}
      </p>
    </div>
  );
}

export default function ProviderSelectionEmptyState({
  selectedProject,
  selectedSession,
  currentSessionId,
  provider,
  setProvider,
  runtimeMode,
  setRuntimeMode,
  textareaRef,
  claudeModel,
  setClaudeModel,
  cursorModel,
  setCursorModel,
  codexModel,
  setCodexModel,
  geminiModel,
  setGeminiModel,
  tasksEnabled,
  isTaskMasterInstalled,
  onShowAllTasks,
  setInput,
}: ProviderSelectionEmptyStateProps) {
  const { t } = useTranslation("chat");
  const isCloudProject = isResolvedCloudProject(selectedProject);
  const nextTaskPrompt = t("tasks.nextTaskPrompt", {
    defaultValue: "Start the next task",
  });

  const selectProvider = (next: SessionProvider) => {
    setProvider(next);
    localStorage.setItem("selected-provider", next);
    setTimeout(() => textareaRef.current?.focus(), 100);
  };

  const handleModelChange = (value: string) => {
    if (provider === "claude") {
      setClaudeModel(value);
      localStorage.setItem("claude-model", value);
    } else if (provider === "codex") {
      setCodexModel(value);
      localStorage.setItem("codex-model", value);
    } else if (provider === "gemini") {
      setGeminiModel(value);
      localStorage.setItem("gemini-model", value);
    } else {
      setCursorModel(value);
      localStorage.setItem("cursor-model", value);
    }
  };

  const modelConfig = getModelConfig(provider);
  const currentModel = getModelValue(
    provider,
    claudeModel,
    cursorModel,
    codexModel,
    geminiModel,
  );
  const readyPrompt =
    provider === "cursor"
      ? t("providerSelection.readyPrompt.cursor", { model: cursorModel })
      : provider === "codex"
        ? t("providerSelection.readyPrompt.codex", { model: codexModel })
        : provider === "gemini"
          ? t("providerSelection.readyPrompt.gemini", { model: geminiModel })
          : t("providerSelection.readyPrompt.claude", { model: claudeModel });
  const repoUrl = typeof selectedProject?.cloud?.repoUrl === "string" ? selectedProject.cloud.repoUrl : "";
  const branch = typeof selectedProject?.cloud?.branch === "string" ? selectedProject.cloud.branch : "";
  const repoName = repoUrl ? repoUrl.replace(/\/+$/, "").replace(/\.git$/, "").split("/").pop() : "";
  const isRemoteHostProject = selectedProject?.runtime === "remote_host" || runtimeMode === "remote_host";
  const visibleProviders = isRemoteHostProject
    ? PROVIDERS.filter((candidate) => candidate.id === "claude" || candidate.id === "codex")
    : PROVIDERS;

  useEffect(() => {
    if (!isRemoteHostProject) {
      return;
    }

    if (provider === "claude" || provider === "codex") {
      return;
    }

    selectProvider("claude");
  }, [isRemoteHostProject, provider]);

  const providerCards = (
    <div className="mb-6 grid grid-cols-2 gap-2 sm:grid-cols-4 sm:gap-2.5">
      {visibleProviders.map((p) => {
        const active = provider === p.id;
        return (
          <button
            key={p.id}
            onClick={() => selectProvider(p.id)}
            data-testid="provider-selection-card"
            data-provider-id={p.id}
            className={`
              relative flex flex-col items-center gap-2.5 rounded-xl border-[1.5px] px-2
              pb-4 pt-5 transition-all duration-150
              active:scale-[0.97]
              ${
                active
                  ? `${p.accent} ${p.ring} bg-card shadow-sm ring-2`
                  : "border-border bg-card/60 hover:border-border/80 hover:bg-card"
              }
            `}
          >
            <SessionProviderLogo
              provider={p.id}
              className={`h-9 w-9 transition-transform duration-150 ${active ? "scale-110" : ""}`}
            />
            <div className="text-center">
              <p className="text-[13px] font-semibold leading-none text-foreground">
                {p.name}
              </p>
              <p className="mt-1 text-[10px] leading-tight text-muted-foreground">
                {t(p.infoKey)}
              </p>
            </div>
            {active && (
              <div
                className={`absolute -right-1 -top-1 h-[18px] w-[18px] rounded-full ${p.check} flex items-center justify-center shadow-sm`}
              >
                <Check className="h-2.5 w-2.5" strokeWidth={3} />
              </div>
            )}
          </button>
        );
      })}
    </div>
  );

  const modelPicker = (
    <div
      className={`transition-all duration-200 ${provider ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-1 opacity-0"}`}
    >
      <div className="mb-5 flex items-center justify-center gap-2">
        <span className="text-sm text-muted-foreground">
          {t("providerSelection.selectModel")}
        </span>
        <div className="relative">
          <select
            value={currentModel}
            onChange={(e) => handleModelChange(e.target.value)}
            tabIndex={-1}
            className="cursor-pointer appearance-none rounded-lg border border-border/60 bg-muted/50 py-1.5 pl-3 pr-7 text-sm font-medium text-foreground transition-colors hover:bg-muted focus:outline-none focus:ring-2 focus:ring-primary/20"
          >
            {modelConfig.OPTIONS.map(
              ({ value, label }: { value: string; label: string }) => (
                <option key={value + label} value={value}>
                  {label}
                </option>
              ),
            )}
          </select>
          <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
        </div>
      </div>

      <p className="text-center text-sm text-muted-foreground/70">{readyPrompt}</p>
    </div>
  );

  /* ── New session — provider picker ── */
  if (!selectedSession && !currentSessionId) {
    if (isCloudProject) {
      return (
        <div className="flex h-full items-center justify-center px-4">
          <div className="w-full max-w-2xl">
            <div className="mb-6 text-center">
              <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-sky-300/40 bg-sky-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-sky-700 dark:border-sky-500/20 dark:bg-sky-500/10 dark:text-sky-300">
                <Cloud className="h-3.5 w-3.5" />
                {t("providerSelection.e2bCloud.title", { defaultValue: "Cloud Project" })}
              </div>
              <h2 className="text-lg font-semibold tracking-tight text-foreground sm:text-xl">
                {t("providerSelection.e2bCloud.start", { defaultValue: "Start Cloud Session" })}
              </h2>
              <p className="mt-1 text-[13px] text-muted-foreground">
                {selectedProject?.displayName}
              </p>
              {(repoName || branch) && (
                <p className="mt-2 text-xs text-muted-foreground/80">
                  {[repoName, branch ? `branch: ${branch}` : ""].filter(Boolean).join(" • ")}
                </p>
              )}
            </div>

            {providerCards}
            {modelPicker}

            {provider && tasksEnabled && isTaskMasterInstalled && (
              <div className="mt-5">
                <NextTaskBanner
                  onStartTask={() => setInput(nextTaskPrompt)}
                  onShowAllTasks={onShowAllTasks}
                />
              </div>
            )}
          </div>
        </div>
      );
    }

    if (isRemoteHostProject) {
      return (
        <div className="flex h-full items-center justify-center px-4">
          <div
            data-testid="provider-selection-remote-host"
            className="w-full max-w-2xl rounded-2xl border border-border/60 bg-card/80 p-8 text-center shadow-sm"
          >
            <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-amber-300/50 bg-amber-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300">
              <Server className="h-3.5 w-3.5" />
              {t("providerSelection.remoteHost.title", { defaultValue: "Remote Host Project" })}
            </div>
            <h2 className="text-lg font-semibold tracking-tight text-foreground sm:text-xl">
              {selectedProject?.displayName || t("providerSelection.remoteHost.start", { defaultValue: "Remote Host Session" })}
            </h2>
            <p className="mt-2 text-[13px] text-muted-foreground">
              {t("providerSelection.remoteHost.description", {
                defaultValue: "Chat runs the remote host's own Claude or Codex CLI and resumes against the remote machine's native session files.",
              })}
            </p>
            {selectedProject?.fullPath && (
              <p className="mt-3 rounded-lg bg-muted/50 px-3 py-2 font-mono text-xs text-muted-foreground">
                {selectedProject.fullPath}
              </p>
            )}
            <div className="mt-6">
              {providerCards}
              {modelPicker}
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="flex h-full items-center justify-center px-4">
        <div className="w-full max-w-lg">
          {/* Top-level mode tabs: Local / E2B Cloud */}
          <div className="mb-6 flex items-center justify-center">
            <div className="inline-flex rounded-xl border border-border/60 bg-muted/30 p-1">
              <button
                onClick={() => {
                  setRuntimeMode("local");
                  localStorage.setItem("runtime-mode", "local");
                }}
                className={`flex items-center gap-2 rounded-lg px-5 py-2.5 text-sm font-semibold transition-all duration-150 ${
                  runtimeMode === "local"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <Monitor className="h-4 w-4" />
                {t("providerSelection.runtimeMode.local", { defaultValue: "Local" })}
              </button>
              <button
                onClick={() => {
                  setRuntimeMode("e2b");
                  localStorage.setItem("runtime-mode", "e2b");
                }}
                className={`flex items-center gap-2 rounded-lg px-5 py-2.5 text-sm font-semibold transition-all duration-150 ${
                  runtimeMode === "e2b"
                    ? "bg-sky-500/10 text-sky-600 shadow-sm ring-1 ring-sky-500/20 dark:text-sky-400"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <Cloud className="h-4 w-4" />
                {t("providerSelection.runtimeMode.e2b", { defaultValue: "E2B Cloud" })}
              </button>
            </div>
          </div>

          {/* ── LOCAL MODE ── */}
          {runtimeMode === "local" && (
            <>
              {/* Heading */}
              <div className="mb-8 text-center">
                <h2 className="text-lg font-semibold tracking-tight text-foreground sm:text-xl">
                  {t("providerSelection.title")}
                </h2>
                <p className="mt-1 text-[13px] text-muted-foreground">
                  {t("providerSelection.description")}
                </p>
              </div>

              {/* Provider cards */}
              {providerCards}

              {/* Model picker */}
              {modelPicker}

              {/* Task banner */}
              {provider && tasksEnabled && isTaskMasterInstalled && (
                <div className="mt-5">
                  <NextTaskBanner
                    onStartTask={() => setInput(nextTaskPrompt)}
                    onShowAllTasks={onShowAllTasks}
                  />
                </div>
              )}
            </>
          )}

          {/* ── E2B CLOUD MODE ── */}
          {runtimeMode === "e2b" && (
            <div className="mx-auto max-w-md">
              <div className="mb-5 text-center">
                <h2 className="text-lg font-semibold tracking-tight text-foreground sm:text-xl">
                  {t("providerSelection.e2bCloud.title", { defaultValue: "Cloud Session" })}
                </h2>
                <p className="mt-1 text-[13px] text-muted-foreground">
                  {t("providerSelection.e2bCloud.description", {
                    defaultValue: "Run your agent in a cloud sandbox with a GitHub repo",
                  })}
                </p>
              </div>
              <E2BCloudPanel
                provider={provider}
                setProvider={setProvider}
                setRuntimeMode={setRuntimeMode}
                textareaRef={textareaRef}
                claudeModel={claudeModel}
                setClaudeModel={setClaudeModel}
                cursorModel={cursorModel}
                setCursorModel={setCursorModel}
                codexModel={codexModel}
                setCodexModel={setCodexModel}
                geminiModel={geminiModel}
                setGeminiModel={setGeminiModel}
              />
            </div>
          )}
        </div>
      </div>
    );
  }

  /* ── Existing session — continue prompt ── */
  if (selectedSession) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="max-w-md px-6 text-center">
          <p className="mb-1.5 text-lg font-semibold text-foreground">
            {t("session.continue.title")}
          </p>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {t("session.continue.description")}
          </p>

          {tasksEnabled && isTaskMasterInstalled && (
            <div className="mt-5">
              <NextTaskBanner
                onStartTask={() => setInput(nextTaskPrompt)}
                onShowAllTasks={onShowAllTasks}
              />
            </div>
          )}
        </div>
      </div>
    );
  }

  return null;
}
