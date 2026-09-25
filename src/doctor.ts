import type { RuntimeReport, RuntimeStatus } from "./runtimes/detect.js";
import { detectRuntimes, createHostProbe } from "./runtimes/detect.js";
import { detectProject, upsertProject } from "./project.js";
import { ensureHome, taskmasterHome, databasePath } from "./paths.js";
import { loadConfig } from "./config.js";
import { closeDatabase, openDatabase, restrictDatabaseFile } from "./db.js";
import { checkCommand } from "./system.js";
import { detectTmux } from "./tmux.js";

export interface DoctorLine {
  label: string;
  mark: "ok" | "missing" | "error";
  detail: string;
}

export interface DoctorReport {
  projectName: string | null;
  projectRoot: string | null;
  home: string;
  lines: DoctorLine[];
  ok: boolean;
}

const LABEL_WIDTH = 12;

export function formatDoctorReport(report: DoctorReport): string {
  const project = report.projectName
    ? `${report.projectName} (${report.projectRoot})`
    : "(not a git repository)";
  const body = report.lines.map((line) => formatLine(line)).join("\n");
  return [`TaskMaster doctor`, ``, `Project  ${project}`, `State    ${report.home}`, ``, body, ``].join("\n");
}

export function formatLine(line: DoctorLine): string {
  const symbol = line.mark === "ok" ? "✓" : line.mark === "missing" ? "○" : "✗";
  const detail = line.detail ? ` ${line.detail}` : "";
  return `${line.label.padEnd(LABEL_WIDTH)} ${symbol}${detail}`;
}

export function runtimeLine(report: RuntimeReport): DoctorLine {
  switch (report.status as RuntimeStatus) {
    case "INSTALLED_AUTHENTICATED":
      return { label: report.label, mark: "ok", detail: "authenticated" };
    case "INSTALLED_UNAUTHENTICATED":
      return { label: report.label, mark: "ok", detail: "installed" };
    case "NOT_INSTALLED":
      return { label: report.label, mark: "missing", detail: "unavailable" };
    case "ERROR":
      return { label: report.label, mark: "error", detail: report.detail ?? "error" };
  }
}

export async function runDoctor(input: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<DoctorReport> {
  const env = input.env ?? process.env;
  const cwd = input.cwd ?? process.cwd();
  const home = taskmasterHome(env);
  await ensureHome(home);
  await loadConfig(home);
  const dbFile = databasePath(home);
  const db = openDatabase(dbFile);
  let projectName: string | null = null;
  let projectRoot: string | null = null;
  try {
    const project = await detectProject(cwd);
    if (project) {
      upsertProject(db, project);
      projectName = project.name;
      projectRoot = project.root;
    }
  } finally {
    closeDatabase(db);
    await restrictDatabaseFile(dbFile);
  }

  const [tmux, git, runtimes] = await Promise.all([
    detectTmux(),
    checkCommand("git", ["--version"]),
    detectRuntimes(createHostProbe(env)),
  ]);

  const lines: DoctorLine[] = [
    tmux.ok
      ? { label: "tmux", mark: "ok", detail: "" }
      : { label: "tmux", mark: "error", detail: tmux.error ?? "unavailable" },
    git.ok
      ? { label: "git", mark: "ok", detail: "" }
      : { label: "git", mark: "error", detail: git.error ?? "unavailable" },
    ...runtimes.map(runtimeLine),
  ];

  return {
    projectName,
    projectRoot,
    home,
    lines,
    ok: tmux.ok && git.ok,
  };
}
