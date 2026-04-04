export type MergeableMessageKind =
  | 'text'
  | 'tool_use'
  | 'tool_result'
  | 'thinking'
  | 'stream_delta'
  | 'stream_end'
  | 'error'
  | 'complete'
  | 'status'
  | 'permission_request'
  | 'permission_cancelled'
  | 'session_created'
  | 'interactive_prompt'
  | 'task_notification';

export interface MergeableMessage {
  id: string;
  sessionId?: string;
  timestamp: string;
  provider?: string;
  kind: MergeableMessageKind;
  role?: 'user' | 'assistant';
  content?: string;
  toolName?: string;
  toolInput?: unknown;
  toolId?: string;
  toolResult?: { content: string; isError: boolean; toolUseResult?: unknown } | null;
  isError?: boolean;
  status?: string;
  summary?: string;
  seq?: number;
}

const RETAINABLE_REALTIME_KINDS = new Set<MergeableMessageKind>([
  'text',
  'stream_delta',
  'tool_use',
  'tool_result',
  'thinking',
  'error',
  'interactive_prompt',
  'task_notification',
]);

const RECONCILE_TIMESTAMP_WINDOW_MS = 2 * 60 * 1000;
const EMPTY: MergeableMessage[] = [];

function normalizeComparableText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function parseComparableTimestamp(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function timestampsAreComparable(
  left: string | undefined,
  right: string | undefined,
): boolean {
  const leftTime = parseComparableTimestamp(left);
  const rightTime = parseComparableTimestamp(right);

  if (leftTime === null || rightTime === null) {
    return false;
  }

  return Math.abs(leftTime - rightTime) <= RECONCILE_TIMESTAMP_WINDOW_MS;
}

function getComparableSequence(value: number | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }

  return value;
}

function compareMessagesForDisplayOrder(
  left: MergeableMessage,
  right: MergeableMessage,
): number {
  const leftSeq = getComparableSequence(left.seq);
  const rightSeq = getComparableSequence(right.seq);

  if (leftSeq !== null && rightSeq !== null && leftSeq !== rightSeq) {
    return leftSeq - rightSeq;
  }

  const leftTimestamp = parseComparableTimestamp(left.timestamp);
  const rightTimestamp = parseComparableTimestamp(right.timestamp);

  if (leftTimestamp !== null && rightTimestamp !== null && leftTimestamp !== rightTimestamp) {
    return leftTimestamp - rightTimestamp;
  }

  return 0;
}

function getComparableMessageSignature(message: MergeableMessage): string | null {
  switch (message.kind) {
    case 'stream_delta':
      return JSON.stringify({
        kind: 'text',
        role: 'assistant',
        content: normalizeComparableText(message.content),
      });

    case 'text':
      return JSON.stringify({
        kind: 'text',
        role: message.role || 'assistant',
        content: normalizeComparableText(message.content),
      });

    case 'thinking':
    case 'error':
    case 'interactive_prompt':
      return JSON.stringify({
        kind: message.kind,
        content: normalizeComparableText(message.content),
      });

    case 'tool_use':
      return JSON.stringify({
        kind: 'tool_use',
        toolId: message.toolId || '',
        toolName: message.toolName || '',
        toolInput: JSON.stringify(message.toolInput ?? null),
      });

    case 'tool_result':
      return JSON.stringify({
        kind: 'tool_result',
        toolId: message.toolId || '',
        content: normalizeComparableText(message.toolResult?.content || message.content),
        isError: Boolean(message.toolResult?.isError || message.isError),
      });

    case 'task_notification':
      return JSON.stringify({
        kind: 'task_notification',
        status: message.status || '',
        summary: normalizeComparableText(message.summary),
      });

    default:
      return null;
  }
}

function collectServerToolState(serverMessages: MergeableMessage[]) {
  const toolUseIds = new Set<string>();
  const toolResultIds = new Set<string>();

  for (const message of serverMessages) {
    if (!message.toolId) {
      continue;
    }

    if (message.kind === 'tool_use') {
      toolUseIds.add(message.toolId);

      if (message.toolResult) {
        toolResultIds.add(message.toolId);
      }

      continue;
    }

    if (message.kind === 'tool_result') {
      toolResultIds.add(message.toolId);
    }
  }

  return { toolUseIds, toolResultIds };
}

function isRealtimeMessageRepresentedByServer(
  realtimeMessage: MergeableMessage,
  serverIds: ReadonlySet<string>,
  serverToolUseIds: ReadonlySet<string>,
  serverToolResultIds: ReadonlySet<string>,
): boolean {
  if (serverIds.has(realtimeMessage.id)) {
    return true;
  }

  if (!realtimeMessage.toolId) {
    return false;
  }

  if (realtimeMessage.kind === 'tool_use') {
    return serverToolUseIds.has(realtimeMessage.toolId);
  }

  if (realtimeMessage.kind === 'tool_result') {
    return serverToolResultIds.has(realtimeMessage.toolId);
  }

  return false;
}

function reconcileRealtimeMessages<T extends MergeableMessage>(
  serverMessages: T[],
  realtimeMessages: T[],
): T[] {
  if (realtimeMessages.length === 0) {
    return EMPTY as T[];
  }

  const serverIds = new Set(serverMessages.map((message) => message.id));
  const { toolUseIds: serverToolUseIds, toolResultIds: serverToolResultIds } = collectServerToolState(serverMessages);
  const usedServerIndexes = new Set<number>();
  const remainingMessages = realtimeMessages.filter((realtimeMessage) => {
    if (isRealtimeMessageRepresentedByServer(
      realtimeMessage,
      serverIds,
      serverToolUseIds,
      serverToolResultIds,
    )) {
      return false;
    }

    const realtimeSignature = getComparableMessageSignature(realtimeMessage);
    if (realtimeSignature) {
      for (let index = serverMessages.length - 1; index >= 0; index -= 1) {
        if (usedServerIndexes.has(index)) {
          continue;
        }

        const serverMessage = serverMessages[index];
        if (getComparableMessageSignature(serverMessage) !== realtimeSignature) {
          continue;
        }

        if (!timestampsAreComparable(realtimeMessage.timestamp, serverMessage.timestamp)) {
          continue;
        }

        usedServerIndexes.add(index);
        return false;
      }
    }

    return RETAINABLE_REALTIME_KINDS.has(realtimeMessage.kind);
  });

  return remainingMessages.length > 0 ? remainingMessages : (EMPTY as T[]);
}

function computeMerged<T extends MergeableMessage>(server: T[], realtime: T[]): T[] {
  if (realtime.length === 0) return server;
  if (server.length === 0) return realtime;

  const serverIds = new Set(server.map((message) => message.id));
  const { toolUseIds: serverToolUseIds, toolResultIds: serverToolResultIds } = collectServerToolState(server);
  const extra = realtime.filter((message) => !isRealtimeMessageRepresentedByServer(
    message,
    serverIds,
    serverToolUseIds,
    serverToolResultIds,
  ));

  if (extra.length === 0) {
    return server;
  }

  return [...server, ...extra]
    .map((message, index) => ({ message, index }))
    .sort((left, right) => {
      const order = compareMessagesForDisplayOrder(left.message, right.message);
      if (order !== 0) {
        return order;
      }

      return left.index - right.index;
    })
    .map(({ message }) => message);
}

export const sessionMessageMergeInternals = {
  compareMessagesForDisplayOrder,
  collectServerToolState,
  computeMerged,
  getComparableMessageSignature,
  isRealtimeMessageRepresentedByServer,
  reconcileRealtimeMessages,
};

export { computeMerged, getComparableMessageSignature, reconcileRealtimeMessages };
