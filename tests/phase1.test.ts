import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../src/cli.ts";
import { formatDoctorReport, runtimeLine, type DoctorReport } from "../src/doctor.ts";
import { openDatabase, closeDatabase } from "../src/db.ts";
import { appendEvent, listEvents } from "../src/events.ts";
import { FileSecretStore } from "../src/providers/secrets.ts";
import { addProvider, listProviders } from "../src/providers/registry.ts";
import { upsertProject } from "../src/project.ts";
import { claimTask, createTask, TaskClaimError } from "../src/tasks.ts";
import { runtimeSessionCodec } from "../src/sessions/codec.ts";
import { runProcess } from "../src/process/run-process.ts";
import {
  codexAuthPresent,
  credentialObjectPresent,
  cursorAuthPresent,
  detectRuntimes,
  type RuntimeProbe,
} from "../src/runtimes/detect.ts";
import { createDetachedSession, killSession, sessionNameForProject } from "../src/tmux.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "taskmaster-"));
  tempDirs.push(dir);
  return dir;
}

describe("doctor format", () => {
  it("renders lane status without a model call", () => {
    const report: DoctorReport = {
      projectName: "demo",
      projectRoot: "/tmp/demo",
      home: "/tmp/state",
      ok: true,
      lines: [
        { label: "tmux", mark: "ok", detail: "" },
        { label: "git", mark: "ok", detail: "" },
        runtimeLine({ id: "cursor", label: "Cursor", status: "INSTALLED_AUTHENTICATED", command: "agent", detail: null }),
        runtimeLine({ id: "codex", label: "Codex", status: "INSTALLED_AUTHENTICATED", command: "codex", detail: null }),
        runtimeLine({ id: "opencode", label: "OpenCode", status: "INSTALLED_UNAUTHENTICATED", command: "opencode", detail: null }),
        runtimeLine({ id: "claude", label: "Claude", status: "NOT_INSTALLED", command: null, detail: null }),
      ],
    };
    expect(formatDoctorReport(report)).toBe(
      [
        "TaskMaster doctor",
        "",
        "Project  demo (/tmp/demo)",
        "State    /tmp/state",
        "",
        "tmux         ✓",
        "git          ✓",
        "Cursor       ✓ authenticated",
        "Codex        ✓ authenticated",
        "OpenCode     ✓ installed",
        "Claude       ○ unavailable",
        "",
      ].join("\n"),
    );
  });
});

describe("cli", () => {
  it("runs doctor against a temp home", async () => {
    const home = await tempDir();
    let output = "";
    const code = await main(["doctor"], {
      stdout: (text) => {
        output += text;
      },
      stderr: (text) => {
        output += text;
      },
      cwd: process.cwd(),
      env: { ...process.env, TASKMASTER_HOME: home },
    });
    expect(code === 0 || code === 1).toBe(true);
    expect(output).toContain("TaskMaster doctor");
    expect(output).toMatch(/^tmux\s+[✓✗]/m);
    expect(output).toMatch(/^Cursor\s+[✓○✗]/m);
    expect(output).toMatch(/^Claude\s+[✓○✗]/m);
    const stat = await fs.stat(home);
    expect(stat.mode & 0o777).toBe(0o700);
  });

  it("rejects unknown commands", async () => {
    let error = "";
    const code = await main(["nope"], {
      stdout: () => undefined,
      stderr: (text) => {
        error += text;
      },
    });
    expect(code).toBe(2);
    expect(error).toContain("Unknown command");
  });
});

describe("tasks", () => {
  it("gives one task one owner", () => {
    const db = openDatabase(":memory:");
    const projectId = upsertProject(db, { name: "demo", root: "/tmp/demo" });
    createTask(db, { id: "TM-1", projectId, title: "Build", status: "READY" });
    const claimed = claimTask(db, "TM-1", "builder");
    expect(claimed.owner_agent_id).toBe("builder");
    expect(claimed.status).toBe("RUNNING");
    expect(claimTask(db, "TM-1", "builder").owner_agent_id).toBe("builder");
    expect(() => claimTask(db, "TM-1", "tester")).toThrow(TaskClaimError);
    closeDatabase(db);
  });
});

describe("events and providers", () => {
  it("stores events and provider refs without key material", () => {
    const db = openDatabase(":memory:");
    const projectId = upsertProject(db, { name: "demo", root: "/tmp/demo" });
    appendEvent(db, {
      projectId,
      agentId: "planner",
      type: "TASK_CREATED",
      summary: "Created the board",
      payload: { count: 1 },
    });
    expect(listEvents(db, { projectId })[0]?.type).toBe("TASK_CREATED");
    addProvider(db, {
      kind: "openrouter",
      label: "OpenRouter",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKeyRef: "openrouter-main",
    });
    expect(listProviders(db)[0]?.apiKeyRef).toBe("openrouter-main");
    closeDatabase(db);
  });
});

describe("secrets", () => {
  it("writes credential files as mode 0600", async () => {
    const dir = path.join(await tempDir(), "secrets");
    const store = new FileSecretStore(dir);
    await store.put("openrouter-main", "secret-value");
    expect(await store.get("openrouter-main")).toBe("secret-value");
    const stat = await fs.stat(path.join(dir, "openrouter-main"));
    expect(stat.mode & 0o777).toBe(0o600);
    expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
  });
});

describe("session codec", () => {
  it("keeps session id and cwd only", () => {
    const stored = runtimeSessionCodec.serialize({
      sessionId: "xyz",
      cwd: "/repo",
      token: "nope",
    });
    expect(stored).toEqual({ sessionId: "xyz", cwd: "/repo" });
    expect(runtimeSessionCodec.getDisplayId(stored)).toBe("xyz");
  });
});

describe("auth signals", () => {
  it("treats credential presence as authentication and ignores plan names", () => {
    expect(cursorAuthPresent(JSON.stringify({ authInfo: { email: "a@example.com" } }))).toBe(true);
    expect(codexAuthPresent(JSON.stringify({ tokens: { access_token: "present" } }))).toBe(true);
    expect(codexAuthPresent(JSON.stringify({ planType: "pro" }))).toBe(false);
    expect(credentialObjectPresent(JSON.stringify({ openai: { type: "api" } }))).toBe(true);
  });
});

describe("runtime detection", () => {
  it("classifies injected lanes", async () => {
    const files = new Map<string, string>([
      ["/home/.cursor/cli-config.json", JSON.stringify({ authInfo: { userId: 1 } })],
    ]);
    const probe: RuntimeProbe = {
      homedir: "/home",
      env: {},
      async resolve(command) {
        if (command === "cursor-agent") return "/opt/cursor/cursor-agent";
        if (command === "codex") return "/opt/bin/codex";
        if (command === "opencode") return "/opt/bin/opencode";
        return null;
      },
      async readFile(file) {
        return files.get(file) ?? null;
      },
    };
    const reports = await detectRuntimes(probe);
    expect(reports.map((report) => [report.label, report.status])).toEqual([
      ["Cursor", "INSTALLED_AUTHENTICATED"],
      ["Codex", "INSTALLED_UNAUTHENTICATED"],
      ["OpenCode", "INSTALLED_UNAUTHENTICATED"],
      ["Claude", "NOT_INSTALLED"],
    ]);
  });
});

describe("process runner", () => {
  it("captures stdout from a short command", async () => {
    const result = await runProcess({
      command: process.execPath,
      args: ["-e", "process.stdout.write('hello')"],
      timeoutSec: 5,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello");
    expect(result.timedOut).toBe(false);
  });
});

describe("tmux", () => {
  it("names a session from the project", () => {
    expect(sessionNameForProject("Task Master")).toBe("taskmaster-task-master");
  });

  it("creates and removes a detached session when tmux exists", async () => {
    const socketDir = path.join(process.cwd(), ".tmp-tmux-test");
    await fs.mkdir(socketDir, { recursive: true });
    const previous = process.env.TMUX_TMPDIR;
    process.env.TMUX_TMPDIR = socketDir;
    const session = `taskmaster-vitest-${process.pid}`;
    try {
      const available = await new Promise<boolean>((resolve) => {
        execFile("tmux", ["-V"], { env: process.env }, (error) => resolve(!error));
      });
      if (!available) return;
      await createDetachedSession(session);
      await killSession(session);
    } finally {
      await killSession(session).catch(() => undefined);
      if (previous === undefined) delete process.env.TMUX_TMPDIR;
      else process.env.TMUX_TMPDIR = previous;
      await fs.rm(socketDir, { recursive: true, force: true });
    }
  });
});
