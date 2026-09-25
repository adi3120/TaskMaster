# Roadmap

Phase 0 and the Phase 1 doctor scaffold are in this tree. Later phases are not started.

## Phase 0 — Upstream extraction

Done. `docs/PAPERCLIP_REUSE.md` records Paperclip commit `e2f1a66aa7a243bbcbad307bf6ba6a377928d542`, what is adapted, and what must not be copied.

## Phase 1 — Core CLI

Done for the doctor milestone.

- `taskmaster` and `taskmaster doctor`
- project detection from the git root
- `~/.taskmaster` state directory and SQLite
- configuration and secret-store interface
- runtime detection for Cursor, Codex, OpenCode, and Claude Code
- provider registry (storage only; no `provider add` flow yet)
- event append/list
- atomic `claimTask`
- tmux version check, session naming, detached session create/kill

Not in this phase: agent prompts, the scheduler, or a live model call.

## Phase 2 — tmux execution prototype

- `taskmaster demo` opens `taskmaster-<project>` with five named panes
- mock processes in each pane
- capture pane output, notice a dead process, restart it
- attach and detach
- a status/log window

Still no model calls. tmux remains a view over the control plane.

## Phase 3 — One real agent

- `taskmaster run --agent builder "Create HELLO.md"`
- one detected runtime, streamed into the builder pane
- persist run and session params
- confirm the filesystem change
- emit a completion event

## Phase 4 — Five-agent team

- role skills under `skills/<role>/SKILL.md`
- prompt assembly: goal, skill, task, memory, dependency results, recent events
- tmux panes bound to those roles

## Phase 5 — Planning and task DAG

- planner returns validated structured tasks, dependencies, acceptance criteria, and a target role
- reject prose that does not validate
- scheduler runs tasks in `READY`

## Phase 6 — Test, validate, rework

- builder → tester → validator
- failure reports return to the builder
- resume the stored session when the runtime supports it
- retry limit so the loop stops

## Phase 7 — Shared memory

- `.taskmaster/memory/` for `CONTEXT.md`, `ARCHITECTURE.md`, `DECISIONS.md`, `CURRENT_STATE.md`, `TEST_STATUS.md`
- documenter is the reconciler
- a decision written once is visible to a later session

## Phase 8 — Git isolation

- one concurrent coding task, one branch, one git worktree
- no parallel builders in one checkout
- the human merges

## Phase 9 — OpenRouter and custom providers

- `taskmaster provider add openrouter` with a prompted key in the secret store
- `taskmaster models openrouter`
- per-agent runtime, provider, and model assignment

## Phase 10 — Dogfooding

- use TaskMaster on TaskMaster
- every generated change stays reviewable in git
- no uncontrolled self-modification

## Non-goals

No browser UI, company model, cloud orchestrator, RAG, vector database, dynamic hiring, billing, Kubernetes, or distributed scheduler in these phases.
