#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
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
  taskmaster help

taskmaster and taskmaster doctor scan this machine and print lane status.
They do not start agents.
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
  if (command !== "doctor") {
    io.stderr(`Unknown command "${command}".\n\n${HELP}`);
    return 2;
  }
  try {
    const report = await runDoctor({ cwd: io.cwd, env: io.env });
    io.stdout(formatDoctorReport(report));
    return report.ok ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`taskmaster doctor failed: ${message}\n`);
    return 1;
  }
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entry === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}
