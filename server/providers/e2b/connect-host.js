function parseMetadataJson(value) {
  if (!value) {
    return null;
  }

  if (typeof value === 'object') {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function isLoopbackLikeHost(hostname) {
  if (!hostname || typeof hostname !== 'string') {
    return false;
  }

  const normalized = hostname.trim().toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1' || normalized === '[::1]';
}

export function normalizeHeaderHost(value) {
  if (Array.isArray(value)) {
    value = value[0];
  }

  if (typeof value !== 'string') {
    return '';
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  const firstHost = trimmed.split(',')[0]?.trim() || '';
  if (!firstHost) {
    return '';
  }

  if (firstHost.startsWith('[')) {
    const closingIndex = firstHost.indexOf(']');
    if (closingIndex !== -1) {
      return firstHost.slice(1, closingIndex);
    }
    return firstHost;
  }

  const colonCount = (firstHost.match(/:/g) || []).length;
  if (colonCount === 1 && firstHost.includes(':')) {
    return firstHost.split(':')[0];
  }

  return firstHost;
}

function normalizeOriginHost(value) {
  if (Array.isArray(value)) {
    value = value[0];
  }

  if (typeof value !== 'string') {
    return '';
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  try {
    return normalizeHeaderHost(new URL(trimmed).host);
  } catch {
    return normalizeHeaderHost(trimmed);
  }
}

function normalizeUrlOrHost(value) {
  const fromOrigin = normalizeOriginHost(value);
  if (fromOrigin) {
    return fromOrigin;
  }

  return normalizeHeaderHost(value);
}

export function resolveSandboxConnectHostFromRequest(req, sandboxRecord = null) {
  const metadata = parseMetadataJson(sandboxRecord?.metadata_json);
  const metadataHost =
    typeof metadata?.sandboxConnectHost === 'string' && metadata.sandboxConnectHost.trim()
      ? metadata.sandboxConnectHost.trim()
      : '';

  if (metadataHost) {
    return metadataHost;
  }

  const envCandidates = [
    process.env.E2B_SANDBOX_CONNECT_HOST,
    process.env.E2B_PUBLIC_HOST,
    process.env.PUBLIC_HOST,
    process.env.EXTERNAL_HOST,
    process.env.APP_URL,
    process.env.PUBLIC_URL,
    process.env.VITE_PUBLIC_URL,
    process.env.GITHUB_REDIRECT_URI,
  ];

  for (const candidate of envCandidates) {
    const normalized = normalizeUrlOrHost(candidate);
    if (normalized && !isLoopbackLikeHost(normalized)) {
      return normalized;
    }
  }

  const customHeader = normalizeHeaderHost(req?.headers?.['x-sandbox-connect-host']);
  if (customHeader && !isLoopbackLikeHost(customHeader)) {
    return customHeader;
  }

  const forwardedHost = normalizeHeaderHost(req?.headers?.['x-forwarded-host']);
  if (forwardedHost && !isLoopbackLikeHost(forwardedHost)) {
    return forwardedHost;
  }

  const originHost = normalizeOriginHost(req?.headers?.origin);
  if (originHost && !isLoopbackLikeHost(originHost)) {
    return originHost;
  }

  const refererHost = normalizeOriginHost(req?.headers?.referer);
  if (refererHost && !isLoopbackLikeHost(refererHost)) {
    return refererHost;
  }

  const hostHeader = normalizeHeaderHost(req?.headers?.host);
  if (hostHeader && !isLoopbackLikeHost(hostHeader)) {
    return hostHeader;
  }

  const requestHost = normalizeHeaderHost(req?.hostname);
  if (requestHost && !isLoopbackLikeHost(requestHost)) {
    return requestHost;
  }

  return '';
}
