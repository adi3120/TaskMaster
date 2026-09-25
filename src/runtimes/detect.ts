import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runProcess } from "../process/run-process.js";

export type RuntimeId = "cursor" | "codex" | "opencode" | "claude";

export type RuntimeStatus =
  | "INSTALLED_AUTHENTICATED"
  | "INSTALLED_UNAUTHENTICATED"
  | "NOT_INSTALLED"
  | "ERROR";

export interface RuntimeReport {
  id: RuntimeId;
  label: string;
  status: RuntimeStatus;
  command: string | null;
  detail: string | null;
}

export interface RuntimeProbe {
  resolve(command: string): Promise<string | null>;
  readFile(file: string): Promise<string | null>;
  env: NodeJS.ProcessEnv;
  homedir: string;
}

const EXECUTABLE = new Set(["agent", "cursor-agent", "codex", "opencode", "claude"]);

export async function resolveOnPath(command: string, pathEnv: string): Promise<string | null> {
  if (!EXECUTABLE.has(command)) return null;
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

export function createHostProbe(env: NodeJS.ProcessEnv = process.env): RuntimeProbe {
  return {
    env,
    homedir: os.homedir(),
    resolve: (command) => resolveOnPath(command, env.PATH ?? ""),
    async readFile(file: string) {
      try {
        return await fs.readFile(file, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
  };
}

function envPresent(env: NodeJS.ProcessEnv, key: string): boolean {
  return typeof env[key] === "string" && env[key].trim().length > 0;
}

export function cursorAuthPresent(raw: string | null): boolean {
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as { authInfo?: Record<string, unknown> };
    const info = parsed.authInfo;
    if (!info || typeof info !== "object") return false;
    const email = typeof info.email === "string" && info.email.trim().length > 0;
    const displayName = typeof info.displayName === "string" && info.displayName.trim().length > 0;
    const userId = typeof info.userId === "number";
    return email || displayName || userId;
  } catch {
    return false;
  }
}

export function codexAuthPresent(raw: string | null): boolean {
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const tokens = parsed.tokens;
    const tokenRecord =
      typeof tokens === "object" && tokens !== null ? (tokens as Record<string, unknown>) : {};
    const fields = [parsed.OPENAI_API_KEY, parsed.accessToken, tokenRecord.access_token, tokenRecord.refresh_token];
    return fields.some((value) => typeof value === "string" && value.length > 0);
  } catch {
    return false;
  }
}

export function credentialObjectPresent(raw: string | null): boolean {
  if (!raw || raw.trim().length === 0) return false;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) && Object.keys(parsed).length > 0;
  } catch {
    return false;
  }
}

async function versionLooksLike(command: string, pattern: RegExp): Promise<boolean> {
  const result = await runProcess({ command, args: ["--version"], timeoutSec: 8, graceSec: 1 });
  const text = `${result.stdout}\n${result.stderr}`;
  if (result.timedOut) throw new Error(`${command} version probe timed out`);
  return pattern.test(text) || (result.exitCode ?? 1) === 0;
}

async function detectCursor(probe: RuntimeProbe): Promise<RuntimeReport> {
  const agent = await probe.resolve("agent");
  const cursorAgent = await probe.resolve("cursor-agent");
  const command = cursorAgent ?? agent;
  if (!command) {
    return { id: "cursor", label: "Cursor", status: "NOT_INSTALLED", command: null, detail: null };
  }
  const pathHint = /cursor/i.test(command);
  let identified = pathHint || Boolean(cursorAgent);
  if (!identified && agent) {
    identified = await versionLooksLike(agent, /cursor/i);
  }
  if (!identified) {
    return { id: "cursor", label: "Cursor", status: "NOT_INSTALLED", command: null, detail: null };
  }
  const authed =
    envPresent(probe.env, "CURSOR_API_KEY") ||
    cursorAuthPresent(await probe.readFile(path.join(probe.homedir, ".cursor", "cli-config.json")));
  return {
    id: "cursor",
    label: "Cursor",
    status: authed ? "INSTALLED_AUTHENTICATED" : "INSTALLED_UNAUTHENTICATED",
    command,
    detail: null,
  };
}

async function detectBinaryLane(
  probe: RuntimeProbe,
  input: {
    id: Exclude<RuntimeId, "cursor">;
    label: string;
    command: string;
    authenticated: (probe: RuntimeProbe) => Promise<boolean>;
  },
): Promise<RuntimeReport> {
  const command = await probe.resolve(input.command);
  if (!command) {
    return { id: input.id, label: input.label, status: "NOT_INSTALLED", command: null, detail: null };
  }
  const authed = await input.authenticated(probe);
  return {
    id: input.id,
    label: input.label,
    status: authed ? "INSTALLED_AUTHENTICATED" : "INSTALLED_UNAUTHENTICATED",
    command,
    detail: null,
  };
}

export async function detectRuntimes(probe: RuntimeProbe = createHostProbe()): Promise<RuntimeReport[]> {
  const jobs: Array<Promise<RuntimeReport>> = [
    detectCursor(probe),
    detectBinaryLane(probe, {
      id: "codex",
      label: "Codex",
      command: "codex",
      authenticated: async (current) =>
        envPresent(current.env, "OPENAI_API_KEY") ||
        codexAuthPresent(await current.readFile(path.join(current.homedir, ".codex", "auth.json"))),
    }),
    detectBinaryLane(probe, {
      id: "opencode",
      label: "OpenCode",
      command: "opencode",
      authenticated: async (current) => {
        if (["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY"].some((key) => envPresent(current.env, key))) {
          return true;
        }
        const dataHome = current.env.XDG_DATA_HOME || path.join(current.homedir, ".local", "share");
        return credentialObjectPresent(await current.readFile(path.join(dataHome, "opencode", "auth.json")));
      },
    }),
    detectBinaryLane(probe, {
      id: "claude",
      label: "Claude",
      command: "claude",
      authenticated: async (current) => {
        if (envPresent(current.env, "ANTHROPIC_API_KEY") || envPresent(current.env, "CLAUDE_CODE_OAUTH_TOKEN")) {
          return true;
        }
        const dir = current.env.CLAUDE_CONFIG_DIR || path.join(current.homedir, ".claude");
        const primary = await current.readFile(path.join(dir, ".credentials.json"));
        const secondary = await current.readFile(path.join(dir, "credentials.json"));
        return credentialObjectPresent(primary) || credentialObjectPresent(secondary);
      },
    }),
  ];
  const reports = await Promise.all(
    jobs.map(async (job) => {
      try {
        return await job;
      } catch (error) {
        return null;
      }
    }),
  );
  return Promise.all(
    (["cursor", "codex", "opencode", "claude"] as const).map(async (id, index) => {
      const report = reports[index];
      if (report) return report;
      const label = id === "cursor" ? "Cursor" : id === "codex" ? "Codex" : id === "opencode" ? "OpenCode" : "Claude";
      return {
        id,
        label,
        status: "ERROR" as const,
        command: null,
        detail: "runtime probe failed",
      };
    }),
  );
}

export async function testExecution(command: string): Promise<{ ok: boolean; detail: string }> {
  const result = await runProcess({ command, args: ["--version"], timeoutSec: 8, graceSec: 1 });
  if (result.timedOut) return { ok: false, detail: "timed out" };
  if ((result.exitCode ?? 1) !== 0) return { ok: false, detail: `exit ${result.exitCode ?? "null"}` };
  return { ok: true, detail: (result.stdout || result.stderr).trim().split("\n")[0] ?? "ok" };
}
