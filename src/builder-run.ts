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
import { resolveOnPath } from "./runtimes/detect.js";
import { finishRun, insertRun, saveSession } from "./runs.js";
import { claimTask, createTask } from "./tasks.js";
import { capturePane, hasSession, listPanes, resizeWindow, respawnPane, selectPaneTitle } from "./tmux.js";

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
  const bin = await resolveOpenCode(ctx.env);
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
  if (execution.tmuxSession) {
    await resizeWindow(`${execution.tmuxSession}:agents`, 220, 50, ctx.env);
  }
  await respawnPane(execution.tmuxPaneId, root, command, ctx.env);
  await selectPaneTitle(execution.tmuxPaneId, "builder", ctx.env);
  closeDatabase(db);

  const timeoutMs = Number(ctx.env.TASKMASTER_RUN_TIMEOUT_MS ?? 180000);
  const pane = await waitForPaneExit(execution.tmuxSession ?? "", execution.tmuxPaneId, ctx.env, timeoutMs);
  const output = await capturePane(execution.tmuxPaneId, ctx.env);
  const sessionKey = sessionIdFromOutput(output);
  const exitCode = pane?.exitCode ?? null;
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

async function resolveOpenCode(env: NodeJS.ProcessEnv): Promise<string> {
  const override = env.TASKMASTER_OPENCODE_BIN?.trim();
  if (override) return override;
  const found = await resolveOnPath("opencode", env.PATH ?? "");
  if (!found) throw new Error("OpenCode is not installed. Install the opencode CLI before taskmaster run.");
  return found;
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

async function waitForPaneExit(
  session: string,
  paneId: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ exitCode: number | null; pid: number | null } | null> {
  const started = Date.now();
  let sawAlive = false;
  while (Date.now() - started < timeoutMs) {
    const panes = await listPanes(session, env);
    const pane = panes.find((item) => item.paneId === paneId);
    if (!pane) return null;
    if (!pane.dead) sawAlive = true;
    if (pane.dead && (sawAlive || Date.now() - started > 500)) return pane;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Builder pane ${paneId} did not exit within ${timeoutMs}ms`);
}
