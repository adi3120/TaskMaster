import fs from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

export const SCHEMA_VERSION = 3;

export const AGENT_ROLES = ["planner", "builder", "tester", "validator", "documenter"] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

export const TASK_STATUSES = [
  "PENDING",
  "READY",
  "RUNNING",
  "TESTING",
  "VALIDATING",
  "REWORK",
  "DONE",
  "BLOCKED",
  "FAILED",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_meta (
  version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL UNIQUE,
  runtime_id TEXT,
  provider_id TEXT,
  model TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  parent_id TEXT REFERENCES tasks(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  owner_agent_id TEXT REFERENCES agents(id),
  dependencies_json TEXT NOT NULL DEFAULT '[]',
  branch TEXT,
  worktree TEXT,
  result TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id),
  agent_id TEXT REFERENCES agents(id),
  task_id TEXT REFERENCES tasks(id),
  runtime_id TEXT,
  model TEXT,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  exit_code INTEGER,
  session_key TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  task_id TEXT REFERENCES tasks(id),
  runtime_id TEXT NOT NULL,
  params_json TEXT NOT NULL,
  display_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id),
  agent_id TEXT,
  task_id TEXT,
  type TEXT NOT NULL,
  summary TEXT NOT NULL,
  payload_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  base_url TEXT,
  api_key_ref TEXT,
  default_model TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS demo_sessions (
  project_id TEXT PRIMARY KEY REFERENCES projects(id),
  tmux_session TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  log_pane_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_executions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  lifecycle TEXT NOT NULL,
  tmux_session TEXT,
  tmux_window TEXT,
  tmux_pane_id TEXT,
  command TEXT,
  pid INTEGER,
  started_at TEXT,
  exited_at TEXT,
  exit_code INTEGER,
  restart_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, agent_id)
);
`;

export function openDatabase(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  ensureRunModelColumn(db);
  const version = db.prepare("SELECT version FROM schema_meta LIMIT 1").get() as
    | { version: number }
    | undefined;
  if (!version) {
    db.prepare("INSERT INTO schema_meta (version) VALUES (?)").run(SCHEMA_VERSION);
  } else if (version.version < SCHEMA_VERSION) {
    db.prepare("UPDATE schema_meta SET version = ?").run(SCHEMA_VERSION);
  }
  seedAgents(db);
  return db;
}

export async function restrictDatabaseFile(file: string): Promise<void> {
  if (file === ":memory:") return;
  await fs.chmod(file, 0o600).catch(() => undefined);
}

function ensureRunModelColumn(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "model")) {
    db.exec("ALTER TABLE runs ADD COLUMN model TEXT");
  }
}

function seedAgents(db: DatabaseSync): void {
  const now = new Date().toISOString();
  const insert = db.prepare(
    `INSERT INTO agents (id, role, runtime_id, provider_id, model, created_at, updated_at)
     VALUES (?, ?, NULL, NULL, NULL, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  );
  for (const role of AGENT_ROLES) {
    insert.run(role, role, now, now);
  }
}

export function closeDatabase(db: DatabaseSync): void {
  db.close();
}
