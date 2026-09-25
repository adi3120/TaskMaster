import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../src/cli.ts";
import { captureRole, formatDemoStatus, startDemo, stopDemo } from "../src/demo.ts";
import { nextLifecycle } from "../src/lifecycle.ts";
import { parseMockArgs } from "../src/mock-agent.ts";
import { parsePaneList, sessionNameForProject } from "../src/tmux.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe("lifecycle", () => {
  it("moves from starting to running, exited, or crashed from pane probes", () => {
    expect(nextLifecycle("STARTING", { dead: false, exitCode: null, pid: 10 })).toBe("RUNNING");
    expect(nextLifecycle("RUNNING", { dead: true, exitCode: 0, pid: 10 })).toBe("EXITED");
    expect(nextLifecycle("RUNNING", { dead: true, exitCode: 1, pid: 10 })).toBe("CRASHED");
    expect(nextLifecycle("RESTARTING", { dead: false, exitCode: null, pid: 11 })).toBe("RUNNING");
    expect(nextLifecycle("CRASHED", { dead: true, exitCode: 1, pid: null })).toBe("CRASHED");
  });

  it("formats status from stored lifecycle", () => {
    const text = formatDemoStatus({
      projectName: "demo",
      projectRoot: "/tmp/demo",
      sessionName: "taskmaster-demo",
      sessionActive: true,
      events: [],
      executions: [
        execution("planner", "RUNNING"),
        execution("builder", "CRASHED"),
        execution("tester", "RUNNING"),
        execution("validator", "RUNNING"),
        execution("documenter", "RUNNING"),
      ],
    });
    expect(text).toContain("planner       running");
    expect(text).toContain("builder       crashed");
    expect(text).toContain("taskmaster-demo");
  });
});

describe("mock agent", () => {
  it("parses crash and exit options", () => {
    expect(parseMockArgs(["--role", "builder", "--crash", "--interval", "20"])).toMatchObject({
      role: "builder",
      crash: true,
      intervalMs: 20,
    });
  });

  it("exits 0 after the requested steps", async () => {
    const script = path.join(process.cwd(), "src/mock-agent.ts");
    const result = await runNode([script, "--role", "planner", "--exit", "0", "--steps", "1", "--interval", "30"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("[planner] starting");
    expect(result.stdout).toContain("[planner] inspecting project");
  });

  it("exits nonzero when asked to crash", async () => {
    const script = path.join(process.cwd(), "src/mock-agent.ts");
    const result = await runNode([script, "--role", "builder", "--crash", "--interval", "30"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("[builder] crashing");
  });
});

describe("tmux pane parser", () => {
  it("reads dead state and exit code without using pane text", () => {
    const panes = parsePaneList("%1\tplanner\t1\t1\t42\tagents\n%2\tbuilder\t0\t\t43\tagents");
    expect(panes[0]).toMatchObject({ paneId: "%1", dead: true, exitCode: 1, pid: 42 });
    expect(panes[1]).toMatchObject({ paneId: "%2", dead: false, exitCode: null, pid: 43 });
  });

  it("keeps a stable session name", () => {
    expect(sessionNameForProject("Task Master")).toBe("taskmaster-task-master");
    expect(sessionNameForProject("Task Master")).toBe(sessionNameForProject("task master"));
  });
});

describe("demo tmux integration", () => {
  it("creates, reuses, crashes, restarts, and cleans a session", async () => {
    const available = await new Promise<boolean>((resolve) => {
      execFile("tmux", ["-V"], (error) => resolve(!error));
    });
    if (!available) return;

    const home = await tempDir("taskmaster-home-");
    const cwd = await tempDir("taskmaster-project-");
    const socketDir = path.join(process.cwd(), ".tmp-tmux-test");
    await fs.mkdir(socketDir, { recursive: true });
    tempDirs.push(socketDir);
    const projectLabel = path.basename(cwd);
    const env = {
      ...process.env,
      TASKMASTER_HOME: home,
      TASKMASTER_NO_ATTACH: "1",
      TMUX_TMPDIR: socketDir,
    };
    const ctx = { cwd, env, attach: false as const };

    try {
      const started = await startDemo(ctx);
      expect(started.sessionName).toBe(sessionNameForProject(projectLabel));
      expect(started.sessionActive).toBe(true);
      expect(started.executions.map((row) => row.agentId).sort()).toEqual([
        "builder",
        "documenter",
        "planner",
        "tester",
        "validator",
      ]);
      await waitFor(async () => {
        const text = await captureRole(ctx, "planner");
        return text.includes("[planner] starting");
      });

      const again = await startDemo(ctx);
      const created = again.events.filter((event) => event.type === "TMUX_SESSION_CREATED");
      expect(created).toHaveLength(1);
      expect(await sessionCount(env, started.sessionName)).toBe(1);

      let crashed = "";
      const crashCode = await main(["demo", "crash", "builder"], {
        cwd,
        env,
        stdout: (text) => {
          crashed += text;
        },
        stderr: (text) => {
          crashed += text;
        },
      });
      expect(crashCode).toBe(0);
      expect(crashed).toContain("builder       crashed");
      expect(again.events.concat().some((event) => event.type === "AGENT_CRASHED") || crashed.includes("crashed")).toBe(true);

      let restarted = "";
      const restartCode = await main(["demo", "restart", "builder"], {
        cwd,
        env,
        stdout: (text) => {
          restarted += text;
        },
        stderr: (text) => {
          restarted += text;
        },
      });
      expect(restartCode).toBe(0);
      await waitFor(async () => restarted.includes("builder       running") || (await captureRole(ctx, "builder")).includes("[builder] starting"));
      const after = await startDemo(ctx);
      const builder = after.executions.find((row) => row.agentId === "builder");
      expect(builder?.restartCount).toBeGreaterThanOrEqual(1);
      expect(after.events.some((event) => event.type === "AGENT_RESTARTED")).toBe(true);
      expect(after.events.some((event) => event.type === "AGENT_PANE_CREATED")).toBe(true);
      expect(await sessionCount(env, started.sessionName)).toBe(1);
    } finally {
      await stopDemo(ctx).catch(() => undefined);
      expect(await sessionCount(env, sessionNameForProject(projectLabel))).toBe(0);
    }
  }, 30000);
});

function execution(agentId: "planner" | "builder" | "tester" | "validator" | "documenter", lifecycle: "RUNNING" | "CRASHED") {
  return {
    id: agentId,
    projectId: "p",
    agentId,
    lifecycle,
    tmuxSession: "taskmaster-demo",
    tmuxWindow: "agents",
    tmuxPaneId: "%1",
    command: "mock",
    pid: 1,
    startedAt: null,
    exitedAt: null,
    exitCode: null,
    restartCount: 0,
    updatedAt: new Date().toISOString(),
  };
}

function runNode(args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, ["--experimental-strip-types", ...args], (error, stdout, stderr) => {
      const status = (error as { status?: number } | null)?.status ?? (error ? 1 : 0);
      resolve({ code: status, stdout: `${stdout}\n${stderr}` });
    });
  });
}

function sessionCount(env: NodeJS.ProcessEnv, name: string): Promise<number> {
  return new Promise((resolve) => {
    execFile("tmux", ["list-sessions", "-F", "#{session_name}"], { env }, (error, stdout) => {
      if (error) {
        resolve(0);
        return;
      }
      resolve(stdout.split("\n").filter((line) => line.trim() === name).length);
    });
  });
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 5000) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("timed out waiting for demo condition");
}
