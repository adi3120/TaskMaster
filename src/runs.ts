import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { runtimeSessionCodec } from "./sessions/codec.js";

export interface RunRecord {
  id: string;
  projectId: string | null;
  agentId: string | null;
  taskId: string | null;
  runtimeId: string | null;
  model: string | null;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  sessionKey: string | null;
}

export function insertRun(
  db: DatabaseSync,
  input: {
    projectId: string;
    agentId: string;
    taskId: string;
    runtimeId: string;
    model: string;
    status: string;
    startedAt: string;
    sessionKey?: string | null;
  },
): RunRecord {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO runs (
      id, project_id, agent_id, task_id, runtime_id, model, status, started_at, finished_at, exit_code, session_key
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
  ).run(
    id,
    input.projectId,
    input.agentId,
    input.taskId,
    input.runtimeId,
    input.model,
    input.status,
    input.startedAt,
    input.sessionKey ?? null,
  );
  return getRun(db, id);
}

export function finishRun(
  db: DatabaseSync,
  id: string,
  input: { status: string; exitCode: number | null; sessionKey: string | null },
): RunRecord {
  db.prepare(
    `UPDATE runs SET status = ?, finished_at = ?, exit_code = ?, session_key = ? WHERE id = ?`,
  ).run(input.status, new Date().toISOString(), input.exitCode, input.sessionKey, id);
  return getRun(db, id);
}

export function getRun(db: DatabaseSync, id: string): RunRecord {
  const row = db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as
    | {
        id: string;
        project_id: string | null;
        agent_id: string | null;
        task_id: string | null;
        runtime_id: string | null;
        model: string | null;
        status: string;
        started_at: string;
        finished_at: string | null;
        exit_code: number | null;
        session_key: string | null;
      }
    | undefined;
  if (!row) throw new Error(`Run ${id} not found`);
  return {
    id: row.id,
    projectId: row.project_id,
    agentId: row.agent_id,
    taskId: row.task_id,
    runtimeId: row.runtime_id,
    model: row.model,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    exitCode: row.exit_code,
    sessionKey: row.session_key,
  };
}

export function saveSession(
  db: DatabaseSync,
  input: {
    projectId: string;
    agentId: string;
    taskId: string;
    runtimeId: string;
    sessionId: string;
    cwd: string;
    model: string;
  },
): void {
  const params = runtimeSessionCodec.serialize({
    sessionId: input.sessionId,
    cwd: input.cwd,
    model: input.model,
  });
  if (!params) throw new Error("Session params failed validation");
  const now = new Date().toISOString();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO sessions (
      id, project_id, agent_id, task_id, runtime_id, params_json, display_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.projectId,
    input.agentId,
    input.taskId,
    input.runtimeId,
    JSON.stringify(params),
    runtimeSessionCodec.getDisplayId(params),
    now,
    now,
  );
}
