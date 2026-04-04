import { safeJsonParse } from '../../../lib/utils.js';
import type { ChatMessage, ClaudePermissionSuggestion, PermissionGrantResult } from '../types/types.js';
import { CLAUDE_SETTINGS_KEY, getClaudeSettings, safeLocalStorage } from './chatStorage';
import { normalizeToolDisplayCall } from './toolNormalization';

export function buildClaudeToolPermissionEntry(toolName?: string, toolInput?: unknown) {
  const normalizedTool = normalizeToolDisplayCall(toolName, toolInput);
  if (!normalizedTool.toolName) return null;
  if (normalizedTool.toolName !== 'Bash') return normalizedTool.toolName;

  const parsed =
    typeof normalizedTool.toolInput === 'string'
      ? safeJsonParse(normalizedTool.toolInput)
      : normalizedTool.toolInput;
  const command = typeof parsed?.command === 'string' ? parsed.command.trim() : '';
  if (!command) return normalizedTool.toolName;

  const tokens = command.split(/\s+/);
  if (tokens.length === 0) return normalizedTool.toolName;

  if (tokens[0] === 'git' && tokens[1]) {
    return `Bash(${tokens[0]} ${tokens[1]}:*)`;
  }
  return `Bash(${tokens[0]}:*)`;
}

export function formatToolInputForDisplay(input: unknown) {
  if (input === undefined || input === null) return '';
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

export function getClaudePermissionSuggestion(
  message: ChatMessage | null | undefined,
  provider: string,
): ClaudePermissionSuggestion | null {
  if (provider !== 'claude') return null;
  if (!message?.toolResult?.isError) return null;

  const normalizedTool = normalizeToolDisplayCall(message?.toolName, message?.toolInput);
  const entry = buildClaudeToolPermissionEntry(normalizedTool.toolName, normalizedTool.toolInput);
  if (!entry) return null;

  const settings = getClaudeSettings();
  const isAllowed = settings.allowedTools.includes(entry);
  return { toolName: normalizedTool.toolName || 'UnknownTool', entry, isAllowed };
}

export function grantClaudeToolPermission(entry: string | null): PermissionGrantResult {
  if (!entry) return { success: false };

  const settings = getClaudeSettings();
  const alreadyAllowed = settings.allowedTools.includes(entry);
  const nextAllowed = alreadyAllowed ? settings.allowedTools : [...settings.allowedTools, entry];
  const nextDisallowed = settings.disallowedTools.filter((tool) => tool !== entry);
  const updatedSettings = {
    ...settings,
    allowedTools: nextAllowed,
    disallowedTools: nextDisallowed,
    lastUpdated: new Date().toISOString(),
  };

  safeLocalStorage.setItem(CLAUDE_SETTINGS_KEY, JSON.stringify(updatedSettings));
  return { success: true, alreadyAllowed, updatedSettings };
}
