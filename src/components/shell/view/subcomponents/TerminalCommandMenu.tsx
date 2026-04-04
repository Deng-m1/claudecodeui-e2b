import {
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ArrowDown,
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  Clipboard,
  Command,
  CornerDownLeft,
  Eraser,
  History,
  Keyboard,
  MoveHorizontal,
  MoveVertical,
  OctagonMinus,
  Search,
  SquareTerminal,
  type LucideIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Terminal } from '@xterm/xterm';

type TerminalCommandAction = {
  id: string;
  label: string;
  hint: string;
  description: string;
  icon: LucideIcon;
  action: 'input' | 'paste' | 'scroll';
  payload?: string;
};

type TerminalCommandGroup = {
  id: string;
  label: string;
  description: string;
  actions: TerminalCommandAction[];
};

type TerminalCommandMenuProps = {
  isConnected: boolean;
  terminalRef: MutableRefObject<Terminal | null>;
  onSendInput: (data: string) => void;
};

const INPUT_ACTIONS: TerminalCommandAction[] = [
  {
    id: 'interrupt',
    label: 'Interrupt',
    hint: 'Ctrl+C',
    description: 'Stop the running process',
    icon: OctagonMinus,
    action: 'input',
    payload: '\x03',
  },
  {
    id: 'background',
    label: 'Suspend',
    hint: 'Ctrl+Z',
    description: 'Push the current job to the background',
    icon: MoveVertical,
    action: 'input',
    payload: '\x1a',
  },
  {
    id: 'eof',
    label: 'Send EOF',
    hint: 'Ctrl+D',
    description: 'Close prompts waiting for more input',
    icon: CornerDownLeft,
    action: 'input',
    payload: '\x04',
  },
  {
    id: 'history-search',
    label: 'History Search',
    hint: 'Ctrl+R',
    description: 'Search previous terminal commands',
    icon: Search,
    action: 'input',
    payload: '\x12',
  },
  {
    id: 'clear-screen',
    label: 'Clear Screen',
    hint: 'Ctrl+L',
    description: 'Refresh the visible terminal area',
    icon: Eraser,
    action: 'input',
    payload: '\x0c',
  },
  {
    id: 'escape',
    label: 'Escape',
    hint: 'Esc',
    description: 'Cancel the current terminal prompt state',
    icon: SquareTerminal,
    action: 'input',
    payload: '\x1b',
  },
  {
    id: 'tab-complete',
    label: 'Tab Complete',
    hint: 'Tab',
    description: 'Trigger shell completion or next candidate',
    icon: Command,
    action: 'input',
    payload: '\t',
  },
  {
    id: 'history-up',
    label: 'Previous Command',
    hint: 'Up',
    description: 'Recall the previous command from history',
    icon: History,
    action: 'input',
    payload: '\x1b[A',
  },
  {
    id: 'history-down',
    label: 'Next Command',
    hint: 'Down',
    description: 'Move to the next command in history',
    icon: ArrowDown,
    action: 'input',
    payload: '\x1b[B',
  },
  {
    id: 'move-left',
    label: 'Cursor Left',
    hint: 'Left',
    description: 'Move the shell cursor one character left',
    icon: ArrowLeft,
    action: 'input',
    payload: '\x1b[D',
  },
  {
    id: 'move-right',
    label: 'Cursor Right',
    hint: 'Right',
    description: 'Move the shell cursor one character right',
    icon: ArrowRight,
    action: 'input',
    payload: '\x1b[C',
  },
  {
    id: 'line-start',
    label: 'Line Start',
    hint: 'Ctrl+A',
    description: 'Jump to the start of the current command line',
    icon: MoveHorizontal,
    action: 'input',
    payload: '\x01',
  },
  {
    id: 'line-end',
    label: 'Line End',
    hint: 'Ctrl+E',
    description: 'Jump to the end of the current command line',
    icon: MoveHorizontal,
    action: 'input',
    payload: '\x05',
  },
  {
    id: 'paste',
    label: 'Paste Clipboard',
    hint: 'Paste',
    description: 'Send clipboard text directly into the terminal',
    icon: Clipboard,
    action: 'paste',
  },
  {
    id: 'scroll-bottom',
    label: 'Scroll Bottom',
    hint: 'End',
    description: 'Jump to the latest terminal output',
    icon: ArrowDownToLine,
    action: 'scroll',
  },
];

const GROUP_ACTION_IDS = {
  process: ['interrupt', 'background', 'eof', 'history-search'],
  editing: ['clear-screen', 'escape', 'tab-complete', 'paste'],
  cursor: ['line-start', 'line-end', 'move-left', 'move-right'],
  history: ['history-up', 'history-down', 'scroll-bottom'],
} as const;

const preventFocusSteal = (event: ReactPointerEvent | ReactMouseEvent) => event.preventDefault();

export default function TerminalCommandMenu({
  isConnected,
  terminalRef,
  onSendInput,
}: TerminalCommandMenuProps) {
  const { t } = useTranslation('settings');
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const commandMap = useMemo(
    () => new Map(INPUT_ACTIONS.map((action) => [action.id, action])),
    [],
  );

  const groups = useMemo<TerminalCommandGroup[]>(() => {
    const buildGroup = (id: keyof typeof GROUP_ACTION_IDS, label: string, description: string) => ({
      id,
      label,
      description,
      actions: GROUP_ACTION_IDS[id]
        .map((actionId) => commandMap.get(actionId))
        .filter((action): action is TerminalCommandAction => Boolean(action)),
    });

    return [
      buildGroup(
        'process',
        t('terminalShortcuts.commandMenu.groups.process', { defaultValue: 'Process' }),
        t('terminalShortcuts.commandMenu.groups.processDescription', { defaultValue: 'Interrupt, suspend, or search command history.' }),
      ),
      buildGroup(
        'editing',
        t('terminalShortcuts.commandMenu.groups.editing', { defaultValue: 'Editing' }),
        t('terminalShortcuts.commandMenu.groups.editingDescription', { defaultValue: 'Clear, cancel, complete, or paste input.' }),
      ),
      buildGroup(
        'cursor',
        t('terminalShortcuts.commandMenu.groups.cursor', { defaultValue: 'Cursor' }),
        t('terminalShortcuts.commandMenu.groups.cursorDescription', { defaultValue: 'Move within the current command without leaving the keyboard.' }),
      ),
      buildGroup(
        'history',
        t('terminalShortcuts.commandMenu.groups.history', { defaultValue: 'History' }),
        t('terminalShortcuts.commandMenu.groups.historyDescription', { defaultValue: 'Navigate recent commands and jump to the newest output.' }),
      ),
    ];
  }, [commandMap, t]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current || !(event.target instanceof Node)) {
        return;
      }

      if (!rootRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  const focusTerminal = useCallback(() => {
    terminalRef.current?.focus();
  }, [terminalRef]);

  const executeAction = useCallback(
    async (action: TerminalCommandAction) => {
      if (!isConnected) {
        return;
      }

      if (action.action === 'input' && action.payload) {
        onSendInput(action.payload);
      }

      if (action.action === 'paste') {
        try {
          const text = await navigator.clipboard?.readText?.();
          if (text) {
            onSendInput(text);
          }
        } catch {
          // Ignore clipboard permission failures.
        }
      }

      if (action.action === 'scroll') {
        terminalRef.current?.scrollToBottom();
      }

      setIsOpen(false);
      window.setTimeout(focusTerminal, 0);
    },
    [focusTerminal, isConnected, onSendInput, terminalRef],
  );

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        data-testid="terminal-command-menu-trigger"
        onPointerDown={preventFocusSteal}
        onClick={() => setIsOpen((open) => !open)}
        className="inline-flex items-center gap-1.5 rounded border border-gray-600 bg-gray-700 px-2.5 py-1.5 text-xs font-medium text-gray-100 transition-colors hover:bg-gray-600"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        title={t('terminalShortcuts.commandMenu.triggerTitle', { defaultValue: 'Open terminal command menu' })}
      >
        <Keyboard className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">{t('terminalShortcuts.commandMenu.trigger', { defaultValue: 'Commands' })}</span>
        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <div
          data-testid="terminal-command-menu"
          className="bg-gray-900/98 absolute right-0 top-full z-30 mt-2 w-[min(92vw,32rem)] overflow-hidden rounded-xl border border-gray-700 shadow-2xl backdrop-blur"
          onPointerDown={preventFocusSteal}
        >
          <div className="border-b border-gray-800 px-4 py-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-gray-100">
              <Keyboard className="h-4 w-4 text-blue-300" />
              <span>{t('terminalShortcuts.commandMenu.title', { defaultValue: 'Terminal Commands' })}</span>
            </div>
            <p className="mt-1 text-xs text-gray-400">
              {t('terminalShortcuts.commandMenu.description', { defaultValue: 'One-click shortcuts for control signals, cursor movement, and shell history.' })}
            </p>
          </div>

          <div className="max-h-[70vh] space-y-4 overflow-y-auto px-4 py-4">
            {groups.map((group) => (
              <section key={group.id}>
                <div className="mb-2 flex items-center justify-between gap-3">
                  <div>
                    <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-gray-400">{group.label}</h3>
                    <p className="mt-1 text-xs text-gray-500">{group.description}</p>
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {group.actions.map((action) => (
                    <button
                      type="button"
                      key={action.id}
                      onPointerDown={preventFocusSteal}
                      onClick={() => {
                        void executeAction(action);
                      }}
                      disabled={!isConnected}
                      className="group flex min-h-[72px] items-start gap-3 rounded-xl border border-gray-800 bg-gray-950/70 px-3 py-3 text-left transition-colors hover:border-blue-500/60 hover:bg-gray-950 disabled:cursor-not-allowed disabled:opacity-45"
                    >
                      <span className="mt-0.5 rounded-lg border border-gray-700 bg-gray-800 p-2 text-gray-200 transition-colors group-hover:border-blue-500/60 group-hover:text-blue-200">
                        <action.icon className="h-4 w-4" />
                      </span>

                      <span className="min-w-0 flex-1">
                        <span className="flex items-center justify-between gap-2">
                          <span className="truncate text-sm font-medium text-gray-100">{action.label}</span>
                          <span className="shrink-0 rounded-full border border-gray-700 px-2 py-0.5 font-mono text-[11px] text-gray-300">
                            {action.hint}
                          </span>
                        </span>
                        <span className="mt-1 block text-xs leading-5 text-gray-400">{action.description}</span>
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
