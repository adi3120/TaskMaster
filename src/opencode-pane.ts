import { resolveOnPath } from "./runtimes/detect.js";
import { listPanes, resizeWindow, respawnPane, selectPaneTitle, capturePane } from "./tmux.js";

export async function resolveOpenCodeBin(env: NodeJS.ProcessEnv): Promise<string> {
  const override = env.TASKMASTER_OPENCODE_BIN?.trim();
  if (override) return override;
  const found = await resolveOnPath("opencode", env.PATH ?? "");
  if (!found) throw new Error("OpenCode is not installed. Install the opencode CLI before taskmaster run.");
  return found;
}

export async function runOpenCodePane(input: {
  session: string;
  paneId: string;
  cwd: string;
  command: string;
  role: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}): Promise<{ exitCode: number | null; pid: number | null; output: string }> {
  await resizeWindow(`${input.session}:agents`, 220, 50, input.env);
  await respawnPane(input.paneId, input.cwd, input.command, input.env);
  await selectPaneTitle(input.paneId, input.role, input.env);
  const pane = await waitForPaneExit(input.session, input.paneId, input.env, input.timeoutMs, input.role);
  const output = await capturePane(input.paneId, input.env);
  return { exitCode: pane?.exitCode ?? null, pid: pane?.pid ?? null, output };
}

export async function waitForPaneExit(
  session: string,
  paneId: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  role: string,
): Promise<{ exitCode: number | null; pid: number | null } | null> {
  const started = Date.now();
  let sawAlive = false;
  while (Date.now() - started < timeoutMs) {
    const panes = await listPanes(session, env);
    const pane = panes.find((item) => item.paneId === paneId);
    if (!pane) return null;
    if (!pane.dead) sawAlive = true;
    if (pane.dead && (sawAlive || Date.now() - started > 500)) return pane;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${role} pane ${paneId} did not exit within ${timeoutMs}ms`);
}
