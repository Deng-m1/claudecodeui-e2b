import { resolveProjectRuntimeContext } from './context.js';
import { createE2BProjectRuntimeAdapter } from './e2b-adapter.js';
import { createLocalProjectRuntimeAdapter } from './local-adapter.js';
import { createRemoteProjectRuntimeAdapter } from './remote-adapter.js';

export { resolveProjectRuntimeContext } from './context.js';
export { getProjectCapabilities, normalizeProjectCapabilities } from './capabilities.js';

export async function getProjectRuntimeAdapter(projectName, options = {}) {
  const context = await resolveProjectRuntimeContext(projectName, options);

  if (context.runtime === 'e2b') {
    return createE2BProjectRuntimeAdapter(context);
  }

  if (context.runtime === 'remote_host') {
    return createRemoteProjectRuntimeAdapter(context);
  }

  return createLocalProjectRuntimeAdapter(context);
}
