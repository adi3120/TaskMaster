# TaskMaster architecture

Five agents. One goal. Shared state. Visible terminals. No chaos.

TaskMaster is a local orchestrator for one repository. A control-plane process owns tasks, ownership, runs, sessions, events, and provider configuration. tmux is only the surface a person watches.

```
user goal
   │
   ▼
control plane (Node, SQLite, ~/.taskmaster)
   │  assigns work, claims tasks, records events
   ▼
tmux session taskmaster-<project>
   ├── planner pane
   ├── builder pane
   ├── tester pane
   ├── validator pane
   └── documenter / event log
```

Phase 1 implements `taskmaster doctor`. Phase 2 adds `taskmaster demo`, which runs mock agents in tmux. It does not call a model.

## Roles

The team is fixed. There is no hiring and no company tree.

| Role | Writes | Reads |
| --- | --- | --- |
| Planner | architecture, decisions, context, the task DAG | repo, memory, events |
| Builder | source, implementation tests, events | assignment, memory, events |
| Tester | test status, failure reports | implementation, memory, events |
| Validator | PASS or REWORK | diff, tests, architecture, events |
| Documenter | Markdown memory reconciliation | everything above |

Other agents publish events. They do not freely rewrite the same Markdown file.

Pipeline, once later phases exist:

```
user → planner → builder → tester → validator
                 ↑            fail / rework
                 └────────────┘
planner and documenter run alongside
documenter finalizes after validation passes
```

Child tasks are allowed. New agent processes are not. Planner is the primary delegator. A subtask request is an event; planner inserts the task.

## Runtime, provider, model

These stay separate.

- Runtime: Cursor (`agent` / `cursor-agent`), Codex, Claude Code, OpenCode, or a generic command.
- Provider: the runtime's existing login, or OpenRouter, OpenAI, Anthropic, an OpenAI-compatible endpoint, Ollama, or a custom CLI.
- Model: chosen per agent, never implied by the role.

Doctor reports whether a runtime binary exists and whether an auth signal is present. It does not guess subscription plan names, and it does not spend a model call.

## State

Global state lives in `~/.taskmaster` (override with `TASKMASTER_HOME`):

- directory mode `0700`
- `config.json` mode `0600` — enabled runtimes, not secrets
- `secrets/` mode `0700`, each secret file mode `0600`
- `state.sqlite` mode `0600`

`SecretStore` is the only way to read or write credentials. Phase 1's implementation is `FileSecretStore`. A later backend can replace it with the macOS Keychain without changing callers. API keys are stored by reference (`apiKeyRef`), never in the project repo and never in `config.json`.

Project identity is the git root. Doctor records it in SQLite. Human-readable memory (`.taskmaster/memory/*.md`) arrives with the documenter, not in Phase 1.

SQLite tables opened in Phase 1:

- `projects`, `agents`, `tasks`, `runs`, `sessions`, `events`, `providers`

The five roles are registry rows. They are not running processes.

### Atomic ownership

`claimTask` is a transaction. The update matches the task id, an allowed status, and an owner that is empty or already this agent. A different owner loses. The loser must not retry that claim. The same owner may reclaim a task it already runs, which is how a resume after tester or validator failure will work.

tmux pane titles do not decide ownership.

### Sessions

A session row stores runtime params (`sessionId`, `cwd`) produced by `runtimeSessionCodec`. When a runtime says the saved session is gone, the control plane clears it and starts once more. That behavior is specified now and implemented when a real runtime runs (Phase 3).

### Events

Agents communicate with durable events, not a standing chat.

Each event has id, timestamp, project, agent, task, type, summary, and an optional JSON payload. Phase 1 can append and list them. The scheduler that feeds recent events into a prompt comes later.

## Processes

`src/process/run-process.ts` runs a local command. Doctor uses it for `--version` probes. Later phases use it to launch runtimes inside tmux panes, with the same timeout and death handling.

## Process ownership

tmux owns the agent process. `taskmaster demo` asks tmux to create the session, windows, and panes, then `respawn-pane` runs the command. The control plane stores the pane id, window, command, pid, exit code, and lifecycle in `agent_executions`. Liveness is `pane_dead`, `pane_dead_status`, and `pane_pid`. Pane text is only captured for a person to read. It is not parsed into state.

The builder pane is the exception in Phase 3. `taskmaster run --agent builder` respawns that pane with `opencode run --model <agents.builder.model>`. The model string is stored on the run row. The other four panes stay on the mock agent.

There is no automatic restart. `taskmaster demo restart <role>` respawns that pane once and increments `restart_count`.

## Demo layout

Two windows, because six panes on one laptop screen are too small:

- `agents`: planner, builder, tester, validator in a 2x2 grid
- `support`: documenter and the TaskMaster event log

The log pane tails the SQLite event table. It is a view, not a second bus.

## Lifecycle

Agent runtime lifecycle is separate from task status.

`CREATED → STARTING → RUNNING → EXITED` or `CRASHED`. A manual restart passes through `RESTARTING` and back to `RUNNING`.

`taskmaster status` prints that lifecycle from SQLite after a tmux liveness probe.

## Boundaries

`taskmaster` and `taskmaster doctor` scan lanes and exit. `taskmaster demo` starts mock agents only. Detach with tmux, then `taskmaster attach` returns to the same session name. A second `taskmaster demo` reuses that session instead of creating `taskmaster-<project>-1`.

## Later heartbeat

TaskMaster stays event-driven. The useful slice of Paperclip's heartbeat, without schedules, is still later work:

1. Wake because the user submitted a goal or a task became ready.
2. Inspect the assignment, memory, and recent events.
3. Claim the task atomically.
4. Load role skill and dependency results.
5. Execute in that agent's tmux pane.
6. Publish events and any session params.
7. Delegate by creating child tasks, not child agents.
8. Update task status.
9. Exit. The control plane waits for the next event.
