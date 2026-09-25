import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PLAN_AGENTS } from "./plan.js";

export const PLAN_OUTPUT_PATH = ".taskmaster/inbox/plan.json";

const SKIP = new Set([".git", "node_modules", "dist", ".tmp-tmux-test"]);

export async function loadPlannerSkill(): Promise<string> {
  const file = fileURLToPath(new URL("../skills/planner/SKILL.md", import.meta.url));
  return fs.readFile(file, "utf8");
}

export async function buildPlannerPrompt(input: {
  goal: string;
  root: string;
  skill: string;
}): Promise<string> {
  const files = await listProjectFiles(input.root);
  const docs = await readRelevantDocs(input.root);
  return [
    "You are the TaskMaster Planner.",
    "Follow the skill exactly.",
    "The only file you may create or modify is .taskmaster/inbox/plan.json.",
    "Do not modify product source files.",
    "Write a ProjectPlan JSON object with version 1.",
    "projectSummary is required and must be a non-empty string.",
    "Example shape:",
    '{"version":1,"projectSummary":"A one-page game","architecture":{"summary":"One html file","decisions":["No build step"]},"tasks":[{"tempId":"scaffold","title":"Scaffold application","description":"Add the page","agent":"builder","dependencies":[],"acceptanceCriteria":["index.html exists"]}]}',
    "tempId values are short logical ids such as scaffold. They are not database keys.",
    "agent must be one of: builder, tester, validator, documenter.",
    "Every task needs a non-empty title, description, dependencies array, and acceptanceCriteria array.",
    "",
    "Skill:",
    input.skill.trim(),
    "",
    `User goal: ${input.goal}`,
    `Project path: ${input.root}`,
    `Allowed task owners: ${PLAN_AGENTS.join(", ")}`,
    "",
    "Repository files:",
    files.join("\n"),
    "",
    docs,
    "",
    `Write the JSON to ${PLAN_OUTPUT_PATH} and stop.`,
  ].join("\n");
}

async function listProjectFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (found.length >= 80 || depth > 3) return;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (found.length >= 80) return;
      if (SKIP.has(entry.name)) continue;
      const relative = path.relative(root, path.join(dir, entry.name));
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), depth + 1);
      else found.push(relative);
    }
  }
  await walk(root, 0);
  return found.length > 0 ? found : ["(empty repository)"];
}

async function readRelevantDocs(root: string): Promise<string> {
  const candidates = ["README.md", "docs/ARCHITECTURE.md", "docs/DECISIONS.md"];
  const chunks: string[] = [];
  for (const relative of candidates) {
    const text = await fs.readFile(path.join(root, relative), "utf8").catch(() => "");
    if (!text.trim()) continue;
    chunks.push(`--- ${relative} ---\n${text.split("\n").slice(0, 80).join("\n")}`);
  }
  return chunks.length > 0 ? chunks.join("\n\n") : "No project markdown was present.";
}
