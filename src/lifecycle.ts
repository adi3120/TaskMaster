export const AGENT_LIFECYCLES = [
  "CREATED",
  "STARTING",
  "RUNNING",
  "EXITED",
  "CRASHED",
  "RESTARTING",
] as const;

export type AgentLifecycle = (typeof AGENT_LIFECYCLES)[number];

export interface PaneLiveness {
  dead: boolean;
  exitCode: number | null;
  pid: number | null;
}

/**
 * Process liveness comes from tmux pane_dead / pane_dead_status / pane_pid.
 * Pane text is not an input.
 */
export function nextLifecycle(current: AgentLifecycle, probe: PaneLiveness): AgentLifecycle {
  if (!probe.dead) {
    if (current === "EXITED") return "EXITED";
    return "RUNNING";
  }
  if (current === "CREATED") return "CREATED";
  if (probe.exitCode === 0) return "EXITED";
  return "CRASHED";
}

export function lifecycleLabel(lifecycle: AgentLifecycle): string {
  return lifecycle.toLowerCase();
}
