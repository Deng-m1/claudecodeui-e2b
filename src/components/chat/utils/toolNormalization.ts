import { safeJsonParse } from '../../../lib/utils.js';

type NormalizedToolDisplayCall = {
  toolName: string;
  toolInput: unknown;
};

function normalizeToolName(toolName?: string): string {
  return typeof toolName === 'string' ? toolName.trim() : '';
}

function extractCommand(toolInput: unknown): string {
  if (!toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) {
    return typeof toolInput === 'string' ? toolInput.trim() : '';
  }

  const candidate = toolInput as Record<string, unknown>;
  const command =
    typeof candidate.command === 'string' && candidate.command.trim()
      ? candidate.command.trim()
      : typeof candidate.cmd === 'string' && candidate.cmd.trim()
        ? candidate.cmd.trim()
        : typeof candidate.commandLine === 'string' && candidate.commandLine.trim()
          ? candidate.commandLine.trim()
          : '';

  return command;
}

export function isExecCommandToolName(toolName?: string): boolean {
  const normalized = normalizeToolName(toolName).toLowerCase();
  return (
    normalized === 'shell_command' ||
    normalized === 'exec_command' ||
    normalized.endsWith('.exec_command')
  );
}

export function normalizeToolDisplayCall(
  toolName?: string,
  toolInput?: unknown,
): NormalizedToolDisplayCall {
  const normalizedName = normalizeToolName(toolName);

  if (!isExecCommandToolName(normalizedName)) {
    return {
      toolName: normalizedName || 'UnknownTool',
      toolInput,
    };
  }

  const parsedInput =
    typeof toolInput === 'string'
      ? safeJsonParse(toolInput) ?? toolInput
      : toolInput;

  if (parsedInput && typeof parsedInput === 'object' && !Array.isArray(parsedInput)) {
    return {
      toolName: 'Bash',
      toolInput: {
        ...(parsedInput as Record<string, unknown>),
        command: extractCommand(parsedInput),
      },
    };
  }

  return {
    toolName: 'Bash',
    toolInput: {
      command: extractCommand(parsedInput),
    },
  };
}
