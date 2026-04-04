import { isRecoverableAcpTransportError, summarizeRecoverableAcpTransportError } from './acp-transport-errors.js';

const INSTALL_KEY = Symbol.for('claudecodeui.processErrorGuards.cleanup');

function normalizeReason(reason) {
  if (reason instanceof Error) {
    return reason;
  }

  return new Error(String(reason || 'Unhandled promise rejection'));
}

function defaultFatalHandler(reason) {
  setImmediate(() => {
    throw normalizeReason(reason);
  });
}

export function createUnhandledRejectionGuard(options = {}) {
  const logger = options.logger || console;
  const onFatal = typeof options.onFatal === 'function' ? options.onFatal : defaultFatalHandler;

  return (reason) => {
    if (isRecoverableAcpTransportError(reason)) {
      logger.warn(
        '[WARN] Suppressed recoverable ACP transport rejection:',
        summarizeRecoverableAcpTransportError(reason),
      );
      return { suppressed: true, reason };
    }

    logger.error('[ERROR] Unhandled promise rejection:', reason);
    onFatal(reason);
    return { suppressed: false, reason };
  };
}

export function installProcessErrorGuards(options = {}) {
  if (typeof globalThis[INSTALL_KEY] === 'function') {
    return globalThis[INSTALL_KEY];
  }

  const handler = createUnhandledRejectionGuard(options);
  process.on('unhandledRejection', handler);

  const cleanup = () => {
    process.off('unhandledRejection', handler);
    if (globalThis[INSTALL_KEY] === cleanup) {
      delete globalThis[INSTALL_KEY];
    }
  };

  globalThis[INSTALL_KEY] = cleanup;
  return cleanup;
}
