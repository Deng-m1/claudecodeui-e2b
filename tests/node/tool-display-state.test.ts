import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildToolDisplayResetKey,
  resolveCollapsibleDefaultOpen,
} from '../../src/components/chat/tools/toolDisplayState.ts';

test('resolveCollapsibleDefaultOpen keeps tool sections closed when auto expand is disabled', () => {
  assert.equal(resolveCollapsibleDefaultOpen(false), false);
  assert.equal(resolveCollapsibleDefaultOpen(undefined), false);
});

test('resolveCollapsibleDefaultOpen opens tool sections when auto expand is enabled', () => {
  assert.equal(resolveCollapsibleDefaultOpen(true), true);
});

test('buildToolDisplayResetKey changes when preference-relevant inputs change', () => {
  const base = buildToolDisplayResetKey({
    toolName: 'Write',
    toolId: 'tool-1',
    mode: 'input',
    defaultOpen: false,
    showRawParameters: false,
    rawContent: '{"file":"README.md"}',
  });

  const opened = buildToolDisplayResetKey({
    toolName: 'Write',
    toolId: 'tool-1',
    mode: 'input',
    defaultOpen: true,
    showRawParameters: false,
    rawContent: '{"file":"README.md"}',
  });

  const rawVisible = buildToolDisplayResetKey({
    toolName: 'Write',
    toolId: 'tool-1',
    mode: 'input',
    defaultOpen: false,
    showRawParameters: true,
    rawContent: '{"file":"README.md"}',
  });

  assert.notEqual(base, opened);
  assert.notEqual(base, rawVisible);
});
