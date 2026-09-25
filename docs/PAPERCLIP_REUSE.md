# Paperclip reuse notes

Study date: 2026-09-25.

Upstream: [paperclipai/paperclip](https://github.com/paperclipai/paperclip)

Commit: `e2f1a66aa7a243bbcbad307bf6ba6a377928d542`

Commit time: 2026-09-25 08:07:50 -0700 (`feat: support default-hidden experimental settings (#13980)`)

License: MIT. Copyright (c) 2025 Paperclip AI. See `LICENSE` and `NOTICE` in this repository.

TaskMaster is not a fork of Paperclip and does not reproduce its company-management product. This note records what was read at that commit and how TaskMaster may use it.

## Files studied

Adapter runtime:

- `packages/adapter-utils/src/types.ts` — `AdapterExecutionContext`, `AdapterExecutionResult`, `AdapterSessionCodec`, `AdapterEnvironmentTestResult`, `ServerAdapterModule`
- `packages/adapter-utils/src/server-utils.ts` — `runChildProcess`, `signalRunningProcess`, capture caps, config coercions, skill-injection helpers (located, not ported)
- `packages/adapter-utils/src/acpx-engine/session-codec.ts`
- `packages/adapter-utils/README.md` — remote SSH workspace round-trip. Do not port.
- `packages/adapters/cursor-local/src/server/index.ts` — Cursor session codec
- `packages/adapters/cursor-local/src/server/execute.ts` — unknown-session retry (`clearSession`)
- `packages/adapters/cursor-local/src/server/parse.ts` — `isCursorUnknownSessionError`
- `packages/adapters/cursor-local/src/server/test.ts` — install and auth probes, including `readCursorAuthInfo`
- `packages/adapters/codex-local/src/server/test.ts` — Codex command and `auth.json` probe
- `packages/adapters/codex-local/src/server/quota.ts` — `readCodexAuthInfo` field paths. JWT plan decoding was inspected only to reject it.
- `packages/adapters/opencode-local/src/server/index.ts` — OpenCode session codec
- `packages/adapters/opencode-local/src/server/test.ts` — environment probe shape
- `packages/adapters/claude-local/src/server/test.ts` — Claude command probe and auth signals
- `packages/adapters/claude-local/src/server/quota.ts` — `claudeConfigDir()` and credential filenames only
- `docs/adapters/creating-an-adapter.md`

Task protocol:

- `docs/guides/agent-developer/heartbeat-protocol.md`
- `docs/guides/agent-developer/task-workflow.md`
- `skills/paperclip/SKILL.md` — heartbeat procedure and Agent Skills frontmatter. The Paperclip API skill itself is not reused.
- `server/src/routes/issues-checkout-wakeup.ts`
- `server/src/services/issues.ts` — `checkout` (around lines 11302–11556)

Workspaces, located and not ported:

- `server/src/services/execution-workspaces.ts` — `providerType === "git_worktree"`, `git worktree` cleanup, branch reconciliation
- `packages/db/src/schema/execution_workspaces.ts` — schema file located, not copied
- `README.md` workspace paragraph and `AGENTS.md` control-plane invariants

Skill format:

- `docs/guides/agent-developer/writing-a-skill.md`

## Reuse directly

Nothing large is copied.

Paperclip modules pull in companies, budgets, sandboxes, SSH, quotas, and the control-plane HTTP API. Those dependencies do not belong in TaskMaster. Direct reuse would drag that product in with the primitive.

The only code adapted into this repository in Phase 1 is the local child-process runner. It lives in `src/process/run-process.ts` and is a reduced subset of `runChildProcess` / `signalRunningProcess`:

- spawn without a shell
- stream stdout and stderr
- cap captured output
- timeout, then SIGTERM, then SIGKILL after a grace period
- signal the process group when the child is detached
- drop Claude Code nesting variables so a CLI can start when TaskMaster itself was launched inside Claude Code

Remote execution, sandboxes, terminal-result cleanup, and Paperclip env injection are omitted. The file header and `NOTICE` carry the Paperclip copyright.

## Adapt

These ideas are reimplemented in small TaskMaster modules. They are not line-copies.

| Paperclip idea | TaskMaster equivalent | Why it is safe |
| --- | --- | --- |
| `AdapterExecutionContext` / `AdapterExecutionResult` | Later runtime invocation result: exit, signal, timeout, session params, clear-session flag | The shape is the contract between a CLI lane and the control plane. Drop company, billing, MCP, and sandbox fields. |
| `AdapterSessionCodec` | `src/sessions/codec.ts` stores `sessionId` and `cwd` | Resume needs a validated blob per agent, task, and runtime. Cursor and OpenCode codecs are the same idea with extra workspace fields we do not need yet. |
| Unknown-session recovery | Planned for Phase 3: if resume fails the unknown-session check, retry once with a fresh session and set `clearSession` | `cursor-local` execute does this. Do not copy the adapter. |
| Environment diagnostics | `detectInstallation` / `detectAuthentication` / `testExecution` returning `INSTALLED_AUTHENTICATED`, `INSTALLED_UNAUTHENTICATED`, `NOT_INSTALLED`, `ERROR` | Paperclip probes the command and local auth files. TaskMaster must not decode subscription plan names. Codex `planType` JWT parsing is explicitly not adapted. |
| Cursor auth | Presence of `CURSOR_API_KEY` or `~/.cursor/cli-config.json` `authInfo` | Same signal as `readCursorAuthInfo`, boolean only. Email is not printed. |
| Codex auth | Presence of `OPENAI_API_KEY` or a non-empty token field in `~/.codex/auth.json` | Same file Paperclip reads. No token is returned and no JWT is decoded. |
| Claude auth | Command on `PATH`, plus `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, or `~/.claude/.credentials.json` | Paperclip's hello probe spends a model call. Doctor does not. |
| Atomic checkout | `claimTask` in `src/tasks.ts` | Paperclip's `checkout` is a conditional `UPDATE` on id, expected status, empty-or-same assignee, and execution lock. A lost race returns 409 and must not be retried. TaskMaster keeps that invariant in SQLite: one task, one active owner. Idempotent reclaim by the same owner is allowed. Company scope, pause holds, and heartbeat-run adoption are not. |
| Heartbeat procedure | Event-driven lifecycle in `docs/ARCHITECTURE.md` | Wake, inspect, claim, load context, execute, publish progress, delegate, update, exit. No schedules, budgets, or org chart. |
| `SKILL.md` frontmatter | Role skills in Phase 4 | `name` and `description` as routing text. Skill bodies will be TaskMaster role procedures, not the Paperclip API skill. |

## Inspire only

- Adapter package split (`execute`, `parse`, `testEnvironment`, `sessionCodec`). TaskMaster runtimes stay a handful of files under `src/runtimes/`.
- Isolated execution workspaces: one coding task, one git worktree, one branch. Phase 8. The 150KB+ workspace service also owns company policy, quarantine, and runtime leases. Do not port it.
- Durable run log (`heartbeat_run_events`). TaskMaster uses the `events` table instead of a second logging product.
- Skill injection by symlink or temp dir. Phase 4 can pass a skill path into the runtime. Do not modify the user repo to install skills globally.

## Do not copy

- Companies, organizations, employees, org charts, hiring, goals-as-a-business-object
- Budgets, billing types, quota windows, cost accounting, plan-type detection
- Governance, approvals, routines, schedules, watchdogs, liveness continuation wakes
- Multi-user auth, SSO, RBAC, plugins marketplace, multi-tenancy
- Cloud sandboxes, Kubernetes, SSH remote runtimes, MCP bridges
- Paperclip issue documents, interactions, confirmations, and the HTTP control plane
- `skills/paperclip/SKILL.md` body (it teaches Paperclip's API, companies, and routines)
- UI packages and the company dashboard

## Licensing

MIT requires the copyright notice and permission notice to travel with substantial portions of the software.

- `NOTICE` quotes the Paperclip MIT license.
- `src/process/run-process.ts` names the upstream file and commit.
- Future ports must do the same in the file header.
- Do not vendor Paperclip packages. Reimplement or adapt the smallest primitive and stop.
