import path from "node:path";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { detectGitRoot } from "./system.js";

export interface DetectedProject {
  name: string;
  root: string;
}

export async function detectProject(cwd: string): Promise<DetectedProject | null> {
  const root = await detectGitRoot(cwd);
  if (!root) return null;
  return { name: path.basename(root), root };
}

export function upsertProject(db: DatabaseSync, project: DetectedProject): string {
  const existing = db.prepare("SELECT id FROM projects WHERE root_path = ?").get(project.root) as
    | { id: string }
    | undefined;
  const now = new Date().toISOString();
  if (existing) {
    db.prepare("UPDATE projects SET name = ?, updated_at = ? WHERE id = ?").run(
      project.name,
      now,
      existing.id,
    );
    return existing.id;
  }
  const id = randomUUID();
  db.prepare(
    "INSERT INTO projects (id, name, root_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(id, project.name, project.root, now, now);
  return id;
}
