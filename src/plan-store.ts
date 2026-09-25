import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ProjectPlan } from "./plan.js";
import { getTask, type TaskRow } from "./tasks.js";

export interface PersistedTask {
  tempId: string;
  taskId: string;
  title: string;
  agent: string;
  status: string;
  dependencies: string[];
}

export function insertPlan(db: DatabaseSync, projectId: string, plan: ProjectPlan): PersistedTask[] {
  db.exec("BEGIN IMMEDIATE");
  try {
    const ids = new Map<string, string>();
    for (const task of plan.tasks) ids.set(task.tempId, randomUUID());
    const persisted: PersistedTask[] = [];
    for (const task of plan.tasks) {
      const taskId = ids.get(task.tempId)!;
      const dependencyIds = task.dependencies.map((tempId) => ids.get(tempId)!);
      const status = dependencyIds.length === 0 ? "READY" : "PENDING";
      const description = [
        task.description,
        "",
        "Acceptance criteria:",
        ...task.acceptanceCriteria.map((criterion) => `- ${criterion}`),
      ].join("\n");
      db.prepare(
        `INSERT INTO tasks (
          id, project_id, parent_id, title, description, status, owner_agent_id,
          dependencies_json, branch, worktree, result, created_at, updated_at
        ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
      ).run(
        taskId,
        projectId,
        task.title,
        description,
        status,
        task.agent,
        JSON.stringify(dependencyIds),
        new Date().toISOString(),
        new Date().toISOString(),
      );
      persisted.push({
        tempId: task.tempId,
        taskId,
        title: task.title,
        agent: task.agent,
        status,
        dependencies: task.dependencies,
      });
    }
    db.exec("COMMIT");
    return persisted;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function promoteReady(db: DatabaseSync, projectId: string): TaskRow[] {
  const rows = db.prepare("SELECT * FROM tasks WHERE project_id = ?").all(projectId) as unknown as TaskRow[];
  const byId = new Map(rows.map((row) => [row.id, row]));
  const promoted: TaskRow[] = [];
  const now = new Date().toISOString();
  for (const row of rows) {
    if (row.status !== "PENDING") continue;
    const dependencies = JSON.parse(row.dependencies_json) as string[];
    const satisfied = dependencies.every((id) => byId.get(id)?.status === "DONE");
    if (!satisfied) continue;
    db.prepare("UPDATE tasks SET status = 'READY', updated_at = ? WHERE id = ? AND status = 'PENDING'").run(now, row.id);
    promoted.push(getTask(db, row.id));
  }
  return promoted;
}

export function formatPlanSummary(goal: string, plan: ProjectPlan): string {
  const lines = ["TaskMaster Plan", "", `Goal:`, goal, "", "Tasks:", ""];
  plan.tasks.forEach((task, index) => {
    const depends = task.dependencies.length === 0
      ? "none"
      : task.dependencies
          .map((tempId) => plan.tasks.findIndex((item) => item.tempId === tempId) + 1)
          .join(", ");
    lines.push(`${index + 1}. ${task.title}`);
    lines.push(`   Owner: ${task.agent}`);
    lines.push(`   ${task.dependencies.length === 0 ? "Dependencies" : "Depends on"}: ${depends}`);
    lines.push("");
  });
  lines.push("Plan valid: yes");
  return `${lines.join("\n")}\n`;
}

export function architectureMarkdown(plan: ProjectPlan): string | null {
  if (!plan.architecture) return null;
  const decisions = (plan.architecture.decisions ?? []).map((decision) => `- ${decision}`).join("\n");
  return `# Architecture\n\n${plan.architecture.summary}\n${decisions ? `\n## Decisions\n\n${decisions}\n` : ""}`;
}
