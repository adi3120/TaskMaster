import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_ROLES, type AgentRole, closeDatabase, openDatabase, restrictDatabaseFile } from "./db.js";
import { appendEvent, listEvents, type TaskEvent } from "./events.js";
import {
  getDemoSession,
  getExecution,
  listExecutions,
  saveDemoSession,
  upsertExecution,
  type ExecutionRow,
} from "./executions.js";
import { lifecycleLabel, nextLifecycle } from "./lifecycle.js";
import { databasePath, ensureHome, taskmasterHome } from "./paths.js";
import { resolveDemoProject, upsertProject } from "./project.js";
import { detectTmux } from "./tmux.js";
import {
  attachSession,
  capturePane,
  createDemoLayout,
  hasSession,
  killSession,
  listPanes,
  respawnPane,
  selectPaneTitle,
  sessionNameForProject,
  shellQuote,
  type DemoLayout,
  type PaneSnapshot,
} from "./tmux.js";

export interface DemoContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
  attach?: boolean;
}

export interface DemoStatus {
  projectName: string;
  projectRoot: string;
  sessionName: string;
  sessionActive: boolean;
  executions: ExecutionRow[];
  events: TaskEvent[];
}

const ROLE_ORDER: AgentRole[] = [...AGENT_ROLES];

export function isAgentRole(value: string): value is AgentRole {
  return (AGENT_ROLES as readonly string[]).includes(value);
}

export function formatDemoStatus(status: DemoStatus): string {
  const lines = [
    `TaskMaster — ${status.projectName}`,
    "",
    ...ROLE_ORDER.map((role) => {
      const execution = status.executions.find((row) => row.agentId === role);
      const label = execution ? lifecycleLabel(execution.lifecycle) : "missing";
      return `${role.padEnd(14)}${label}`;
    }),
    "",
    "tmux session:",
    status.sessionActive ? status.sessionName : `${status.sessionName} (not running)`,
    "",
  ];
  return lines.join("\n");
}

async function nodeScript(base: string): Promise<string> {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const js = path.join(dir, `${base}.js`);
  try {
    await fs.access(js);
    return js;
  } catch {
    return path.join(dir, `${base}.ts`);
  }
}

async function launchCommand(script: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  const useStrip = script.endsWith(".ts");
  const prefix = useStrip ? `${shellQuote(process.execPath)} --experimental-strip-types` : shellQuote(process.execPath);
  const home = taskmasterHome(env);
  const projectId = env.TASKMASTER_PROJECT_ID ?? "";
  return [
    `TASKMASTER_HOME=${shellQuote(home)}`,
    `TASKMASTER_PROJECT_ID=${shellQuote(projectId)}`,
    "exec",
    prefix,
    shellQuote(script),
    ...args.map(shellQuote),
  ].join(" ");
}

async function open(ctx: DemoContext) {
  const home = taskmasterHome(ctx.env);
  await ensureHome(home);
  const dbFile = databasePath(home);
  const db = openDatabase(dbFile);
  await restrictDatabaseFile(dbFile);
  const project = await resolveDemoProject(ctx.cwd);
  const projectId = upsertProject(db, project);
  const sessionName = sessionNameForProject(project.name);
  return { db, dbFile, project, projectId, sessionName, home };
}

export async function reconcileDemo(ctx: DemoContext): Promise<DemoStatus> {
  const { db, project, projectId, sessionName } = await open(ctx);
  try {
    const alive = await hasSession(sessionName, ctx.env);
    const panes = alive ? await listPanes(sessionName, ctx.env) : [];
    const byTitle = new Map(panes.map((pane) => [pane.title, pane]));
    for (const role of ROLE_ORDER) {
      const current = getExecution(db, projectId, role);
      if (!current) continue;
      const pane = current.tmuxPaneId
        ? panes.find((item) => item.paneId === current.tmuxPaneId) ?? byTitle.get(role)
        : byTitle.get(role);
      applyProbe(db, projectId, role, current, pane ?? null, alive);
    }
    if (!alive) {
      const demo = getDemoSession(db, projectId);
      if (demo?.status === "active") {
        saveDemoSession(db, { projectId, tmuxSession: sessionName, status: "stopped", logPaneId: demo.logPaneId });
      }
    }
    return readStatus(db, project.name, project.root, projectId, sessionName, alive);
  } finally {
    closeDatabase(db);
  }
}

function applyProbe(
  db: ReturnType<typeof openDatabase>,
  projectId: string,
  role: AgentRole,
  current: ExecutionRow,
  pane: PaneSnapshot | null,
  sessionAlive: boolean,
): void {
  if (pane && (current.lifecycle === "STARTING" || current.lifecycle === "RESTARTING") && pane.dead) {
    const age = Date.now() - Date.parse(current.updatedAt);
    if (Number.isFinite(age) && age < 2000) return;
  }
  if (!sessionAlive || !pane) {
    if (current.lifecycle === "RUNNING" || current.lifecycle === "STARTING" || current.lifecycle === "RESTARTING") {
      upsertExecution(db, {
        projectId,
        agentId: role,
        lifecycle: "CRASHED",
        exitedAt: new Date().toISOString(),
        exitCode: null,
        pid: null,
      });
      appendEvent(db, {
        projectId,
        agentId: role,
        type: "AGENT_CRASHED",
        summary: `${role} lost its tmux pane`,
      });
    }
    return;
  }
  const next = nextLifecycle(current.lifecycle, pane);
  const changed = next !== current.lifecycle || pane.pid !== current.pid || pane.exitCode !== current.exitCode;
  if (!changed) return;
  upsertExecution(db, {
    projectId,
    agentId: role,
    lifecycle: next,
    pid: pane.pid,
    exitCode: pane.dead ? pane.exitCode : null,
    exitedAt: pane.dead ? current.exitedAt ?? new Date().toISOString() : null,
    tmuxPaneId: pane.paneId,
  });
  if (next === current.lifecycle) return;
  if (next === "CRASHED") {
    appendEvent(db, {
      projectId,
      agentId: role,
      type: "AGENT_CRASHED",
      summary: `${role} crashed`,
      payload: { exitCode: pane.exitCode, pid: pane.pid },
    });
  } else if (next === "EXITED") {
    appendEvent(db, {
      projectId,
      agentId: role,
      type: "AGENT_EXITED",
      summary: `${role} exited`,
      payload: { exitCode: pane.exitCode },
    });
  } else if (next === "RUNNING" && (current.lifecycle === "STARTING" || current.lifecycle === "RESTARTING")) {
    appendEvent(db, {
      projectId,
      agentId: role,
      type: "AGENT_STARTED",
      summary: `${role} is running`,
      payload: { pid: pane.pid, paneId: pane.paneId },
    });
  }
}

function readStatus(
  db: ReturnType<typeof openDatabase>,
  projectName: string,
  projectRoot: string,
  projectId: string,
  sessionName: string,
  sessionActive: boolean,
): DemoStatus {
  return {
    projectName,
    projectRoot,
    sessionName,
    sessionActive,
    executions: listExecutions(db, projectId),
    events: listEvents(db, { projectId, limit: 100 }),
  };
}

export async function startDemo(ctx: DemoContext): Promise<DemoStatus> {
  const tmux = await detectTmux();
  if (!tmux.ok) throw new Error(tmux.error ?? "tmux is not available");
  const { db, project, projectId, sessionName } = await open(ctx);
  try {
    let exists = await hasSession(sessionName, ctx.env);
    if (exists) {
      const panes = await listPanes(sessionName, ctx.env);
      const paneIds = new Set(panes.map((pane) => pane.paneId));
      const stored = listExecutions(db, projectId);
      const demo = getDemoSession(db, projectId);
      const complete = ROLE_ORDER.every((role) => {
        const execution = stored.find((row) => row.agentId === role);
        return Boolean(execution?.tmuxPaneId && paneIds.has(execution.tmuxPaneId));
      }) && Boolean(demo?.logPaneId && paneIds.has(demo.logPaneId));
      if (!complete) {
        await killSession(sessionName, ctx.env);
        exists = false;
      }
    }
    if (!exists) {
      const layout = await createDemoLayout(sessionName, ctx.env);
      saveDemoSession(db, { projectId, tmuxSession: sessionName, status: "active", logPaneId: layout.log });
      appendEvent(db, {
        projectId,
        type: "TMUX_SESSION_CREATED",
        summary: `Created tmux session ${sessionName}`,
        payload: { session: sessionName },
      });
      const env = { ...ctx.env, TASKMASTER_PROJECT_ID: projectId };
      await launchAgents(db, projectId, project.root, sessionName, layout, env);
    } else {
      saveDemoSession(db, {
        projectId,
        tmuxSession: sessionName,
        status: "active",
        logPaneId: getDemoSession(db, projectId)?.logPaneId,
      });
    }
  } finally {
    closeDatabase(db);
  }
  const status = await reconcileDemo(ctx);
  if (ctx.attach) {
    const attached = await open(ctx);
    try {
      appendEvent(attached.db, {
        projectId: attached.projectId,
        type: "TMUX_SESSION_ATTACHED",
        summary: `Attached to ${sessionName}`,
      });
    } finally {
      closeDatabase(attached.db);
    }
    await attachSession(sessionName, ctx.env);
  }
  return status;
}

async function launchAgents(
  db: ReturnType<typeof openDatabase>,
  projectId: string,
  cwd: string,
  sessionName: string,
  layout: DemoLayout,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const agentScript = await nodeScript("mock-agent");
  const logScript = await nodeScript("demo-log");
  const now = new Date().toISOString();
  for (const role of ROLE_ORDER) {
    const command = await launchCommand(agentScript, ["--role", role], env);
    const paneId = layout[role];
    const window = role === "documenter" ? "support" : "agents";
    upsertExecution(db, {
      projectId,
      agentId: role,
      lifecycle: "STARTING",
      tmuxSession: sessionName,
      tmuxWindow: window,
      tmuxPaneId: paneId,
      command,
      pid: null,
      startedAt: now,
      exitedAt: null,
      exitCode: null,
    });
    appendEvent(db, {
      projectId,
      agentId: role,
      type: "AGENT_PANE_CREATED",
      summary: `${role} pane ${paneId}`,
      payload: { paneId, window },
    });
    await respawnPane(paneId, cwd, command, env);
    await selectPaneTitle(paneId, role, env);
  }
  const logCommand = await launchCommand(logScript, [], env);
  await respawnPane(layout.log, cwd, logCommand, env);
  await selectPaneTitle(layout.log, "taskmaster-log", env);
  appendEvent(db, {
    projectId,
    type: "AGENT_PANE_CREATED",
    summary: `taskmaster log pane ${layout.log}`,
    payload: { paneId: layout.log, window: "support", surface: "log" },
  });
}

export async function restartAgent(ctx: DemoContext, role: AgentRole): Promise<DemoStatus> {
  await reconcileDemo(ctx);
  const { db, projectId, sessionName, project } = await open(ctx);
  try {
    const execution = getExecution(db, projectId, role);
    if (!execution?.tmuxPaneId || !execution.command) {
      throw new Error(`No demo execution for ${role}. Run taskmaster demo first.`);
    }
    if (!(await hasSession(sessionName, ctx.env))) {
      throw new Error(`tmux session ${sessionName} is not running`);
    }
    const now = new Date().toISOString();
    upsertExecution(db, {
      projectId,
      agentId: role,
      lifecycle: "RESTARTING",
      startedAt: now,
      exitedAt: null,
      exitCode: null,
      restartCount: execution.restartCount + 1,
    });
    appendEvent(db, {
      projectId,
      agentId: role,
      type: "AGENT_RESTARTED",
      summary: `Restarted ${role}`,
      payload: { restartCount: execution.restartCount + 1 },
    });
    await respawnPane(execution.tmuxPaneId, project.root, execution.command, ctx.env);
    await selectPaneTitle(execution.tmuxPaneId, role, ctx.env);
  } finally {
    closeDatabase(db);
  }
  return reconcileDemo(ctx);
}

export async function crashAgent(ctx: DemoContext, role: AgentRole): Promise<DemoStatus> {
  const status = await reconcileDemo(ctx);
  const execution = status.executions.find((row) => row.agentId === role);
  if (!execution?.pid) throw new Error(`${role} has no live process to crash`);
  try {
    process.kill(execution.pid, "SIGKILL");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") throw error;
  }
  await waitForPane(ctx, role, (pane) => pane?.dead === true);
  return reconcileDemo(ctx);
}

async function waitForPane(
  ctx: DemoContext,
  role: AgentRole,
  predicate: (pane: PaneSnapshot | undefined) => boolean,
): Promise<void> {
  const { sessionName } = await open(ctx).then((opened) => {
    closeDatabase(opened.db);
    return opened;
  });
  const started = Date.now();
  while (Date.now() - started < 4000) {
    const panes = await listPanes(sessionName, ctx.env);
    const pane = panes.find((item) => item.title === role);
    if (predicate(pane)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export async function stopDemo(ctx: DemoContext): Promise<DemoStatus> {
  const { db, project, projectId, sessionName } = await open(ctx);
  try {
    await killSession(sessionName, ctx.env);
    saveDemoSession(db, { projectId, tmuxSession: sessionName, status: "stopped" });
    const now = new Date().toISOString();
    for (const role of ROLE_ORDER) {
      const current = getExecution(db, projectId, role);
      if (!current) continue;
      upsertExecution(db, {
        projectId,
        agentId: role,
        lifecycle: "EXITED",
        pid: null,
        exitedAt: now,
        exitCode: 0,
      });
    }
    appendEvent(db, {
      projectId,
      type: "TMUX_SESSION_STOPPED",
      summary: `Stopped tmux session ${sessionName}`,
    });
    return readStatus(db, project.name, project.root, projectId, sessionName, false);
  } finally {
    closeDatabase(db);
  }
}

export async function attachDemo(ctx: DemoContext): Promise<void> {
  const status = await reconcileDemo(ctx);
  if (!status.sessionActive) throw new Error(`tmux session ${status.sessionName} is not running`);
  const { db, projectId } = await open(ctx);
  try {
    appendEvent(db, {
      projectId,
      type: "TMUX_SESSION_ATTACHED",
      summary: `Attached to ${status.sessionName}`,
    });
  } finally {
    closeDatabase(db);
  }
  await attachSession(status.sessionName, ctx.env);
}

export async function captureRole(ctx: DemoContext, role: AgentRole): Promise<string> {
  const status = await reconcileDemo(ctx);
  const execution = status.executions.find((row) => row.agentId === role);
  if (!execution?.tmuxPaneId) return "";
  return capturePane(execution.tmuxPaneId, ctx.env);
}
