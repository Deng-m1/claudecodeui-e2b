function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function stringifyFallback(value) {
  const text = normalizeText(String(value ?? ''));
  return text === '[object Object]' ? '' : text;
}

export function stringifyE2BError(value, fallback = '') {
  const seen = new Set();

  function visit(current) {
    const directText = normalizeText(current);
    if (directText) {
      return directText;
    }

    if (current === null || current === undefined) {
      return '';
    }

    if (typeof current === 'number' || typeof current === 'boolean' || typeof current === 'bigint') {
      return String(current);
    }

    if (current instanceof Error) {
      const errorMessage = visit(current.message);
      if (errorMessage) {
        return errorMessage;
      }

      const stackText = normalizeText(current.stack);
      if (stackText) {
        return stackText;
      }
    }

    if (typeof current !== 'object') {
      return stringifyFallback(current);
    }

    if (seen.has(current)) {
      return '';
    }

    seen.add(current);

    if (Array.isArray(current)) {
      const parts = current
        .map((entry) => visit(entry))
        .filter(Boolean);
      if (parts.length > 0) {
        return parts.join('\n');
      }
    }

    for (const key of ['message', 'error_description', 'errorDescription', 'error', 'detail', 'details', 'title', 'reason']) {
      if (!(key in current)) {
        continue;
      }

      const nested = visit(current[key]);
      if (nested) {
        return nested;
      }
    }

    try {
      const json = JSON.stringify(current);
      const normalizedJson = normalizeText(json);
      if (normalizedJson && normalizedJson !== '{}' && normalizedJson !== '[]') {
        return normalizedJson;
      }
    } catch {
      // Ignore circular JSON/stringify failures and keep falling back.
    }

    return stringifyFallback(current);
  }

  return visit(value) || fallback;
}
