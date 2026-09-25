import { execFile } from "node:child_process";
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

function tmux(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("tmux", args, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }
      resolve();
    });
  });
}

export async function hasSession(session: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("tmux", ["has-session", "-t", session], (error) => {
      resolve(!error);
    });
  });
}

export async function createDetachedSession(session: string): Promise<void> {
  if (await hasSession(session)) return;
  await tmux(newSessionArgs(session));
}

export async function killSession(session: string): Promise<void> {
  if (!(await hasSession(session))) return;
  await tmux(killSessionArgs(session));
}
