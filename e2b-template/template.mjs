import { Template, waitForTimeout } from 'e2b';

const APT_PACKAGES = [
  'ca-certificates',
  'curl',
  'wget',
  'git',
  'git-lfs',
  'gh',
  'jq',
  'ripgrep',
  'fd-find',
  'less',
  'unzip',
  'zip',
  'rsync',
  'openssh-client',
  'procps',
  'python3',
  'python3-pip',
  'python3-venv',
  'make',
  'g++',
  'tmux',
];

const NATIVE_CLAUDE_PACKAGE = process.env.E2B_NATIVE_CLAUDE_PACKAGE || '@anthropic-ai/claude-code@latest';
const NATIVE_CODEX_PACKAGE = process.env.E2B_NATIVE_CODEX_PACKAGE || '@openai/codex@latest';

const GLOBAL_NPM_PACKAGES = [
  NATIVE_CLAUDE_PACKAGE,
  NATIVE_CODEX_PACKAGE,
  'playwright',
  '@playwright/test',
  'typescript',
  'tsx',
];

export const DEFAULT_TEMPLATE_NAME = process.env.E2B_TEMPLATE_NAME || 'claudecodeui-cloud-agent';

const SETUP_SCRIPT = `
set -euo pipefail
mkdir -p /ms-playwright /home/user/.cache /etc/profile.d
git lfs install --system
corepack enable
npm install -g ${GLOBAL_NPM_PACKAGES.join(' ')}
printf 'export PLAYWRIGHT_BROWSERS_PATH=/ms-playwright\\n' >/etc/profile.d/playwright.sh
chmod 0644 /etc/profile.d/playwright.sh
PLAYWRIGHT_BROWSERS_PATH=/ms-playwright playwright install --with-deps chromium
if command -v fdfind >/dev/null 2>&1; then
  ln -sf "$(command -v fdfind)" /usr/local/bin/fd
fi
ln -sfn /ms-playwright /home/user/.cache/ms-playwright
chown -h user:user /home/user/.cache/ms-playwright
chown -R user:user /ms-playwright /home/user/.cache
npm cache clean --force || true
`.trim();

export function createCloudAgentTemplate() {
  return Template()
    .fromNodeImage(process.env.E2B_NODE_IMAGE || '22')
    .setWorkdir('/home/user')
    .aptInstall(APT_PACKAGES, { noInstallRecommends: true })
    .runCmd(SETUP_SCRIPT, { user: 'root' })
    .setReadyCmd(waitForTimeout(1000));
}
