import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { TASK_STATUSES, type TaskStatus } from "./db.js";

export interface TaskRow {
  id: string;
  project_id: string;
  parent_id: string | null;
  title: string;
  description: string;
  status: TaskStatus;
  owner_agent_id: string | null;
  dependencies_json: string;
  branch: string | null;
  worktree: string | null;
  result: string | null;
  created_at: string;
  updated_at: string;
}

export class TaskClaimError extends Error {
  readonly taskId: string;
  readonly ownerAgentId: string | null;
  readonly status: string;

  constructor(taskId: string, ownerAgentId: string | null, status: string) {
    super(`Task ${taskId} is owned by ${ownerAgentId ?? "nobody"} in status ${status}`);
    this.name = "TaskClaimError";
    this.taskId = taskId;
    this.ownerAgentId = ownerAgentId;
    this.status = status;
  }
}

const CLAIMABLE: ReadonlySet<string> = new Set(["PENDING", "READY", "REWORK", "RUNNING"]);

export function createTask(
  db: DatabaseSync,
  input: {
    projectId: string;
    title: string;
    description?: string;
    status?: TaskStatus;
    id?: string;
    parentId?: string | null;
    dependencies?: string[];
  },
): TaskRow {
  const now = new Date().toISOString();
  const id = input.id ?? randomUUID();
  const status = input.status ?? "PENDING";
  if (!TASK_STATUSES.includes(status)) {
    throw new Error(`Unknown task status ${status}`);
  }
  db.prepare(
    `INSERT INTO tasks (
      id, project_id, parent_id, title, description, status, owner_agent_id,
      dependencies_json, branch, worktree, result, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, ?, ?)`,
  ).run(
    id,
    input.projectId,
    input.parentId ?? null,
    input.title,
    input.description ?? "",
    status,
    JSON.stringify(input.dependencies ?? []),
    now,
    now,
  );
  return getTask(db, id);
}

export function getTask(db: DatabaseSync, id: string): TaskRow {
  const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
  if (!row) throw new Error(`Task ${id} not found`);
  return row;
}

/**
 * One task, one active owner. The conditional update is the atomic claim.
 * A different owner loses and must not retry. The current owner may reclaim.
 */
export function claimTask(db: DatabaseSync, taskId: string, agentId: string): TaskRow {
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = db.prepare(
      "SELECT id, status, owner_agent_id FROM tasks WHERE id = ?",
    ).get(taskId) as { id: string; status: string; owner_agent_id: string | null } | undefined;
    if (!current) {
      throw new Error(`Task ${taskId} not found`);
    }
    const sameOwner = current.owner_agent_id === agentId;
    const unowned = current.owner_agent_id === null;
    if (!CLAIMABLE.has(current.status) || (!unowned && !sameOwner)) {
      throw new TaskClaimError(taskId, current.owner_agent_id, current.status);
    }
    const now = new Date().toISOString();
    const result = db.prepare(
      `UPDATE tasks
       SET owner_agent_id = ?, status = 'RUNNING', updated_at = ?
       WHERE id = ?
         AND status = ?
         AND (owner_agent_id IS NULL OR owner_agent_id = ?)`,
    ).run(agentId, now, taskId, current.status, agentId);
    if (result.changes !== 1) {
      const latest = db.prepare(
        "SELECT status, owner_agent_id FROM tasks WHERE id = ?",
      ).get(taskId) as { status: string; owner_agent_id: string | null };
      throw new TaskClaimError(taskId, latest.owner_agent_id, latest.status);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return getTask(db, taskId);
}
