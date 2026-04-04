import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  getPluginPort,
  isBuiltinPluginServer,
  isPluginRunning,
  startPluginServer,
  stopPluginServer,
} from '../../server/utils/plugin-process-manager.js';

test('web-terminal uses built-in host transport instead of spawning a plugin server', async () => {
  assert.equal(isBuiltinPluginServer('web-terminal'), true);
  assert.equal(isPluginRunning('web-terminal'), false);
  assert.equal(getPluginPort('web-terminal'), null);

  const result = await startPluginServer('web-terminal', '/tmp/unused', 'dist/server.js');
  assert.equal(result, null);
  assert.equal(isPluginRunning('web-terminal'), false);
  assert.equal(getPluginPort('web-terminal'), null);

  await stopPluginServer('web-terminal');
  assert.equal(isPluginRunning('web-terminal'), false);
});
