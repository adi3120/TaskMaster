import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { requireBuilderOpenCodeModel, loadConfig } from "./config.js";
import { closeDatabase, openDatabase, restrictDatabaseFile } from "./db.js";
import { startDemo, type DemoContext } from "./demo.js";
import { appendEvent } from "./events.js";
import { getExecution, upsertExecution } from "./executions.js";
import { databasePath, ensureHome, taskmasterHome } from "./paths.js";
import { resolveDemoProject, upsertProject } from "./project.js";
import { buildOpenCodeRunCommand, fileRequestedByPrompt, sessionIdFromOutput } from "./opencode-command.js";
import { resolveOpenCodeBin, runOpenCodePane } from "./opencode-pane.js";
import { finishRun, insertRun, saveSession } from "./runs.js";
import { promoteReady } from "./plan-store.js";
import { claimTask, createTask, getTask } from "./tasks.js";
import { hasSession } from "./tmux.js";

export interface BuilderRunResult {
  taskId: string;
  runId: string;
  model: string;
  sessionName: string;
  exitCode: number | null;
  verified: boolean;
  createdFile: string | null;
}

export async function runBuilder(ctx: DemoContext, prompt: string): Promise<BuilderRunResult> {
  const home = taskmasterHome(ctx.env);
  await ensureHome(home);
  const config = await loadConfig(home);
  const model = requireBuilderOpenCodeModel(config);
  const bin = await resolveOpenCodeBin(ctx.env);
  const command = buildOpenCodeRunCommand({ bin, model, prompt });
  const project = await resolveDemoProject(ctx.cwd);
  const gitRoot = await git(project.root, ["rev-parse", "--show-toplevel"]).catch(() => null);
  if (!gitRoot) {
    throw new Error(`Builder run requires a git repository. ${project.root} is not one.`);
  }
  const root = gitRoot.trim();
  const before = await git(root, ["status", "--porcelain"]);
  const requestedFile = fileRequestedByPrompt(prompt);

  await startDemo({ ...ctx, cwd: root, attach: false });
  const db = openDatabase(databasePath(home));
  await restrictDatabaseFile(databasePath(home));
  const projectId = upsertProject(db, { name: path.basename(root), root });
  const execution = getExecution(db, projectId, "builder");
  if (!execution?.tmuxPaneId) {
    closeDatabase(db);
    throw new Error("Builder pane is missing. Start the demo session again.");
  }
  if (!(await hasSession(execution.tmuxSession ?? "", ctx.env))) {
    closeDatabase(db);
    throw new Error("tmux session is not running");
  }

  const task = createTask(db, {
    projectId,
    title: prompt.slice(0, 80),
    description: prompt,
    status: "READY",
  });
  claimTask(db, task.id, "builder");
  const startedAt = new Date().toISOString();
  const run = insertRun(db, {
    projectId,
    agentId: "builder",
    taskId: task.id,
    runtimeId: "opencode",
    model,
    status: "RUNNING",
    startedAt,
  });
  db.prepare("UPDATE agents SET runtime_id = ?, model = ?, updated_at = ? WHERE id = ?").run(
    "opencode",
    model,
    startedAt,
    "builder",
  );
  appendEvent(db, {
    projectId,
    agentId: "builder",
    taskId: task.id,
    type: "TASK_CREATED",
    summary: prompt.slice(0, 120),
  });
  appendEvent(db, {
    projectId,
    agentId: "builder",
    taskId: task.id,
    type: "TASK_STARTED",
    summary: `Builder started OpenCode with ${model}`,
    payload: { model, runtime: "opencode" },
  });
  upsertExecution(db, {
    projectId,
    agentId: "builder",
    lifecycle: "STARTING",
    command,
    startedAt,
    exitedAt: null,
    exitCode: null,
    pid: null,
  });
  closeDatabase(db);

  const timeoutMs = Number(ctx.env.TASKMASTER_RUN_TIMEOUT_MS ?? 180000);
  const pane = await runOpenCodePane({
    session: execution.tmuxSession ?? "",
    paneId: execution.tmuxPaneId,
    cwd: root,
    command,
    role: "builder",
    env: ctx.env,
    timeoutMs,
  });
  const output = pane.output;
  const sessionKey = sessionIdFromOutput(output);
  const exitCode = pane.exitCode;
  const createdFile = requestedFile ? path.join(root, requestedFile) : null;
  const fileExists = createdFile ? await fs.access(createdFile).then(() => true).catch(() => false) : false;
  const after = await git(root, ["status", "--porcelain"]);
  const gitChanged = porcelainAdded(before, after).length > 0;
  const verified = (exitCode === 0) && gitChanged && (requestedFile ? fileExists : true);

  const done = openDatabase(databasePath(home));
  try {
    const status = verified ? "completed" : "failed";
    finishRun(done, run.id, { status, exitCode, sessionKey });
    if (sessionKey) {
      saveSession(done, {
        projectId,
        agentId: "builder",
        taskId: task.id,
        runtimeId: "opencode",
        sessionId: sessionKey,
        cwd: root,
        model,
      });
    }
    done.prepare("UPDATE tasks SET status = ?, result = ?, updated_at = ? WHERE id = ?").run(
      verified ? "DONE" : "FAILED",
      verified ? `Verified change with ${model}` : "OpenCode run did not produce a verified git change",
      new Date().toISOString(),
      task.id,
    );
    upsertExecution(done, {
      projectId,
      agentId: "builder",
      lifecycle: exitCode === 0 ? "EXITED" : "CRASHED",
      exitCode,
      exitedAt: new Date().toISOString(),
      pid: pane?.pid ?? null,
    });
    appendEvent(done, {
      projectId,
      agentId: "builder",
      taskId: task.id,
      type: verified ? "TASK_COMPLETED" : "TASK_FAILED",
      summary: verified ? `Builder verified the change with ${model}` : "Builder run failed verification",
      payload: { model, exitCode, sessionKey, createdFile: requestedFile },
    });
    if (!verified) {
      throw new Error(
        `Builder run failed verification (exit ${exitCode ?? "unknown"}). Model ${model} was passed explicitly.`,
      );
    }
    return {
      taskId: task.id,
      runId: run.id,
      model,
      sessionName: execution.tmuxSession ?? "",
      exitCode,
      verified,
      createdFile,
    };
  } finally {
    closeDatabase(done);
  }
}

export async function runReadyBuilderTask(ctx: DemoContext, projectRoot: string): Promise<BuilderRunResult | null> {
  const home = taskmasterHome(ctx.env);
  const config = await loadConfig(home);
  const model = requireBuilderOpenCodeModel(config);
  const bin = await resolveOpenCodeBin(ctx.env);
  const db = openDatabase(databasePath(home));
  const projectId = upsertProject(db, { name: path.basename(projectRoot), root: projectRoot });
  const ready = db.prepare(
    `SELECT id FROM tasks WHERE project_id = ? AND status = 'READY' AND owner_agent_id = 'builder' ORDER BY created_at LIMIT 1`,
  ).get(projectId) as { id: string } | undefined;
  if (!ready) {
    closeDatabase(db);
    return null;
  }
  const task = getTask(db, ready.id);
  const execution = getExecution(db, projectId, "builder");
  if (!execution?.tmuxPaneId || !(await hasSession(execution.tmuxSession ?? "", ctx.env))) {
    closeDatabase(db);
    throw new Error("Builder pane is missing. Start the demo session again.");
  }
  claimTask(db, task.id, "builder");
  const prompt = [
    "Implement only this task. Do not start later tasks.",
    "",
    task.title,
    "",
    task.description,
  ].join("\n");
  const command = buildOpenCodeRunCommand({ bin, model, prompt });
  const before = await git(projectRoot, ["status", "--porcelain"]);
  const startedAt = new Date().toISOString();
  const run = insertRun(db, {
    projectId,
    agentId: "builder",
    taskId: task.id,
    runtimeId: "opencode",
    model,
    status: "RUNNING",
    startedAt,
  });
  appendEvent(db, {
    projectId,
    agentId: "builder",
    taskId: task.id,
    type: "RUN_STARTED",
    summary: `Builder run started for ${task.title}`,
    payload: { model },
  });
  appendEvent(db, {
    projectId,
    agentId: "builder",
    taskId: task.id,
    type: "RUNTIME_STARTED",
    summary: `OpenCode started with ${model}`,
    payload: { model, runtime: "opencode" },
  });
  appendEvent(db, {
    projectId,
    agentId: "builder",
    taskId: task.id,
    type: "TASK_STARTED",
    summary: task.title,
  });
  closeDatabase(db);
  const timeoutMs = Number(ctx.env.TASKMASTER_RUN_TIMEOUT_MS ?? 180000);
  const pane = await runOpenCodePane({
    session: execution.tmuxSession ?? "",
    paneId: execution.tmuxPaneId,
    cwd: projectRoot,
    command,
    role: "builder",
    env: ctx.env,
    timeoutMs,
  });
  const after = await git(projectRoot, ["status", "--porcelain"]);
  const verified = pane.exitCode === 0 && porcelainAdded(before, after).length > 0;
  const done = openDatabase(databasePath(home));
  try {
    finishRun(done, run.id, {
      status: verified ? "completed" : "failed",
      exitCode: pane.exitCode,
      sessionKey: sessionIdFromOutput(pane.output),
    });
    done.prepare("UPDATE tasks SET status = ?, result = ?, updated_at = ? WHERE id = ?").run(
      verified ? "DONE" : "FAILED",
      verified ? `Verified change with ${model}` : "OpenCode run did not produce a verified git change",
      new Date().toISOString(),
      task.id,
    );
    if (verified) promoteReady(done, projectId);
    appendEvent(done, {
      projectId,
      agentId: "builder",
      taskId: task.id,
      type: verified ? "RUN_COMPLETED" : "RUN_FAILED",
      summary: verified ? `Builder verified ${task.title}` : `Builder failed ${task.title}`,
      payload: { model, exitCode: pane.exitCode },
    });
    appendEvent(done, {
      projectId,
      agentId: "builder",
      taskId: task.id,
      type: verified ? "TASK_COMPLETED" : "TASK_FAILED",
      summary: task.title,
    });
    if (!verified) {
      throw new Error(`Builder task "${task.title}" failed verification (exit ${pane.exitCode ?? "unknown"}).`);
    }
    return {
      taskId: task.id,
      runId: run.id,
      model,
      sessionName: execution.tmuxSession ?? "",
      exitCode: pane.exitCode,
      verified,
      createdFile: null,
    };
  } finally {
    closeDatabase(done);
  }
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

function porcelainAdded(before: string, after: string): string[] {
  const prior = new Set(before.split("\n").map((line) => line.trim()).filter(Boolean));
  return after.split("\n").map((line) => line.trim()).filter((line) => line.length > 0 && !prior.has(line));
}

