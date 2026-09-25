import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { runReadyBuilderTask, type BuilderRunResult } from "./builder-run.js";
import { loadConfig, requirePlannerOpenCodeModel } from "./config.js";
import { closeDatabase, openDatabase, restrictDatabaseFile } from "./db.js";
import { startDemo, type DemoContext } from "./demo.js";
import { appendEvent, listEvents } from "./events.js";
import { getExecution, upsertExecution } from "./executions.js";
import { databasePath, ensureHome, taskmasterHome } from "./paths.js";
import { architectureMarkdown, formatPlanSummary, insertPlan, type PersistedTask } from "./plan-store.js";
import { parsePlanJson, validatePlan, type ProjectPlan, PlanValidationError } from "./plan.js";
import { buildPlannerPrompt, loadPlannerSkill, PLAN_OUTPUT_PATH } from "./planner-prompt.js";
import { resolveDemoProject, upsertProject } from "./project.js";
import { buildOpenCodeRunCommand, sessionIdFromOutput } from "./opencode-command.js";
import { resolveOpenCodeBin, runOpenCodePane } from "./opencode-pane.js";
import { finishRun, insertRun, type RunRecord } from "./runs.js";
import { hasSession } from "./tmux.js";

export interface PlannerRunResult {
  goal: string;
  model: string;
  sessionName: string;
  runId: string;
  summary: string;
  plan: ProjectPlan;
  tasks: PersistedTask[];
  builder: BuilderRunResult | null;
}

export async function runPlanner(ctx: DemoContext, goal: string): Promise<PlannerRunResult> {
  const home = taskmasterHome(ctx.env);
  await ensureHome(home);
  const config = await loadConfig(home);
  const model = requirePlannerOpenCodeModel(config);
  const bin = await resolveOpenCodeBin(ctx.env);
  const project = await resolveDemoProject(ctx.cwd);
  const gitRoot = await git(project.root, ["rev-parse", "--show-toplevel"]).catch(() => null);
  if (!gitRoot) throw new Error(`Planner requires a git repository. ${project.root} is not one.`);
  const root = gitRoot.trim();
  const skill = await loadPlannerSkill();
  const prompt = await buildPlannerPrompt({ goal, root, skill });
  const command = buildOpenCodeRunCommand({ bin, model, prompt });
  const planFile = path.join(root, PLAN_OUTPUT_PATH);
  await fs.rm(planFile, { force: true });
  const before = await git(root, ["status", "--porcelain"]);

  await startDemo({ ...ctx, cwd: root, attach: false });
  const db = openDatabase(databasePath(home));
  await restrictDatabaseFile(databasePath(home));
  const projectId = upsertProject(db, { name: path.basename(root), root });
  const execution = getExecution(db, projectId, "planner");
  if (!execution?.tmuxPaneId || !(await hasSession(execution.tmuxSession ?? "", ctx.env))) {
    closeDatabase(db);
    throw new Error("Planner pane is missing. Start the demo session again.");
  }
  const startedAt = new Date().toISOString();
  const run = insertRun(db, {
    projectId,
    agentId: "planner",
    taskId: null,
    runtimeId: "opencode",
    model,
    status: "RUNNING",
    startedAt,
  });
  db.prepare("UPDATE agents SET runtime_id = ?, model = ?, updated_at = ? WHERE id = ?").run(
    "opencode",
    model,
    startedAt,
    "planner",
  );
  appendEvent(db, { projectId, agentId: "planner", type: "PLAN_REQUESTED", summary: goal, payload: { model } });
  appendEvent(db, { projectId, agentId: "planner", type: "RUN_STARTED", summary: `Planner run ${run.id}`, payload: { model, runId: run.id } });
  appendEvent(db, { projectId, agentId: "planner", type: "RUNTIME_STARTED", summary: `OpenCode started with ${model}`, payload: { model, runtime: "opencode" } });
  upsertExecution(db, {
    projectId,
    agentId: "planner",
    lifecycle: "STARTING",
    command,
    startedAt,
    exitedAt: null,
    exitCode: null,
    pid: null,
  });
  const sessionName = execution.tmuxSession ?? "";
  const paneId = execution.tmuxPaneId;
  closeDatabase(db);

  const timeoutMs = Number(ctx.env.TASKMASTER_RUN_TIMEOUT_MS ?? 180000);
  const pane = await runOpenCodePane({
    session: sessionName,
    paneId,
    cwd: root,
    command,
    role: "planner",
    env: ctx.env,
    timeoutMs,
  });
  const raw = await fs.readFile(planFile, "utf8").catch(() => "");
  let plan: ProjectPlan;
  try {
    if (!raw.trim()) {
      throw new PlanValidationError(["Planner did not write .taskmaster/inbox/plan.json"]);
    }
    plan = validatePlan(parsePlanJson(raw));
    const extra = await unexpectedProductChanges(root, before);
    if (extra.length > 0) {
      throw new PlanValidationError([`Planner modified product files: ${extra.join(", ")}`]);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    rejectPlan(home, projectId, run, pane, message);
    throw error;
  }
  const summary = formatPlanSummary(goal, plan);
  const tasks = persistPlan(home, projectId, run, plan, pane, model);
  const memory = architectureMarkdown(plan);
  if (memory) {
    const memoryFile = path.join(root, ".taskmaster/memory/ARCHITECTURE.md");
    await fs.mkdir(path.dirname(memoryFile), { recursive: true });
    await fs.writeFile(memoryFile, memory);
  }
  const builder = ctx.env.TASKMASTER_PLAN_ONLY === "1"
    ? null
    : await runReadyBuilderTask({ ...ctx, cwd: root, attach: false }, root);
  return { goal, model, sessionName, runId: run.id, summary, plan, tasks, builder };
}

function persistPlan(
  home: string,
  projectId: string,
  run: RunRecord,
  plan: ProjectPlan,
  pane: { exitCode: number | null; output: string },
  model: string,
): PersistedTask[] {
  const db = openDatabase(databasePath(home));
  try {
    const tasks = insertPlan(db, projectId, plan);
    finishRun(db, run.id, {
      status: "completed",
      exitCode: pane.exitCode,
      sessionKey: sessionIdFromOutput(pane.output),
    });
    appendEvent(db, {
      projectId,
      agentId: "planner",
      type: "PLAN_GENERATED",
      summary: plan.projectSummary,
      payload: { taskCount: plan.tasks.length },
    });
    appendEvent(db, {
      projectId,
      agentId: "planner",
      type: "PLAN_VALIDATED",
      summary: `${plan.tasks.length} tasks validated`,
    });
    for (const task of tasks) {
      appendEvent(db, {
        projectId,
        agentId: "planner",
        taskId: task.taskId,
        type: "TASK_CREATED",
        summary: task.title,
        payload: { tempId: task.tempId, agent: task.agent, status: task.status },
      });
    }
    appendEvent(db, {
      projectId,
      agentId: "planner",
      type: "PLAN_PERSISTED",
      summary: plan.projectSummary,
      payload: {
        model,
        mapping: tasks.map((task) => ({ tempId: task.tempId, taskId: task.taskId })),
        architecture: plan.architecture ?? null,
      },
    });
    appendEvent(db, { projectId, agentId: "planner", type: "RUN_COMPLETED", summary: `Planner run ${run.id}` });
    return tasks;
  } finally {
    closeDatabase(db);
  }
}

function rejectPlan(
  home: string,
  projectId: string,
  run: RunRecord,
  pane: { exitCode: number | null; output: string },
  message: string,
): void {
  const db = openDatabase(databasePath(home));
  try {
    finishRun(db, run.id, {
      status: "failed",
      exitCode: pane.exitCode,
      sessionKey: sessionIdFromOutput(pane.output),
    });
    appendEvent(db, { projectId, agentId: "planner", type: "PLAN_REJECTED", summary: message });
    appendEvent(db, { projectId, agentId: "planner", type: "RUN_FAILED", summary: message });
  } finally {
    closeDatabase(db);
  }
}

async function unexpectedProductChanges(root: string, before: string): Promise<string[]> {
  const prior = new Set(before.split("\n").map((line) => line.trim()).filter(Boolean));
  const porcelain = await git(root, ["status", "--porcelain"]);
  return porcelain
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !prior.has(line))
    .map((line) => line.slice(3).trim())
    .filter((file) => file !== PLAN_OUTPUT_PATH && !file.startsWith(".taskmaster"));
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}

export function plannerEventTypes(home: string, projectId: string): string[] {
  const db = openDatabase(databasePath(home));
  try {
    return listEvents(db, { projectId, limit: 100 }).map((event) => event.type);
  } finally {
    closeDatabase(db);
  }
}
