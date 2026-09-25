import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PLANNER_OPENCODE_MODEL, requirePlannerOpenCodeModel, type TaskMasterConfig } from "../src/config.ts";
import { closeDatabase, openDatabase } from "../src/db.ts";
import { listEvents } from "../src/events.ts";
import { buildOpenCodeRunCommand } from "../src/opencode-command.ts";
import { buildPlannerPrompt, loadPlannerSkill } from "../src/planner-prompt.ts";
import { runPlanner } from "../src/planner-run.ts";
import { getRun } from "../src/runs.ts";
import { stopDemo } from "../src/demo.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("planner command", () => {
  it("builds an OpenCode command with the explicit planner model", async () => {
    const skill = await loadPlannerSkill();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "taskmaster-prompt-"));
    tempDirs.push(root);
    const prompt = await buildPlannerPrompt({ goal: "Build Tic Tac Toe", root, skill });
    expect(prompt).toContain("Build Tic Tac Toe");
    expect(prompt).toContain("builder, tester, validator, documenter");
    expect(prompt).toContain(".taskmaster/inbox/plan.json");
    const command = buildOpenCodeRunCommand({
      bin: "opencode",
      model: PLANNER_OPENCODE_MODEL,
      prompt,
    });
    expect(command).toContain("--model");
    expect(command).toContain(PLANNER_OPENCODE_MODEL);
    expect(command).not.toContain("--continue");
    expect(command).not.toContain("--session");
  });

  it("fails before launch when the planner model is missing", () => {
    const config: TaskMasterConfig = {
      version: 1,
      enabledRuntimes: ["opencode"],
      agents: { planner: { runtime: "opencode", model: "" } },
    };
    expect(() => requirePlannerOpenCodeModel(config)).toThrow(/Planner OpenCode model is not configured/);
  });
});

describe("mocked planner runtime", () => {
  it("persists a validated plan and the planner run", async () => {
    if (!(await tmuxAvailable())) return;
    const home = await temp("taskmaster-home-");
    const repo = await temp("taskmaster-repo-");
    const socketDir = "/tmp/tm-planner-test";
    await fs.mkdir(socketDir, { recursive: true });
    tempDirs.push(socketDir);
    await exec("git", ["init"], repo);
    const fake = path.join(repo, "fake-opencode.mjs");
    await fs.writeFile(fake, fakeOpenCode("valid"));
    await fs.chmod(fake, 0o755);
    const env = envFor(home, fake, socketDir);
    try {
      const result = await runPlanner({ cwd: repo, env, attach: false }, "Build a minimal browser Tic Tac Toe game");
      expect(result.model).toBe(PLANNER_OPENCODE_MODEL);
      expect(result.summary).toContain("Plan valid: yes");
      expect(result.tasks[0]?.tempId).toBe("scaffold");
      expect(result.tasks[0]?.taskId).not.toBe("scaffold");
      expect(result.builder?.verified).toBe(true);
      const written = await fs.readFile(path.join(repo, "index.html"), "utf8");
      expect(written).toContain("tic tac toe");
      const db = openDatabase(path.join(home, "state.sqlite"));
      try {
        const run = getRun(db, result.runId);
        expect(run.model).toBe(PLANNER_OPENCODE_MODEL);
        expect(run.status).toBe("completed");
        const types = listEvents(db, { projectId: run.projectId ?? "", limit: 40 }).map((event) => event.type);
        for (const type of ["PLAN_REQUESTED", "PLAN_GENERATED", "PLAN_VALIDATED", "PLAN_PERSISTED", "RUN_STARTED", "RUNTIME_STARTED", "RUN_COMPLETED", "TASK_CREATED"]) {
          expect(types).toContain(type);
        }
      } finally {
        closeDatabase(db);
      }
    } finally {
      await stopDemo({ cwd: repo, env, attach: false }).catch(() => undefined);
    }
  }, 30000);

  it("rejects malformed planner output without inserting tasks", async () => {
    if (!(await tmuxAvailable())) return;
    const home = await temp("taskmaster-home-");
    const repo = await temp("taskmaster-repo-");
    const socketDir = "/tmp/tm-planner-bad";
    await fs.mkdir(socketDir, { recursive: true });
    tempDirs.push(socketDir);
    await exec("git", ["init"], repo);
    const fake = path.join(repo, "fake-opencode.mjs");
    await fs.writeFile(fake, fakeOpenCode("invalid"));
    await fs.chmod(fake, 0o755);
    const env = envFor(home, fake, socketDir);
    env.TASKMASTER_PLAN_ONLY = "1";
    try {
      await expect(runPlanner({ cwd: repo, env, attach: false }, "Build Tic Tac Toe")).rejects.toThrow(/invalid plan/);
      const db = openDatabase(path.join(home, "state.sqlite"));
      try {
        const count = db.prepare("SELECT COUNT(*) AS count FROM tasks").get() as { count: number };
        expect(count.count).toBe(0);
        const types = listEvents(db, { limit: 20 }).map((event) => event.type);
        expect(types).toContain("PLAN_REJECTED");
        expect(types).toContain("RUN_FAILED");
        const run = db.prepare("SELECT model, status FROM runs").get() as { model: string; status: string };
        expect(run.model).toBe(PLANNER_OPENCODE_MODEL);
        expect(run.status).toBe("failed");
      } finally {
        closeDatabase(db);
      }
    } finally {
      await stopDemo({ cwd: repo, env, attach: false }).catch(() => undefined);
    }
  }, 30000);
});

function envFor(home: string, fake: string, socketDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    TASKMASTER_HOME: home,
    TASKMASTER_NO_ATTACH: "1",
    TASKMASTER_OPENCODE_BIN: fake,
    TASKMASTER_RUN_TIMEOUT_MS: "15000",
    TMUX_TMPDIR: socketDir,
  };
}

function fakeOpenCode(mode: "valid" | "invalid"): string {
  return `#!/usr/bin/env node
const args = process.argv.slice(2);
if (!args.includes("--model")) process.exit(2);
const prompt = args.at(-1) ?? "";
const fs = await import("node:fs");
const path = await import("node:path");
if (prompt.includes(".taskmaster/inbox/plan.json")) {
  const file = path.join(process.cwd(), ".taskmaster/inbox/plan.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = ${mode === "valid" ? "JSON.stringify(plan())" : JSON.stringify("not json")};
  fs.writeFileSync(file, body);
  process.exit(0);
}
fs.writeFileSync(path.join(process.cwd(), "index.html"), "<p>tic tac toe</p>\\n");
process.exit(0);
function plan() {
  return {
    version: 1,
    projectSummary: "A one-page game",
    architecture: { summary: "One html file", decisions: ["No build step"] },
    tasks: [
      { tempId: "scaffold", title: "Scaffold application", description: "Add index.html", agent: "builder", dependencies: [], acceptanceCriteria: ["index.html exists"] },
      { tempId: "tests", title: "Add tests", description: "Check the page", agent: "tester", dependencies: ["scaffold"], acceptanceCriteria: ["A check exists"] }
    ]
  };
}
`;
}

function tmuxAvailable(): Promise<boolean> {
  return new Promise((resolve) => execFile("tmux", ["-V"], (error) => resolve(!error)));
}

async function temp(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function exec(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd }, (error, _stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolve();
    });
  });
}
