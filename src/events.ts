import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface TaskEvent {
  id: string;
  projectId: string | null;
  agentId: string | null;
  taskId: string | null;
  type: string;
  summary: string;
  payload: unknown;
  createdAt: string;
}

interface EventRow {
  id: string;
  project_id: string | null;
  agent_id: string | null;
  task_id: string | null;
  type: string;
  summary: string;
  payload_json: string | null;
  created_at: string;
}

export function appendEvent(
  db: DatabaseSync,
  input: {
    type: string;
    summary: string;
    projectId?: string | null;
    agentId?: string | null;
    taskId?: string | null;
    payload?: unknown;
    createdAt?: string;
  },
): TaskEvent {
  const id = randomUUID();
  const createdAt = input.createdAt ?? new Date().toISOString();
  const payloadJson = input.payload === undefined ? null : JSON.stringify(input.payload);
  db.prepare(
    `INSERT INTO events (id, project_id, agent_id, task_id, type, summary, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.projectId ?? null,
    input.agentId ?? null,
    input.taskId ?? null,
    input.type,
    input.summary,
    payloadJson,
    createdAt,
  );
  return {
    id,
    projectId: input.projectId ?? null,
    agentId: input.agentId ?? null,
    taskId: input.taskId ?? null,
    type: input.type,
    summary: input.summary,
    payload: input.payload ?? null,
    createdAt,
  };
}

export function listEvents(
  db: DatabaseSync,
  filter: { projectId?: string; taskId?: string; limit?: number } = {},
): TaskEvent[] {
  const limit = filter.limit ?? 50;
  const clauses: string[] = [];
  const params: string[] = [];
  if (filter.projectId) {
    clauses.push("project_id = ?");
    params.push(filter.projectId);
  }
  if (filter.taskId) {
    clauses.push("task_id = ?");
    params.push(filter.taskId);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db.prepare(
    `SELECT * FROM events ${where} ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).all(...params, limit) as unknown as EventRow[];
  return rows.map(toEvent);
}

function toEvent(row: EventRow): TaskEvent {
  return {
    id: row.id,
    projectId: row.project_id,
    agentId: row.agent_id,
    taskId: row.task_id,
    type: row.type,
    summary: row.summary,
    payload: row.payload_json ? JSON.parse(row.payload_json) : null,
    createdAt: row.created_at,
  };
}
