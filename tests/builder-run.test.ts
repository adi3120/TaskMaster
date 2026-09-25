import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runBuilder } from "../src/builder-run.ts";
import { BUILDER_OPENCODE_MODEL, requireBuilderOpenCodeModel, type TaskMasterConfig } from "../src/config.ts";
import { closeDatabase, openDatabase } from "../src/db.ts";
import { buildOpenCodeRunCommand } from "../src/opencode-command.ts";
import { getRun } from "../src/runs.ts";
import { stopDemo } from "../src/demo.ts";
import { sessionNameForProject } from "../src/tmux.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe("opencode command", () => {
  it("always passes the configured model and never continues a remembered session", () => {
    const command = buildOpenCodeRunCommand({
      bin: "opencode",
      model: BUILDER_OPENCODE_MODEL,
      prompt: "Create AUTO_MODEL_TEST.md containing exactly: Automatic model selection works",
    });
    expect(command).toContain("--model");
    expect(command).toContain(BUILDER_OPENCODE_MODEL);
    expect(command).not.toContain("--continue");
    expect(command).not.toContain("--session");
  });

  it("fails when the model is missing", () => {
    expect(() => buildOpenCodeRunCommand({ bin: "opencode", model: "  ", prompt: "Create A.md" })).toThrow(/remembered model/);
    const config: TaskMasterConfig = {
      version: 1,
      enabledRuntimes: ["opencode"],
      agents: { builder: { runtime: "opencode", model: "" } },
    };
    expect(() => requireBuilderOpenCodeModel(config)).toThrow(/not configured/);
  });
});

describe("builder tmux run", () => {
  it("runs the builder through tmux, writes the file, and stores the model", async () => {
    const available = await new Promise<boolean>((resolve) => {
      execFile("tmux", ["-V"], (error) => resolve(!error));
    });
    if (!available) return;

    const home = await tempDir("taskmaster-home-");
    const repo = await tempDir("taskmaster-repo-");
    const socketDir = "/tmp/tm-builder-test";
    await fs.mkdir(socketDir, { recursive: true });
    tempDirs.push(socketDir);
    await exec("git", ["init"], repo);
    await exec("git", ["config", "user.email", "test@example.com"], repo);
    await exec("git", ["config", "user.name", "Test"], repo);
    const fake = path.join(repo, "fake-opencode.mjs");
    await fs.writeFile(
      fake,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (!args.includes("--model")) {
  console.error("missing --model");
  process.exit(2);
}
const model = args[args.indexOf("--model") + 1];
if (model !== ${JSON.stringify(BUILDER_OPENCODE_MODEL)}) {
  console.error("unexpected model " + model);
  process.exit(2);
}
const prompt = args.at(-1) ?? "";
const match = prompt.match(/Create\\s+(\\S+)/);
const file = match?.[1] ?? "OUT.md";
const fs = await import("node:fs");
fs.writeFileSync(file, "Automatic model selection works\\n");
console.log("ses_testbuilder");
process.exit(0);
`,
    );
    await fs.chmod(fake, 0o755);
    const env = {
      ...process.env,
      TASKMASTER_HOME: home,
      TASKMASTER_NO_ATTACH: "1",
      TASKMASTER_OPENCODE_BIN: fake,
      TASKMASTER_RUN_TIMEOUT_MS: "15000",
      TMUX_TMPDIR: socketDir,
    };
    const prompt = "Create PHASE3_BUILDER.md containing exactly: Automatic model selection works";
    try {
      const result = await runBuilder({ cwd: repo, env, attach: false }, prompt);
      expect(result.model).toBe(BUILDER_OPENCODE_MODEL);
      expect(result.verified).toBe(true);
      const written = await fs.readFile(path.join(repo, "PHASE3_BUILDER.md"), "utf8");
      expect(written).toContain("Automatic model selection works");
      const db = openDatabase(path.join(home, "state.sqlite"));
      try {
        const run = getRun(db, result.runId);
        expect(run.model).toBe(BUILDER_OPENCODE_MODEL);
        expect(run.runtimeId).toBe("opencode");
        expect(run.status).toBe("completed");
        expect(run.sessionKey).toBe("ses_testbuilder");
      } finally {
        closeDatabase(db);
      }
      expect(result.sessionName).toBe(sessionNameForProject(path.basename(repo)));
    } finally {
      await stopDemo({ cwd: repo, env, attach: false }).catch(() => undefined);
    }
  }, 30000);
});

function exec(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd }, (error, _stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolve();
    });
  });
}
