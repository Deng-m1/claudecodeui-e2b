import process from 'node:process';
import { Sandbox } from '@e2b/code-interpreter';

const template = process.env.E2B_TEMPLATE || `${process.env.E2B_TEMPLATE_NAME || 'claudecodeui-cloud-agent'}:latest`;

if (!process.env.E2B_API_KEY) {
  throw new Error('E2B_API_KEY is required to create a smoke-test sandbox.');
}

console.log(`[E2B template] Smoke testing template ${template}`);

const sandbox = await Sandbox.betaCreate(template, {
  timeoutMs: 10 * 60 * 1000,
  autoPause: true,
  allowInternetAccess: true,
});

try {
  const command = [
    'set -euo pipefail',
    'node --version',
    'npm --version',
    'git --version',
    'gh --version | head -n 1',
    'python3 --version',
    'tmux -V',
    'claude --version',
    'codex --version',
    'bash -lc "source /etc/profile >/dev/null 2>&1 || true; echo ${PLAYWRIGHT_BROWSERS_PATH:-unset}; playwright --version"',
  ].join(' && ');

  const result = await sandbox.commands.run(`bash -lc '${command}'`, {
    timeoutMs: 5 * 60 * 1000,
  });

  if (result.exitCode !== 0) {
    throw new Error(result.stderr || 'Smoke test command failed.');
  }

  console.log(result.stdout.trim());
} finally {
  await sandbox.kill();
}
