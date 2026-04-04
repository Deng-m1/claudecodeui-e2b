import process from 'node:process';
import { Template } from 'e2b';
import { createCloudAgentTemplate, DEFAULT_TEMPLATE_NAME } from './template.mjs';

const templateName = process.env.E2B_TEMPLATE_NAME || DEFAULT_TEMPLATE_NAME;
const explicitTags = (process.env.E2B_TEMPLATE_TAGS || 'latest')
  .split(',')
  .map((tag) => tag.trim())
  .filter(Boolean);

if (!process.env.E2B_API_KEY) {
  throw new Error('E2B_API_KEY is required to build and upload a template.');
}

const gitSha = process.env.GIT_COMMIT_SHA || process.env.VERCEL_GIT_COMMIT_SHA || 'manual';
const dateTag = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const tags = Array.from(new Set([...explicitTags, `build-${dateTag}`, gitSha.slice(0, 12)]));

console.log(`[E2B template] Building ${templateName} with tags: ${tags.join(', ')}`);

const buildInfo = await Template.build(createCloudAgentTemplate(), templateName, {
  tags,
  cpuCount: Number(process.env.E2B_TEMPLATE_BUILD_CPU || 2),
  memoryMB: Number(process.env.E2B_TEMPLATE_BUILD_MEMORY_MB || 4096),
  skipCache: process.env.E2B_TEMPLATE_SKIP_CACHE === '1',
  onBuildLogs: (entry) => {
    const level = entry.level || 'info';
    const message = entry.message || entry.content || '';
    console.log(`[${level}] ${message}`.trim());
  },
});

console.log('');
console.log('[E2B template] Upload complete');
console.log(JSON.stringify(buildInfo, null, 2));
console.log(`E2B_TEMPLATE=${templateName}:latest`);
