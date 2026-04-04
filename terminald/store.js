import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import { TERMINALD_DB_PATH } from './config.js';

function nowIso() {
  return new Date().toISOString();
}

function parseMetadata(metadataJson) {
  if (!metadataJson) {
    return null;
  }

  try {
    return JSON.parse(metadataJson);
  } catch {
    return null;
  }
}

function serializeMetadata(metadata) {
  return metadata ? JSON.stringify(metadata) : null;
}

function normalizeRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    userId: row.user_id,
    terminalKey: row.terminal_key,
    projectName: row.project_name,
    projectRoot: row.project_root,
    runtime: row.runtime,
    sandboxId: row.sandbox_id,
    tmuxSessionName: row.tmux_session_name,
    processId: row.process_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastAttachedAt: row.last_attached_at,
    metadata: parseMetadata(row.metadata_json),
  };
}

const dbDir = path.dirname(TERMINALD_DB_PATH);
fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(TERMINALD_DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS terminals (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    terminal_key TEXT NOT NULL,
    project_name TEXT NOT NULL,
    project_root TEXT NOT NULL,
    runtime TEXT NOT NULL,
    sandbox_id TEXT,
    tmux_session_name TEXT,
    process_id TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    metadata_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_attached_at TEXT,
    UNIQUE(user_id, project_name, terminal_key)
  );
  CREATE INDEX IF NOT EXISTS idx_terminals_user_project ON terminals(user_id, project_name);
  CREATE INDEX IF NOT EXISTS idx_terminals_runtime ON terminals(runtime);
`);

const getByIdStmt = db.prepare('SELECT * FROM terminals WHERE id = ?');
const getByProjectStmt = db.prepare(
  'SELECT * FROM terminals WHERE user_id = ? AND project_name = ? AND terminal_key = ? LIMIT 1',
);
const listByProjectStmt = db.prepare(
  'SELECT * FROM terminals WHERE user_id = ? AND project_name = ? ORDER BY updated_at DESC, created_at DESC',
);
const insertStmt = db.prepare(`
  INSERT INTO terminals (
    id,
    user_id,
    terminal_key,
    project_name,
    project_root,
    runtime,
    sandbox_id,
    tmux_session_name,
    process_id,
    status,
    metadata_json,
    created_at,
    updated_at,
    last_attached_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const updateStmt = db.prepare(`
  UPDATE terminals
  SET
    project_root = @projectRoot,
    runtime = @runtime,
    sandbox_id = @sandboxId,
    tmux_session_name = @tmuxSessionName,
    process_id = @processId,
    status = @status,
    metadata_json = @metadataJson,
    updated_at = @updatedAt,
    last_attached_at = @lastAttachedAt
  WHERE id = @id
`);
const touchStmt = db.prepare(
  'UPDATE terminals SET updated_at = ?, last_attached_at = ?, status = ? WHERE id = ?',
);

export function listProjectTerminals(userId, projectName) {
  return listByProjectStmt.all(userId, projectName).map(normalizeRow);
}

export function getTerminalById(id) {
  return normalizeRow(getByIdStmt.get(id));
}

export function getProjectTerminal(userId, projectName, terminalKey = 'default') {
  return normalizeRow(getByProjectStmt.get(userId, projectName, terminalKey));
}

export function upsertProjectTerminal({
  id,
  userId,
  terminalKey = 'default',
  projectName,
  projectRoot,
  runtime,
  sandboxId = null,
  tmuxSessionName = null,
  processId = null,
  status = 'active',
  metadata = null,
  lastAttachedAt = null,
}) {
  const existing = getProjectTerminal(userId, projectName, terminalKey);
  const now = nowIso();

  if (!existing) {
    const nextId = id || crypto.randomUUID();
    insertStmt.run(
      nextId,
      userId,
      terminalKey,
      projectName,
      projectRoot,
      runtime,
      sandboxId,
      tmuxSessionName,
      processId,
      status,
      serializeMetadata(metadata),
      now,
      now,
      lastAttachedAt,
    );
    return getTerminalById(nextId);
  }

  updateStmt.run({
    id: existing.id,
    projectRoot,
    runtime,
    sandboxId,
    tmuxSessionName,
    processId,
    status,
    metadataJson: serializeMetadata(metadata),
    updatedAt: now,
    lastAttachedAt,
  });

  return getTerminalById(existing.id);
}

export function touchTerminal(id, status = 'active') {
  const now = nowIso();
  touchStmt.run(now, now, status, id);
  return getTerminalById(id);
}

export function markTerminalState(id, status, metadata = undefined) {
  const existing = getTerminalById(id);
  if (!existing) {
    return null;
  }

  updateStmt.run({
    id,
    projectRoot: existing.projectRoot,
    runtime: existing.runtime,
    sandboxId: existing.sandboxId,
    tmuxSessionName: existing.tmuxSessionName,
    processId: existing.processId,
    status,
    metadataJson: serializeMetadata(metadata === undefined ? existing.metadata : metadata),
    updatedAt: nowIso(),
    lastAttachedAt: existing.lastAttachedAt,
  });

  return getTerminalById(id);
}

export function closeTerminalRecord(id) {
  return markTerminalState(id, 'closed');
}

export function getTerminalDatabasePath() {
  return TERMINALD_DB_PATH;
}
