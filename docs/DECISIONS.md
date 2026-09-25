# Decisions

## D1 — TypeScript on Node, not a Paperclip fork

Paperclip's useful runtime code is TypeScript, and the install path we want is `npx taskmaster`. TaskMaster keeps its own control plane. Paperclip modules are studied and, where a primitive is small enough, adapted with attribution. Company, billing, and sandbox code stays upstream.

## D2 — SQLite is authoritative, tmux is the view

Tasks, owners, runs, sessions, events, and provider config live in `~/.taskmaster/state.sqlite`. A person watches work in a tmux session named `taskmaster-<project>`. Pane text is not queried to decide task state.

## D3 — Five fixed coding roles

Planner, Builder, Tester, Validator, and Documenter are created as registry rows. The product does not grow CEOs, managers, or hired agents. Delegation creates tasks, not processes.

## D4 — `node:sqlite`, no ORM

Node 22.13+ ships `node:sqlite`. Phase 1 uses it so the dependency list stays at the type checker and Vitest. Schema changes are versioned in `schema_meta`.

## D5 — Secrets behind an interface, files for now

Credentials go to `~/.taskmaster/secrets` with directory mode `0700` and file mode `0600`. Callers use `SecretStore`. The project repository never receives key material. Replacing the file backend with Keychain later should not change the registry.

## D6 — Doctor detects lanes, it does not bill or prompt

A runtime is installed when its executable is on `PATH`. It is authenticated when an env key or a local credential file is present. Codex plan claims inside JWTs are ignored. Doctor does not run a hello prompt. `testExecution` is a short version probe reserved for callers that ask for it.

## D7 — Claim is compare-and-set

One task has one active owner. `claimTask` updates only when the owner is empty or already the caller, and the status is claimable. A conflict is terminal for that attempt. The same owner may reclaim, so a later rework can resume instead of spawning a second builder.

## D8 — Session blobs are codec-checked

Persisted session params must round-trip through `runtimeSessionCodec`. Unknown fields are dropped. A runtime that reports an unknown session clears the blob and may retry once. The codec is ours; the rule comes from Paperclip's `clearSession` behavior.

## D9 — Global home, repo identity from git

`TASKMASTER_HOME` or `~/.taskmaster` holds state for every project. The project key is the git toplevel path. Doctor does not write `.taskmaster/` into the repository. Markdown memory in the repo waits until the documenter exists, so doctor stays read-only against the project tree.

## D10 — Events, not conversations

Cross-agent communication is an append-only `events` row. Role prompts will receive a filtered tail. There is no standing multi-agent chat in the control plane.

## D12 — tmux owns the demo process

Phase 2 uses model A: tmux launches the pane command and is the parent. TaskMaster records pane identity and reconciles `pane_dead` / `pane_pid`. It does not spawn a second copy of the agent and pipe it into the pane. Replacing `mock-agent` with a real CLI later means changing the command string, not the ownership model.

## D13 — Agent lifecycle is not task status

`agent_executions.lifecycle` is `CREATED`, `STARTING`, `RUNNING`, `EXITED`, `CRASHED`, or `RESTARTING`. Task rows keep the Phase 1 task states. A crashed mock agent is not a failed task.

## D14 — Two tmux windows

The agents window holds planner, builder, tester, and validator. The support window holds documenter and the event log. One six-pane window is too small on a laptop. Session name stays `taskmaster-<project>`.

## D15 — Manual restart only

`taskmaster demo restart <role>` respawns one pane and increments `restart_count`. Nothing restarts an agent in a loop.

## D17 — Builder OpenCode model is explicit

Phase 3 runs only the builder against OpenCode. Every launch includes `--model` from `agents.builder.model`. The value is `opencode/nemotron-3.5-lightning-free`. There is no `--continue` and no reliance on OpenCode's last selected model. An empty model is an error. The same string is stored on `runs.model`. The other four roles stay on the mock agent.

## D16 — Demo project fallback

Doctor still requires a git root to name a project. `taskmaster demo` uses the git root when it exists, and otherwise the current directory basename and absolute path, so a not-yet-initialized repo can still open a session.

## D11 — Child-process helper is the only Phase 1 port

`src/process/run-process.ts` adapts Paperclip's local `runChildProcess` behavior (timeout, grace kill, streaming, capture cap, Claude nesting env). It is marked in `NOTICE`. No other Paperclip source file is copied.
