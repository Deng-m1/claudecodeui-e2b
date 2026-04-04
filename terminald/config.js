import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const sharedDatabasePath = process.env.DATABASE_PATH || path.join(repoRoot, 'server', 'database', 'auth.db');
const sharedDatabaseDir = path.dirname(sharedDatabasePath);

export const TERMINALD_HOST = process.env.TERMINALD_HOST || '0.0.0.0';
export const TERMINALD_PORT = Number.parseInt(process.env.TERMINALD_PORT || '3112', 10);
export const TERMINALD_DB_PATH = process.env.TERMINALD_DB_PATH || path.join(sharedDatabaseDir, 'terminald.sqlite');
export const TERMINALD_TMUX_BIN = process.env.TERMINALD_TMUX_BIN || 'tmux';
export const TERMINALD_LOCAL_SHELL = process.env.TERMINALD_LOCAL_SHELL || process.env.SHELL || '/bin/bash';
export const TERMINALD_E2B_SHELL = process.env.TERMINALD_E2B_SHELL || 'bash';

export function getRepoRoot() {
  return repoRoot;
}
