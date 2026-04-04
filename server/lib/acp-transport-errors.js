function appendText(parts, value) {
  if (typeof value === 'string' && value.trim()) {
    parts.push(value.trim());
  }
}

function collectErrorDetails(error, parts, seen, depth) {
  if (!error || depth > 4) {
    return;
  }

  if (typeof error === 'object' && seen.has(error)) {
    return;
  }

  if (typeof error === 'object') {
    seen.add(error);
  }

  if (error instanceof Error) {
    appendText(parts, error.name);
    appendText(parts, error.message);
    appendText(parts, error.stack);
  } else if (typeof error !== 'object') {
    appendText(parts, String(error));
    return;
  }

  if (typeof error?.code === 'string') {
    parts.push(error.code);
  }

  if (typeof error?.status === 'number') {
    parts.push(`status:${error.status}`);
  }

  if (typeof error?.problem?.message === 'string') {
    appendText(parts, error.problem.message);
  }

  if (typeof error?.response?.status === 'number') {
    parts.push(`response_status:${error.response.status}`);
  }

  if (typeof error?.data?.message === 'string') {
    appendText(parts, error.data.message);
  }

  if (typeof error?.data?.agentStderr === 'string') {
    appendText(parts, error.data.agentStderr);
  }

  if (error?.cause) {
    collectErrorDetails(error.cause, parts, seen, depth + 1);
  }
}

export function getAcpTransportErrorDetails(error) {
  const parts = [];
  collectErrorDetails(error, parts, new Set(), 0);
  return parts.join('\n');
}

export function isRecoverableAcpTransportError(error) {
  const details = getAcpTransportErrorDetails(error).toLowerCase();
  if (!details) {
    return false;
  }

  if (details.includes('streamablehttpacptransport') && details.includes('fetch failed')) {
    return true;
  }

  if (details.includes('headers timeout error') || details.includes('und_err_headers_timeout')) {
    return true;
  }

  if (
    details.includes('request failed with status 502') &&
    (details.includes('sandbox was not found') || details.includes('sandbox not found'))
  ) {
    return true;
  }

  if (
    (details.includes('sandbox was not found') || details.includes('sandbox not found')) &&
    (details.includes('acphttperror') || details.includes('status:502') || details.includes('response_status:502'))
  ) {
    return true;
  }

  return false;
}

export function summarizeRecoverableAcpTransportError(error) {
  const details = getAcpTransportErrorDetails(error).toLowerCase();

  if (details.includes('headers timeout error') || details.includes('und_err_headers_timeout')) {
    return 'ACP transport timed out before the sandbox acknowledged the request.';
  }

  if (details.includes('sandbox was not found') || details.includes('sandbox not found')) {
    return 'ACP transport lost its sandbox connection because the target sandbox no longer exists.';
  }

  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }

  return 'ACP transport failure';
}
