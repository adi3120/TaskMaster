#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface MockAgentOptions {
  role: string;
  intervalMs: number;
  crash: boolean;
  exitCode: number | null;
  steps: number;
}

export function parseMockArgs(argv: string[]): MockAgentOptions {
  let role = "agent";
  let intervalMs = 1000;
  let crash = false;
  let exitCode: number | null = null;
  let steps = 4;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--role") role = argv[++i] ?? role;
    else if (arg === "--interval") intervalMs = Number(argv[++i] ?? intervalMs);
    else if (arg === "--crash") crash = true;
    else if (arg === "--exit") exitCode = Number(argv[++i] ?? 0);
    else if (arg === "--steps") steps = Number(argv[++i] ?? steps);
  }
  if (!Number.isFinite(intervalMs) || intervalMs < 10) intervalMs = 1000;
  if (!Number.isFinite(steps) || steps < 1) steps = 4;
  return { role, intervalMs, crash, exitCode, steps };
}

export function mockLine(role: string, step: number): string {
  if (step === 0) return `[${role}] starting`;
  if (step === 1) return `[${role}] inspecting project`;
  if (step < 4) return `[${role}] working step ${step - 1}`;
  return `[${role}] idle`;
}

export function runMockAgent(options: MockAgentOptions, out: (line: string) => void = (line) => console.log(line)): void {
  let step = 0;
  out(mockLine(options.role, 0));
  const timer = setInterval(() => {
    step += 1;
    out(mockLine(options.role, step));
    if (options.crash && step >= 3) {
      out(`[${options.role}] crashing`);
      clearInterval(timer);
      process.exit(1);
    }
    if (options.exitCode !== null && step >= options.steps) {
      clearInterval(timer);
      process.exit(options.exitCode);
    }
  }, options.intervalMs);

  const stop = (code: number, line: string) => {
    clearInterval(timer);
    out(line);
    process.exit(code);
  };
  process.on("SIGTERM", () => stop(0, `[${options.role}] stopping`));
  process.on("SIGINT", () => stop(130, `[${options.role}] interrupted`));
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entry === fileURLToPath(import.meta.url)) {
  runMockAgent(parseMockArgs(process.argv.slice(2)));
}
