#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runBuilder } from "./builder-run.js";
import {
  attachDemo,
  crashAgent,
  formatDemoStatus,
  isAgentRole,
  reconcileDemo,
  restartAgent,
  startDemo,
  stopDemo,
} from "./demo.js";
import { formatDoctorReport, runDoctor } from "./doctor.js";

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

const HELP = `TaskMaster

Usage
  taskmaster
  taskmaster doctor
  taskmaster demo
  taskmaster status
  taskmaster attach
  taskmaster demo status
  taskmaster demo restart <role>
  taskmaster demo crash <role>
  taskmaster demo stop
  taskmaster run --agent builder "Create FILE.md containing exactly: text"
  taskmaster help

taskmaster and taskmaster doctor scan this machine and print lane status.
taskmaster demo opens a tmux session. Planner, tester, validator, and documenter stay mocked.
taskmaster run replaces the builder pane with OpenCode and always passes --model.
Detach with the tmux prefix, then run taskmaster attach to return.
`;

export async function main(argv: string[], io: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
}): Promise<number> {
  const command = argv[0] ?? "doctor";
  if (command === "help" || command === "--help" || command === "-h") {
    io.stdout(HELP);
    return 0;
  }
  const cwd = io.cwd ?? process.cwd();
  const env = io.env ?? process.env;
  try {
    if (command === "doctor") {
      const report = await runDoctor({ cwd, env });
      io.stdout(formatDoctorReport(report));
      return report.ok ? 0 : 1;
    }
    if (command === "status") {
      io.stdout(formatDemoStatus(await reconcileDemo({ cwd, env })));
      return 0;
    }
    if (command === "attach") {
      await attachDemo({ cwd, env });
      return 0;
    }
    if (command === "demo") {
      return demoCommand(argv.slice(1), io, cwd, env);
    }
    if (command === "run") {
      return runCommand(argv.slice(1), io, cwd, env);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`taskmaster ${command} failed: ${message}\n`);
    return 1;
  }
  io.stderr(`Unknown command "${command}".\n\n${HELP}`);
  return 2;
}

async function runCommand(argv: string[], io: CliIo, cwd: string, env: NodeJS.ProcessEnv): Promise<number> {
  let agent = "";
  const words: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--agent") {
      agent = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    words.push(argv[index] ?? "");
  }
  const prompt = words.join(" ").trim();
  if (agent !== "builder") {
    io.stderr("Phase 3 runs the builder only. Planner, tester, validator, and documenter stay mocked.\n");
    return 2;
  }
  if (!prompt) {
    io.stderr("Usage: taskmaster run --agent builder \"prompt\"\n");
    return 2;
  }
  const result = await runBuilder({ cwd, env, attach: false }, prompt);
  io.stdout(
    `Builder run ${result.runId}\nmodel ${result.model}\ntmux ${result.sessionName}\nverified ${result.createdFile ?? "git change"}\n`,
  );
  return 0;
}

async function demoCommand(
  argv: string[],
  io: CliIo,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const sub = argv[0];
  const attach = Boolean(process.stdout.isTTY) && !env.TASKMASTER_NO_ATTACH;
  if (!sub) {
    const status = await startDemo({ cwd, env, attach });
    if (!attach) io.stdout(formatDemoStatus(status));
    return 0;
  }
  if (sub === "status") {
    io.stdout(formatDemoStatus(await reconcileDemo({ cwd, env })));
    return 0;
  }
  if (sub === "stop") {
    io.stdout(formatDemoStatus(await stopDemo({ cwd, env })));
    return 0;
  }
  if (sub === "restart" || sub === "crash") {
    const role = argv[1] ?? "";
    if (!isAgentRole(role)) {
      io.stderr(`Expected a role: planner, builder, tester, validator, documenter.\n`);
      return 2;
    }
    const status = sub === "restart"
      ? await restartAgent({ cwd, env }, role)
      : await crashAgent({ cwd, env }, role);
    io.stdout(formatDemoStatus(status));
    return 0;
  }
  io.stderr(`Unknown demo command "${sub}".\n\n${HELP}`);
  return 2;
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entry === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}
