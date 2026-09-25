# Roadmap

Phase 0 through Phase 4 are in this tree. The full five-agent pipeline has not started.

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

Done for the mock-agent demo.

- `taskmaster demo` opens or reuses `taskmaster-<project>`
- agents window: planner, builder, tester, validator
- support window: documenter and the event log
- SQLite `agent_executions` records lifecycle, pane id, pid, exit, and restart count
- `taskmaster status`, `taskmaster demo crash <role>`, `taskmaster demo restart <role>`, `taskmaster demo stop`, `taskmaster attach`
- tmux owns the child process; liveness comes from pane probes

Still no model calls.

## Phase 3 — One real agent

Done for the Builder only.

- `taskmaster run --agent builder "..."`
- Builder runtime is OpenCode, invoked as `opencode run --model <configured-model>`
- Configured model is `opencode/nemotron-3.5-lightning-free`
- A missing model fails the run. OpenCode's remembered model is not used
- The model is stored on the run row
- Planner, tester, validator, and documenter stay mock processes
- The run checks the git working tree before it is marked complete

## Phase 4 — Planner and task DAG

Done for the Planner, plus one ready Builder task.

- `taskmaster plan "Build Tic Tac Toe"`
- Planner runtime is OpenCode with `agents.planner.model`
- A missing Planner model fails before launch
- The Planner skill is `skills/planner/SKILL.md`
- TaskMaster validates a version 1 `ProjectPlan` before inserting tasks
- An invalid plan is rejected as a whole and recorded as `PLAN_REJECTED`
- Temporary planner ids are mapped to TaskMaster task ids
- Tasks with no unfinished dependencies are `READY`
- After a valid plan, TaskMaster runs one ready Builder task and stops
- Tester, validator, and documenter stay mocked

## Phase 5 — Remaining agents

- make tester, validator, and documenter real
- run the rest of a persisted DAG in dependency order
- keep one active builder task at a time

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
