import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  getAcpTransportErrorDetails,
  isRecoverableAcpTransportError,
} from '../../server/lib/acp-transport-errors.js';
import { createUnhandledRejectionGuard } from '../../server/lib/process-error-guards.js';

test('isRecoverableAcpTransportError matches ACP headers timeouts', () => {
  const cause = Object.assign(new Error('Headers Timeout Error'), {
    code: 'UND_ERR_HEADERS_TIMEOUT',
  });
  const error = new TypeError('fetch failed');
  error.cause = cause;
  error.stack = [
    'TypeError: fetch failed',
    '    at async StreamableHttpAcpTransport.postMessage (acp-http-client/dist/index.js:246:24)',
  ].join('\n');

  assert.equal(isRecoverableAcpTransportError(error), true);
  assert.match(getAcpTransportErrorDetails(error), /UND_ERR_HEADERS_TIMEOUT/);
});

test('isRecoverableAcpTransportError matches sandbox-not-found ACP failures', () => {
  const error = Object.assign(new Error('Request failed with status 502'), {
    name: 'AcpHttpError',
    status: 502,
    problem: {
      message: 'The sandbox was not found',
    },
  });

  assert.equal(isRecoverableAcpTransportError(error), true);
});

test('createUnhandledRejectionGuard suppresses recoverable ACP failures', () => {
  const calls = [];
  const guard = createUnhandledRejectionGuard({
    logger: {
      warn: (...args) => calls.push(['warn', args]),
      error: (...args) => calls.push(['error', args]),
    },
    onFatal: (reason) => calls.push(['fatal', reason]),
  });

  const reason = Object.assign(new Error('Request failed with status 502'), {
    name: 'AcpHttpError',
    status: 502,
    problem: {
      message: 'The sandbox was not found',
    },
  });

  const result = guard(reason);

  assert.equal(result.suppressed, true);
  assert.equal(calls.some(([type]) => type === 'fatal'), false);
  assert.equal(calls.some(([type]) => type === 'warn'), true);
});

test('createUnhandledRejectionGuard escalates unknown rejections', () => {
  const calls = [];
  const guard = createUnhandledRejectionGuard({
    logger: {
      warn: (...args) => calls.push(['warn', args]),
      error: (...args) => calls.push(['error', args]),
    },
    onFatal: (reason) => calls.push(['fatal', reason]),
  });

  const reason = new Error('totally different failure');
  const result = guard(reason);

  assert.equal(result.suppressed, false);
  assert.equal(calls.some(([type]) => type === 'warn'), false);
  assert.equal(calls.some(([type]) => type === 'error'), true);
  assert.equal(calls.some(([type, value]) => type === 'fatal' && value === reason), true);
});
