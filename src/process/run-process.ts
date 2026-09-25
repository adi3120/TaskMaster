/**
 * Local child-process runner.
 *
 * Adapted from Paperclip `runChildProcess` and `signalRunningProcess` in
 * packages/adapter-utils/src/server-utils.ts
 * (https://github.com/paperclipai/paperclip @ e2f1a66aa7a243bbcbad307bf6ba6a377928d542).
 * MIT License, Copyright (c) 2025 Paperclip AI. See NOTICE.
 *
 * This subset spawns a local command, streams stdout/stderr, caps capture,
 * and enforces timeout with SIGTERM then SIGKILL. Remote execution, sandboxes,
 * and terminal-result cleanup are omitted.
 */
import { spawn, type ChildProcess } from "node:child_process";

const MAX_CAPTURE_CHARS = 1024 * 1024;

const CLAUDE_CODE_NESTING_VARS = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION",
  "CLAUDE_CODE_PARENT_SESSION",
] as const;

export interface RunProcessResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  pid: number | null;
}

export interface RunProcessOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutSec?: number;
  graceSec?: number;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => void;
}

export function appendWithCap(prev: string, chunk: string, cap = MAX_CAPTURE_CHARS): string {
  const combined = prev + chunk;
  return combined.length > cap ? combined.slice(combined.length - cap) : combined;
}

function signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (process.platform !== "win32" && typeof pid === "number" && pid > 0) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Fall back to the direct child if the process group is already gone.
    }
  }
  child.kill(signal);
}

export function runProcess(options: RunProcessOptions): Promise<RunProcessResult> {
  const timeoutSec = options.timeoutSec ?? 30;
  const graceSec = options.graceSec ?? 2;
  const env: NodeJS.ProcessEnv = { ...process.env, ...options.env };
  for (const key of CLAUDE_CODE_NESTING_VARS) delete env[key];

  return new Promise((resolve, reject) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env,
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timeout =
      timeoutSec > 0
        ? setTimeout(() => {
            timedOut = true;
            signalChild(child, "SIGTERM");
            setTimeout(() => signalChild(child, "SIGKILL"), Math.max(1, graceSec) * 1000);
          }, timeoutSec * 1000)
        : null;

    child.stdout?.on("data", (chunk: Buffer | string) => {
      const text = String(chunk);
      stdout = appendWithCap(stdout, text);
      options.onLog?.("stdout", text);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = String(chunk);
      stderr = appendWithCap(stderr, text);
      options.onLog?.("stderr", text);
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      const message =
        error.code === "ENOENT"
          ? `Failed to start command "${options.command}".`
          : `Failed to start command "${options.command}": ${error.message}`;
      reject(new Error(message));
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve({
        exitCode: code,
        signal,
        timedOut,
        stdout,
        stderr,
        pid: child.pid ?? null,
      });
    });
  });
}
