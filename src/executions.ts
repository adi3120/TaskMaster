import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AgentRole } from "./db.js";
import type { AgentLifecycle } from "./lifecycle.js";

export interface ExecutionRow {
  id: string;
  projectId: string;
  agentId: AgentRole;
  lifecycle: AgentLifecycle;
  tmuxSession: string | null;
  tmuxWindow: string | null;
  tmuxPaneId: string | null;
  command: string | null;
  pid: number | null;
  startedAt: string | null;
  exitedAt: string | null;
  exitCode: number | null;
  restartCount: number;
  updatedAt: string;
}

export interface DemoSessionRow {
  projectId: string;
  tmuxSession: string;
  status: "active" | "stopped";
  logPaneId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ExecutionSql {
  id: string;
  project_id: string;
  agent_id: string;
  lifecycle: string;
  tmux_session: string | null;
  tmux_window: string | null;
  tmux_pane_id: string | null;
  command: string | null;
  pid: number | null;
  started_at: string | null;
  exited_at: string | null;
  exit_code: number | null;
  restart_count: number;
  updated_at: string;
}

export function saveDemoSession(
  db: DatabaseSync,
  input: {
    projectId: string;
    tmuxSession: string;
    status: "active" | "stopped";
    logPaneId?: string | null;
  },
): DemoSessionRow {
  const now = new Date().toISOString();
  const existing = getDemoSession(db, input.projectId);
  if (existing) {
    db.prepare(
      `UPDATE demo_sessions
       SET tmux_session = ?, status = ?, log_pane_id = ?, updated_at = ?
       WHERE project_id = ?`,
    ).run(input.tmuxSession, input.status, input.logPaneId ?? existing.logPaneId, now, input.projectId);
  } else {
    db.prepare(
      `INSERT INTO demo_sessions (project_id, tmux_session, status, log_pane_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(input.projectId, input.tmuxSession, input.status, input.logPaneId ?? null, now, now);
  }
  return getDemoSession(db, input.projectId)!;
}

export function getDemoSession(db: DatabaseSync, projectId: string): DemoSessionRow | null {
  const row = db.prepare("SELECT * FROM demo_sessions WHERE project_id = ?").get(projectId) as
    | {
        project_id: string;
        tmux_session: string;
        status: string;
        log_pane_id: string | null;
        created_at: string;
        updated_at: string;
      }
    | undefined;
  if (!row) return null;
  return {
    projectId: row.project_id,
    tmuxSession: row.tmux_session,
    status: row.status === "stopped" ? "stopped" : "active",
    logPaneId: row.log_pane_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function upsertExecution(
  db: DatabaseSync,
  input: {
    projectId: string;
    agentId: AgentRole;
    lifecycle: AgentLifecycle;
    tmuxSession?: string | null;
    tmuxWindow?: string | null;
    tmuxPaneId?: string | null;
    command?: string | null;
    pid?: number | null;
    startedAt?: string | null;
    exitedAt?: string | null;
    exitCode?: number | null;
    restartCount?: number;
  },
): ExecutionRow {
  const now = new Date().toISOString();
  const existing = getExecution(db, input.projectId, input.agentId);
  if (!existing) {
    const id = randomUUID();
    db.prepare(
      `INSERT INTO agent_executions (
        id, project_id, agent_id, lifecycle, tmux_session, tmux_window, tmux_pane_id,
        command, pid, started_at, exited_at, exit_code, restart_count, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.projectId,
      input.agentId,
      input.lifecycle,
      input.tmuxSession ?? null,
      input.tmuxWindow ?? null,
      input.tmuxPaneId ?? null,
      input.command ?? null,
      input.pid ?? null,
      input.startedAt ?? null,
      input.exitedAt ?? null,
      input.exitCode ?? null,
      input.restartCount ?? 0,
      now,
    );
    return getExecution(db, input.projectId, input.agentId)!;
  }
  db.prepare(
    `UPDATE agent_executions SET
      lifecycle = ?, tmux_session = ?, tmux_window = ?, tmux_pane_id = ?,
      command = ?, pid = ?, started_at = ?, exited_at = ?, exit_code = ?,
      restart_count = ?, updated_at = ?
     WHERE project_id = ? AND agent_id = ?`,
  ).run(
    input.lifecycle,
    input.tmuxSession === undefined ? existing.tmuxSession : input.tmuxSession,
    input.tmuxWindow === undefined ? existing.tmuxWindow : input.tmuxWindow,
    input.tmuxPaneId === undefined ? existing.tmuxPaneId : input.tmuxPaneId,
    input.command === undefined ? existing.command : input.command,
    input.pid === undefined ? existing.pid : input.pid,
    input.startedAt === undefined ? existing.startedAt : input.startedAt,
    input.exitedAt === undefined ? existing.exitedAt : input.exitedAt,
    input.exitCode === undefined ? existing.exitCode : input.exitCode,
    input.restartCount === undefined ? existing.restartCount : input.restartCount,
    now,
    input.projectId,
    input.agentId,
  );
  return getExecution(db, input.projectId, input.agentId)!;
}

export function getExecution(db: DatabaseSync, projectId: string, agentId: string): ExecutionRow | null {
  const row = db.prepare(
    "SELECT * FROM agent_executions WHERE project_id = ? AND agent_id = ?",
  ).get(projectId, agentId) as ExecutionSql | undefined;
  return row ? toExecution(row) : null;
}

export function listExecutions(db: DatabaseSync, projectId: string): ExecutionRow[] {
  const rows = db.prepare(
    "SELECT * FROM agent_executions WHERE project_id = ? ORDER BY agent_id ASC",
  ).all(projectId) as unknown as ExecutionSql[];
  return rows.map(toExecution);
}

function toExecution(row: ExecutionSql): ExecutionRow {
  return {
    id: row.id,
    projectId: row.project_id,
    agentId: row.agent_id as ExecutionRow["agentId"],
    lifecycle: row.lifecycle as AgentLifecycle,
    tmuxSession: row.tmux_session,
    tmuxWindow: row.tmux_window,
    tmuxPaneId: row.tmux_pane_id,
    command: row.command,
    pid: row.pid,
    startedAt: row.started_at,
    exitedAt: row.exited_at,
    exitCode: row.exit_code,
    restartCount: row.restart_count,
    updatedAt: row.updated_at,
  };
}
