import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claudecodeui-runtime-test-'));

const {
  createLocalProjectRuntimeAdapter,
} = await import('../../server/services/project-runtime/local-adapter.js');
const {
  getProjectCapabilities,
} = await import('../../server/services/project-runtime/capabilities.js');

after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('project runtime capability presets distinguish local and e2b shell support', () => {
  assert.deepEqual(getProjectCapabilities('local'), { files: true, git: true, shell: true });
  assert.deepEqual(getProjectCapabilities('e2b'), { files: true, git: true, shell: true });
});

test('local project runtime adapter performs file operations within the project root', async () => {
  const projectRoot = path.join(tempRoot, 'workspace');
  fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'src', 'index.ts'), 'console.log(\"hello\");\n', 'utf8');

  const adapter = createLocalProjectRuntimeAdapter({
    runtime: 'local',
    projectName: 'workspace',
    projectRoot,
    userId: null,
    sandboxId: null,
    capabilities: getProjectCapabilities('local'),
  });

  const tree = await adapter.files.getTree();
  assert.ok(tree.some((entry) => entry.name === 'src' && entry.type === 'directory'));

  const readResult = await adapter.files.readText('src/index.ts');
  assert.match(readResult.content, /hello/);

  const created = await adapter.files.createEntry('src', 'file', 'new.ts');
  assert.equal(path.basename(created.path), 'new.ts');

  const renamed = await adapter.files.renameEntry('src/new.ts', 'renamed.ts');
  assert.equal(path.basename(renamed.to), 'renamed.ts');

  const deleted = await adapter.files.deleteEntry('src/renamed.ts');
  assert.equal(deleted.entryType, 'file');
  assert.equal(fs.existsSync(path.join(projectRoot, 'src', 'renamed.ts')), false);
});
