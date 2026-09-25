import { execFile, spawn } from "node:child_process";
import { AGENT_ROLES, type AgentRole } from "./db.js";
import type { PaneLiveness } from "./lifecycle.js";
import { checkCommand } from "./system.js";

export function sessionNameForProject(projectName: string): string {
  const slug = projectName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `taskmaster-${slug || "project"}`;
}

export function newSessionArgs(session: string): string[] {
  return ["new-session", "-d", "-s", session, "-n", "status"];
}

export function killSessionArgs(session: string): string[] {
  return ["kill-session", "-t", session];
}

export async function detectTmux(): Promise<{ ok: boolean; version: string | null; error?: string }> {
  const result = await checkCommand("tmux", ["-V"]);
  return { ok: result.ok, version: result.version, error: result.error };
}

function tmux(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  return tmuxEnv(args, env);
}

export async function hasSession(session: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("tmux", ["has-session", "-t", session], { env }, (error) => {
      resolve(!error);
    });
  });
}

export async function createDetachedSession(session: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (await hasSession(session, env)) return;
  await tmux(newSessionArgs(session), env);
}

export async function killSession(session: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!(await hasSession(session, env))) return;
  await tmux(killSessionArgs(session), env);
}

export interface PaneSnapshot extends PaneLiveness {
  paneId: string;
  title: string;
  windowName: string;
}

export interface DemoLayout {
  planner: string;
  builder: string;
  tester: string;
  validator: string;
  documenter: string;
  log: string;
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function tmuxText(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("tmux", args, { env }, (error, stdout, stderr) => {
      const text = stdout.trim();
      if (error || (!text && stderr.trim())) {
        reject(new Error((stderr || stdout).trim() || error?.message || "tmux failed"));
        return;
      }
      resolve(text);
    });
  });
}

function tmuxEnv(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("tmux", args, { env }, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }
      resolve();
    });
  });
}

export function parsePaneList(text: string): PaneSnapshot[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [paneId = "", title = "", dead = "0", status = "", pid = "", windowName = ""] = line.split("\t");
      const exitCode = status.trim().length > 0 && status !== "" ? Number(status) : null;
      return {
        paneId,
        title,
        windowName,
        dead: dead === "1",
        exitCode: exitCode !== null && Number.isFinite(exitCode) ? exitCode : null,
        pid: Number(pid) > 0 ? Number(pid) : null,
      };
    });
}

async function paneId(args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  const id = await tmuxText(args, env);
  if (!id.startsWith("%")) throw new Error(`tmux did not return a pane id: ${id}`);
  return id;
}

export async function createDemoLayout(session: string, env: NodeJS.ProcessEnv = process.env): Promise<DemoLayout> {
  const planner = await paneId(
    ["new-session", "-d", "-s", session, "-n", "agents", "-x", "220", "-y", "50", "-P", "-F", "#{pane_id}"],
    env,
  );
  const builder = await paneId(["split-window", "-h", "-t", planner, "-P", "-F", "#{pane_id}"], env);
  const tester = await paneId(["split-window", "-v", "-t", planner, "-P", "-F", "#{pane_id}"], env);
  const validator = await paneId(["split-window", "-v", "-t", builder, "-P", "-F", "#{pane_id}"], env);
  const documenter = await paneId(
    ["new-window", "-d", "-t", session, "-n", "support", "-P", "-F", "#{pane_id}"],
    env,
  );
  const log = await paneId(["split-window", "-h", "-t", documenter, "-P", "-F", "#{pane_id}"], env);
  const layout: DemoLayout = { planner, builder, tester, validator, documenter, log };
  for (const role of AGENT_ROLES) {
    await tmuxEnv(["select-pane", "-t", layout[role], "-T", role], env);
  }
  await tmuxEnv(["select-pane", "-t", log, "-T", "taskmaster-log"], env);
  for (const window of ["agents", "support"]) {
    await tmuxEnv(["set-window-option", "-t", `${session}:${window}`, "pane-border-status", "top"], env);
    await tmuxEnv(["set-window-option", "-t", `${session}:${window}`, "pane-border-format", " #{pane_title} "], env);
    await tmuxEnv(["set-window-option", "-t", `${session}:${window}`, "remain-on-exit", "on"], env);
  }
  await resizeWindow(`${session}:agents`, 220, 50, env);
  await resizeWindow(`${session}:support`, 220, 50, env);
  await tmuxEnv(["select-window", "-t", `${session}:agents`], env);
  return layout;
}

export async function listPanes(session: string, env: NodeJS.ProcessEnv = process.env): Promise<PaneSnapshot[]> {
  const text = await tmuxText(
    ["list-panes", "-s", "-t", session, "-F", "#{pane_id}\t#{pane_title}\t#{pane_dead}\t#{pane_dead_status}\t#{pane_pid}\t#{window_name}"],
    env,
  );
  return parsePaneList(text);
}

export async function selectPaneTitle(paneIdValue: string, title: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await tmuxEnv(["select-pane", "-t", paneIdValue, "-T", title], env);
}

export async function resizeWindow(
  target: string,
  width: number,
  height: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await tmuxEnv(["resize-window", "-t", target, "-x", String(width), "-y", String(height)], env);
}

export async function respawnPane(
  paneIdValue: string,
  cwd: string,
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await tmuxEnv(["respawn-pane", "-k", "-c", cwd, "-t", paneIdValue, command], env);
}

export async function capturePane(paneIdValue: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return tmuxText(["capture-pane", "-p", "-t", paneIdValue, "-S", "-30"], env);
}

export function attachSession(session: string, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const args = process.env.TMUX ? ["switch-client", "-t", session] : ["attach-session", "-t", session];
  return new Promise((resolve, reject) => {
    const child = spawn("tmux", args, { env, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 0));
  });
}

export function paneForRole(layout: DemoLayout, role: AgentRole): string {
  return layout[role];
}
