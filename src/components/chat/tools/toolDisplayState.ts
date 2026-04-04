type ToolDisplayResetKeyArgs = {
  toolName: string;
  toolId?: string;
  mode: 'input' | 'result';
  defaultOpen: boolean;
  showRawParameters: boolean;
  rawContent?: string;
};

export function resolveCollapsibleDefaultOpen(autoExpandTools?: boolean): boolean {
  // Global UI preference is authoritative: disabling auto-expand must keep all
  // collapsible tool sections closed across refreshes and session switches.
  return Boolean(autoExpandTools);
}

export function buildToolDisplayResetKey({
  toolName,
  toolId,
  mode,
  defaultOpen,
  showRawParameters,
  rawContent,
}: ToolDisplayResetKeyArgs): string {
  return [
    toolName,
    toolId || '',
    mode,
    defaultOpen ? 'open' : 'closed',
    showRawParameters ? 'raw-on' : 'raw-off',
    rawContent ? `raw-len:${rawContent.length}` : 'raw-len:0',
  ].join('|');
}
