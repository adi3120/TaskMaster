import { execFile } from "node:child_process";
import { runProcess } from "./process/run-process.js";

export interface CommandCheck {
  ok: boolean;
  version: string | null;
  error?: string;
}

export async function checkCommand(command: string, args: string[]): Promise<CommandCheck> {
  try {
    const result = await runProcess({
      command,
      args,
      timeoutSec: 8,
      graceSec: 1,
    });
    if (result.timedOut) {
      return { ok: false, version: null, error: `${command} timed out` };
    }
    if ((result.exitCode ?? 1) !== 0) {
      return {
        ok: false,
        version: null,
        error: `${command} exited ${result.exitCode ?? "null"}`,
      };
    }
    const version = (result.stdout || result.stderr).trim().split("\n")[0] ?? "";
    return { ok: true, version: version || null };
  } catch (error) {
    return {
      ok: false,
      version: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function detectGitRoot(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["rev-parse", "--show-toplevel"],
      { cwd },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        const root = stdout.trim();
        resolve(root.length > 0 ? root : null);
      },
    );
  });
}
