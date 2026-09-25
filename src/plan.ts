export const PLAN_AGENTS = ["builder", "tester", "validator", "documenter"] as const;
export type PlanAgent = (typeof PLAN_AGENTS)[number];

export interface PlannedTask {
  tempId: string;
  title: string;
  description: string;
  agent: PlanAgent;
  dependencies: string[];
  acceptanceCriteria: string[];
}

export interface ProjectPlan {
  version: 1;
  projectSummary: string;
  architecture?: {
    summary: string;
    decisions?: string[];
  };
  tasks: PlannedTask[];
}

export class PlanValidationError extends Error {
  readonly details: string[];

  constructor(details: string[]) {
    super(`Planner produced an invalid plan:\n${details.join("\n")}`);
    this.name = "PlanValidationError";
    this.details = details;
  }
}

export function parsePlanJson(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced?.[1]?.trim() || trimmed;
  try {
    return JSON.parse(body);
  } catch {
    throw new PlanValidationError(["Planner output is not valid JSON"]);
  }
}

export function validatePlan(input: unknown): ProjectPlan {
  const errors: string[] = [];
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new PlanValidationError(["plan must be an object"]);
  }
  const record = input as Record<string, unknown>;
  if (record.version !== 1) {
    errors.push(`unsupported plan version ${String(record.version)}`);
  }
  if (typeof record.projectSummary !== "string" || record.projectSummary.trim().length === 0) {
    errors.push("projectSummary is empty");
  }
  let architecture: ProjectPlan["architecture"];
  if (record.architecture !== undefined) {
    architecture = readArchitecture(record.architecture, errors);
  }
  if (!Array.isArray(record.tasks)) {
    errors.push("tasks must be an array");
    throw new PlanValidationError(errors);
  }
  if (record.tasks.length === 0) {
    errors.push("plan has no tasks");
  }
  const tasks: PlannedTask[] = [];
  const seen = new Set<string>();
  for (const item of record.tasks) {
    tasks.push(readTask(item, seen, errors));
  }
  const ids = new Set(tasks.map((task) => task.tempId).filter((id) => id.length > 0));
  for (const task of tasks) {
    if (task.dependencies.includes(task.tempId) && task.tempId.length > 0) {
      errors.push(`task '${task.tempId}' depends on itself`);
    }
    for (const dependency of task.dependencies) {
      if (dependency !== task.tempId && !ids.has(dependency)) {
        errors.push(`task '${task.tempId}' depends on unknown task '${dependency}'`);
      }
    }
  }
  const cycle = findCycle(tasks);
  if (cycle) errors.push(`dependency cycle: ${cycle}`);
  if (errors.length > 0) throw new PlanValidationError(errors);
  return {
    version: 1,
    projectSummary: (record.projectSummary as string).trim(),
    ...(architecture ? { architecture } : {}),
    tasks,
  };
}

function readArchitecture(value: unknown, errors: string[]): ProjectPlan["architecture"] | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    errors.push("architecture must be an object");
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.summary !== "string" || record.summary.trim().length === 0) {
    errors.push("architecture.summary is empty");
    return undefined;
  }
  let decisions: string[] | undefined;
  if (record.decisions !== undefined) {
    if (!Array.isArray(record.decisions) || record.decisions.some((item) => typeof item !== "string")) {
      errors.push("architecture.decisions must be an array of strings");
    } else {
      decisions = record.decisions;
    }
  }
  return { summary: record.summary.trim(), ...(decisions ? { decisions } : {}) };
}

function readTask(item: unknown, seen: Set<string>, errors: string[]): PlannedTask {
  if (typeof item !== "object" || item === null || Array.isArray(item)) {
    errors.push("task must be an object");
    return { tempId: "", title: "", description: "", agent: "builder", dependencies: [], acceptanceCriteria: [] };
  }
  const record = item as Record<string, unknown>;
  const tempId = typeof record.tempId === "string" ? record.tempId.trim() : "";
  const title = typeof record.title === "string" ? record.title.trim() : "";
  const description = typeof record.description === "string" ? record.description.trim() : "";
  const label = tempId || title || "unknown";
  if (!tempId) errors.push(`task '${label}' is missing tempId`);
  if (tempId && seen.has(tempId)) errors.push(`duplicate task id '${tempId}'`);
  if (tempId) seen.add(tempId);
  if (!title) errors.push(`task '${label}' has an empty title`);
  if (!description) errors.push(`task '${label}' has an empty description`);
  const agent = record.agent;
  if (typeof agent !== "string" || !PLAN_AGENTS.includes(agent as PlanAgent)) {
    errors.push(`task '${label}' has unknown agent '${String(agent)}'`);
  }
  if (!Array.isArray(record.dependencies) || record.dependencies.some((entry) => typeof entry !== "string")) {
    errors.push(`task '${label}' has invalid dependencies`);
  }
  const criteria = record.acceptanceCriteria;
  if (!Array.isArray(criteria) || criteria.length === 0 || criteria.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) {
    errors.push(`task '${label}' is missing acceptance criteria`);
  }
  return {
    tempId,
    title,
    description,
    agent: PLAN_AGENTS.includes(agent as PlanAgent) ? (agent as PlanAgent) : "builder",
    dependencies: Array.isArray(record.dependencies)
      ? record.dependencies.filter((entry): entry is string => typeof entry === "string")
      : [],
    acceptanceCriteria: Array.isArray(criteria)
      ? criteria.filter((entry): entry is string => typeof entry === "string")
      : [],
  };
}

function findCycle(tasks: PlannedTask[]): string | null {
  const ids = new Set(tasks.map((task) => task.tempId));
  const outgoing = new Map<string, string[]>();
  for (const task of tasks) {
    outgoing.set(
      task.tempId,
      task.dependencies.filter((dependency) => ids.has(dependency) && dependency !== task.tempId),
    );
  }
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  function visit(id: string): string | null {
    const mark = state.get(id);
    if (mark === "done") return null;
    if (mark === "visiting") {
      const start = stack.indexOf(id);
      return [...stack.slice(start), id].join(" -> ");
    }
    state.set(id, "visiting");
    stack.push(id);
    for (const next of outgoing.get(id) ?? []) {
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(id, "done");
    return null;
  }
  for (const task of tasks) {
    const cycle = visit(task.tempId);
    if (cycle) return cycle;
  }
  return null;
}
