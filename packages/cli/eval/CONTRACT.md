# Tool-surface eval: shared contract

This file fixes the seams between four independently built parts so they can be developed in parallel and merged without negotiation. Anything not written here is the implementer's call. Anything written here is fixed until this file changes.

Base branch: `eval/tool-surface`. Sub-branches: `eval/tool-surface-headless`, `eval/tool-surface-variants`, `eval/tool-surface-runner`, `eval/tool-surface-corpus`.

House rules for every file: no em dashes; direct technical prose; no issue numbers, work-item ids, or tool or agent references; one record per file where records exist; tests mirror source paths; nothing under `packages/cli/eval/` is published.

## 1. Operations

An operation is one thing an agent can do to the sandbox. Every surface variant renders the same operation set; only names and parameter shapes differ. The canonical operation id is `verb_service_object` and is variant independent. The corpus, the scorer, and the audit log use canonical ids, never rendered tool names.

| Canonical id | Verb | Service | Object | Required parameters | Notes |
|---|---|---|---|---|---|
| `create_auth_user` | create | auth | user | `uid?`, `email?`, `password?`, `displayName?`, `claims?` (object), `tenant?` | Seeds a user. `tenant` and `claims` both project into `request.auth.token` through the shared normalization. |
| `get_auth_user` | get | auth | user | `uid` | |
| `list_auth_users` | list | auth | users | `limit?` | |
| `update_auth_user` | update | auth | user | `uid`, then any of `email`, `password`, `displayName`, `disabled`, `emailVerified` | |
| `delete_auth_user` | delete | auth | user | `uid` | |
| `set_auth_claims` | set | auth | claims | `uid`, `claims` (object) | Replaces custom claims. |
| `switch_auth_identity` | switch | auth | identity | `mode` (`admin`, `uid`, `anonymous`, `app-session`), `uid?`, `tenant?`, `claims?` | Sets the caller identity for subsequent calls. |
| `get_auth_identity` | get | auth | identity | none | Reports the held identity: mode, uid, tenant, claims as projected. |
| `get_firestore_document` | get | firestore | document | `path` | |
| `list_firestore_documents` | list | firestore | documents | `path` (collection), `limit?` | |
| `write_firestore_document` | write | firestore | document | `path`, `data` (object), `merge?` | Set semantics. |
| `add_firestore_document` | add | firestore | document | `path` (collection), `data` (object) | Auto id. |
| `update_firestore_document` | update | firestore | document | `path`, `data` (object) | |
| `delete_firestore_document` | delete | firestore | document | `path` | |
| `batch_firestore_writes` | batch | firestore | writes | `writes` (array of `{ op, path, data? }`) | |
| `query_firestore_documents` | query | firestore | documents | `path`, `filters?` (array of `{ field, op, value }`), `orderBy?`, `direction?`, `limit?` | |
| `get_database_value` | get | database | value | `path` | |
| `write_database_value` | write | database | value | `path`, `value` | |
| `update_database_value` | update | database | value | `path`, `value` (object) | |
| `delete_database_value` | delete | database | value | `path` | |
| `query_database_values` | query | database | values | `path`, `orderByChild?`, `equalTo?`, `limitToFirst?` | |
| `upload_storage_file` | upload | storage | file | `path`, `contentBase64`, `contentType?`, `metadata?` (object) | |
| `download_storage_file` | download | storage | file | `path` | |
| `list_storage_files` | list | storage | files | `prefix?` | |
| `get_storage_metadata` | get | storage | metadata | `path` | |
| `delete_storage_file` | delete | storage | file | `path` | |
| `lint_firestore_rules` | lint | firestore | rules | `rules?` (source; default current) | |
| `simulate_firestore_rules` | simulate | firestore | rules | `operation`, `path`, `uid?`, `data?` (object), `rules?` | |
| `diagnose_firestore_denial` | diagnose | firestore | denial | `operation`, `path`, `uid?`, `data?` | Trace of why a request was denied. |
| `lint_database_rules` | lint | database | rules | `rules?` | |
| `simulate_database_rules` | simulate | database | rules | `operation`, `path`, `uid?`, `data?`, `rules?` | |
| `lint_storage_rules` | lint | storage | rules | `rules?` | |
| `simulate_storage_rules` | simulate | storage | rules | `operation`, `path`, `uid?`, `rules?` | |
| `set_firestore_rules` | set | firestore | rules | `rules` | Installs a ruleset into the running sandbox. |
| `set_database_rules` | set | database | rules | `rules` | Installs a ruleset into the running sandbox. |
| `set_storage_rules` | set | storage | rules | `rules` | Installs a ruleset into the running sandbox. |
| `list_rules_stdlib` | list | rules | stdlib | none | |
| `get_rules_stdlib` | get | rules | stdlib | `module` | |
| `inspect_sandbox` | inspect | sandbox | state | none | Counts and status per service. |
| `reset_sandbox` | reset | sandbox | state | `scope?` (`all`, `firestore`, `database`, `storage`, `auth`), `confirm` | `scope` narrows the reset to one service; default is `all`. |
| `seed_sandbox` | seed | sandbox | state | `users?`, `firestore?`, `database?`, `storage?`, `firestoreRules?`, `databaseRules?`, `storageRules?` | Matches `EvalSeed`. Any other top-level key is rejected. |
| `checkpoint_sandbox` | checkpoint | sandbox | state | `name` | Saves the whole sandbox under a name. Overwrites a checkpoint of the same name. |
| `restore_sandbox` | restore | sandbox | state | `name`, `confirm` | Replaces the live sandbox with a named checkpoint. |
| `list_sandbox_checkpoints` | list | sandbox | checkpoints | none | Names, save time, and per-service counts. |
| `delete_sandbox_checkpoint` | delete | sandbox | checkpoints | `name` | Removes one checkpoint. The sandbox is untouched. |
| `list_sandbox_events` | list | sandbox | events | `since?`, `limit?`, `kind?` (`all`, `denials`, `writes`) | Cursor-paged operation log; the result carries `nextCursor`. |
| `export_sandbox_fixture` | export | sandbox | fixture | `path`, `excludePasswords?` | Writes a seed fixture file. The seeded passwords are carried unless `excludePasswords: true`. |
| `seed_sandbox_fixture` | seed | sandbox | fixture | `path` | Loads a fixture written by `export_sandbox_fixture` on top of live state. |
| `fork_sandbox_branch` | fork | sandbox | branch | `branch`, `candidateRules?` (a Firestore rules string, or an object naming `firestore`, `database`, and `storage`) | Copies the whole live sandbox into a persisted branch under `.pyric/state/branches/<branch>/`. |
| `apply_sandbox_events` | apply | sandbox | events | `branch`, `events?` (array), `sessionPath?` | Exactly one of `events` and `sessionPath`; naming neither is refused. |
| `diff_sandbox_branch` | diff | sandbox | branch | `branch`, `against?` (`live` or a checkpoint name) | Defaults to `live`. Every divergence names its service, and the result carries per-service counts. |
| `promote_sandbox_branch` | promote | sandbox | branch | `branch`, `confirm` | Destructive: lands the branch on live and deletes it. |
| `discard_sandbox_branch` | discard | sandbox | branch | `branch` | Deletes the branch; live is untouched. |
| `list_sandbox_branches` | list | sandbox | branches | none | Name, created, base, event count, and divergences against live. |

Fifty-three operations. Parameter objects are real nested JSON objects, never JSON-encoded strings. Nesting depth of any parameter schema is at most two object levels below the root.

## 2. Surface variants

| Variant id | Tool name pattern | Read operations rendered as | Discriminator |
|---|---|---|---|
| `discriminator` | The twelve intent tools and seven `pyric://` resource templates from the typed-service-contract branch, names and `action` enums as there, with `*Json` string parameters kept as there. | MCP resources | `action` field |
| `verb-prefixed` | `verb_service_object`, the canonical id itself | tools | none |
| `noun-prefixed` | `service_object_verb` (`auth_user_create`) | tools | none |
| `verb-suffixed` | `verb_object_service` (`create_user_auth`) | tools | none |

Every variant must expose every operation in section 1 exactly once. A test asserts this by rendering each variant and mapping every tool (and every `action` value of a discriminator tool, and every resource template) back to a canonical id, with no operation missing and none duplicated.

Rendering is a pure function from the operation records to an MCP tool list plus a dispatch function. Execution never depends on the variant: the rendered tool's handler maps its arguments to the canonical operation and calls that operation's single handler.

The variant is selected at server start by `pyric mcp --surface <variant-id>` or the environment variable `PYRIC_TOOL_SURFACE`. The flag wins. Absent both, the server serves whatever main serves today.

## 3. Headless server

`pyric mcp --headless` forces the in-process sandbox and never attaches to a running bridge. Without the flag, behavior is unchanged.

`--project-dir <dir>`, with `PYRIC_PROJECT_DIR` as the environment fallback and the flag winning, names the directory the headless server reads `firestore.rules`, `storage.rules`, `.pyric/state/headless.json` and `.pyric/state/storage.json` from and writes them back to. A relative value resolves against the process cwd. Absent both, the project directory is the process cwd, which is the behavior every existing caller gets.

The headless server records one event per tool call through the bridge's existing `recordToolEvent` seam. When the environment variable `PYRIC_EVAL_LOG` names a file, events append there as NDJSON, one object per line, and nothing is written to the per-project audit log. When it is absent, behavior is unchanged.

Effect enforcement (ADR-0014 Decision 5) runs once, in `method-validation.ts`'s `validateArguments`, which both the MCP dispatch path and `pyric <tool> <method>` call. A `destructive` method (today `sandbox.reset`, `sandbox.restore`, and `sandbox.promote`) is refused unless `args.confirm === true`; the refusal is an ordinary `InvalidArguments` rejection naming the field `confirm`. A `production` method is not mounted: it is absent from `tools/list`, `describe` does not answer for it, and a call naming it is refused, unless the headless server was started with `--allow-production` (or `PYRIC_ALLOW_PRODUCTION` set to `1` or `true`, with the flag winning). The harness passes the flag nowhere, and it deletes `PYRIC_ALLOW_PRODUCTION` from the environment of every process it spawns, so the variable a maintainer has set for their own session cannot reach a run and a `production` method never mounts in one.

Event shape (a superset of today's `BridgeToolEvent`):

```json
{
  "timestamp": "2026-09-09T00:00:00.000Z",
  "mode": "sandbox",
  "project": "eval",
  "tool": "<rendered tool name as the MCP client sent it>",
  "operation": "<canonical id, or null if the call did not resolve to one>",
  "action": "<discriminator value when the variant has one, else null>",
  "args": {},
  "result": { "ok": true, "summary": "", "data": {} },
  "durationMs": 0,
  "schemaRejected": false,
  "isError": false,
  "run": {
    "runId": "", "taskId": "", "variant": "", "cli": "", "model": "",
    "effort": "", "condition": "", "seed": 0, "callIndex": 0
  }
}
```

`schemaRejected` is true when the arguments failed schema validation before dispatch (the call is still logged, with `result.ok` false). `isError` mirrors the MCP `isError` flag of the returned result. `callIndex` counts calls within the run from zero. The `run` block is read from the environment at server start:

`PYRIC_EVAL_RUN_ID`, `PYRIC_EVAL_TASK_ID`, `PYRIC_EVAL_VARIANT`, `PYRIC_EVAL_CLI`, `PYRIC_EVAL_MODEL`, `PYRIC_EVAL_EFFORT`, `PYRIC_EVAL_CONDITION`, `PYRIC_EVAL_SEED`.

On stdio close the server performs a final synchronous snapshot flush to `.pyric/state/headless.json` before exiting, so the file the scorer reads is complete.

## 4. Corpus records

One file per task under `packages/cli/eval/corpus/<task-id>.ts`, default export typed as:

```ts
export interface EvalTask {
  id: string;                       // equals the filename without extension
  prompt: string;                   // what the agent is asked, in user words
  seed: EvalSeed;                   // state loaded before the run
  acceptedFirstOperations: string[]; // canonical ids; empty means "any"
  assert: (state: EvalState) => true | string; // true, or a reason
  tags: string[];                   // e.g. 'auth', 'tenant', 'rules', 'read', 'write'
}

export interface EvalSeed {
  firestoreRules?: string;
  databaseRules?: string;
  storageRules?: string;
  users?: Array<{ uid: string; email?: string; claims?: Record<string, unknown>; tenant?: string }>;
  firestore?: Record<string, Record<string, unknown>>;  // path -> document
  database?: Record<string, unknown>;                   // tree
  storage?: Array<{ path: string; contentBase64: string; contentType?: string }>;
}

export interface EvalState {
  firestore: { get(path: string): Record<string, unknown> | null; list(collection: string): Array<{ id: string; data: Record<string, unknown> }> };
  database: { get(path: string): unknown };
  users: { get(uid: string): { uid: string; email?: string; claims: Record<string, unknown>; tenant?: string } | null; list(): Array<{ uid: string }> };
  storage: { get(path: string): { contentType?: string; size: number; metadata: Record<string, unknown> } | null };
  calls: Array<{ operation: string | null; tool: string; ok: boolean; schemaRejected: boolean }>;
}
```

`seed` is applied by the runner through the sandbox before the CLI starts; tasks never call tools to set up. `assert` sees the final snapshot plus the call log and returns `true` or a short reason string.

## 5. Matrix records

One file per row under `packages/cli/eval/matrix/<row-id>.ts`:

```ts
export interface EvalRow {
  id: string;                              // equals the filename
  cli: 'claude' | 'codex' | 'antigravity';
  model: string;                           // the slug as that CLI spells it
  effort?: string;                         // omitted for antigravity, where it lives in the slug
  condition: 'agent-default' | 'mcp-only'; // mcp-only is valid only for cli 'claude'
  seeds: number[];
}
```

The fourteen rows are the agreed matrix. Claude Fable 5.1 rows exist in both conditions.

## 6. Runner

`packages/cli/eval/run.ts`, invoked as `bun run --cwd packages/cli eval -- [--rows a,b] [--tasks x,y] [--variants v] [--dry-run]`.

Every run has three directories, because a CLI with built-in file tools that can read the sandbox state off disk answers the task without calling a tool and the run then measures file reading rather than the tool surface:

| Directory | Path | Holds |
|---|---|---|
| run | `packages/cli/eval/results/<runId>/<row>/<variant>/<task>/<seed>/` | raw output, the provider config files a CLI takes by path, and the copies of the state after the run |
| workspace | `<run>/workspace/` | nothing but the files a provider has no other way to deliver, today only Antigravity's `.agents/mcp_config.json` |
| state | `<tmpdir>/pyric-eval/<runId>/<row>/<variant>/<task>/<seed>/` | the seeded rules files, `.pyric/state/headless.json`, the storage sidecar, `events.ndjson` |

For each run the runner:

1. Creates all three, and applies the seed through the sandbox into the state directory, which is where the rules files and `.pyric/state/headless.json` are written.
2. Writes the CLI config through a provider module, `providers/claude.ts`, `providers/codex.ts`, `providers/antigravity.ts`, each exporting `buildInvocation(run): { command: string[]; env: Record<string, string>; files: Record<string, string>; workspaceFiles: Record<string, string> }`. `files` are written relative to the run directory and `workspaceFiles` relative to the workspace. The MCP server command is the local build: `node <repo>/packages/cli/dist/cli/index.js mcp --headless --surface <variant>`.

   Where each variable travels is fixed, because an agent with file tools can read the MCP config it was given and Antigravity's config has to sit in the agent's own workspace:

   | Variable | Travels in |
   |---|---|
   | `PYRIC_PROJECT_DIR` | `Invocation.env`, the CLI process environment |
   | `PYRIC_EVAL_LOG` | `Invocation.env` |
   | `PYRIC_EVAL_RUN_ID`, `PYRIC_EVAL_TASK_ID`, `PYRIC_EVAL_VARIANT`, `PYRIC_EVAL_CLI`, `PYRIC_EVAL_MODEL`, `PYRIC_EVAL_EFFORT`, `PYRIC_EVAL_CONDITION`, `PYRIC_EVAL_SEED` | `Invocation.env` |
   | `PYRIC_TOOL_SURFACE` | the MCP config's server `env` block, and nothing else goes there |
   | `CODEX_HOME` | `Invocation.env`, for the codex provider only |

   The runner spawns the CLI with `{ ...process.env, ...invocation.env }`, so the MCP server the CLI spawns inherits all of it. A server entry in a config file holds `command`, `args`, which still carry `--headless --surface <variant>`, and that one-variable `env` block. No `Invocation.env` value is ever written into a file placed in the workspace, and `run.ts` throws if a provider's `workspaceFiles` contain the state directory path or the events path.

   The fake provider is the exception, because its replay client spawns the server itself rather than inheriting a CLI's environment: its plan file carries the full server environment, and the plan lives in the run directory, which no agent is given.

   Reading the process environment is still open to an agent that thinks to look, so this is a mitigation and not a wall: `mcp-only` on Claude Code is the only fully closed condition.
3. Spawns the CLI in the workspace with a hard timeout, captures stdout and stderr raw to files in the run directory, never parses them for scoring. A provider that names a directory to the CLI names the workspace and nothing else.
4. Copies `events.ndjson`, `.pyric/state/headless.json` and `.pyric/state/storage.json` from the state directory into the run directory, deletes the state directory, then reads the copies, builds `EvalState`, runs the task's `assert`, and appends one line to `results/<runId>/runs.ndjson`.

`--dry-run` prepares everything, prints the run, workspace and state directories with the invocation, and spawns nothing.

A fourth provider, `providers/fake.ts`, replays a canned transcript against the real headless server so the whole pipeline is testable without a model. `--transcripts <file>` selects it and reads one canned call list per task id; the call lists live under `eval/transcripts/`, named by the family of tasks they drive. The branch family sweeps with:

```
bun packages/cli/eval/run.ts \
  --rows claude-fable-5-1-low-mcp-only \
  --tasks stage-a-plan-then-walk-away,promote-the-reviewed-branch,throw-away-the-experiment-branch,list-the-open-branches,diff-against-a-checkpoint-that-is-not-there \
  --variants sdk-service \
  --transcripts packages/cli/eval/transcripts/sandbox-branches.json \
  --no-wait --min-gap 0
bun packages/cli/eval/report.ts <results>/runs.ndjson
```

The checkpoint, event, and fixture family sweeps the same way:

```
bun packages/cli/eval/run.ts \
  --rows claude-fable-5-1-low-mcp-only \
  --tasks checkpoint-before-cleanup-then-restore,clear-database-only-leave-firestore,export-fixture-then-reload-after-reset,list-checkpoints-restore-after-import,page-through-events-after-a-burst \
  --variants sdk-service \
  --transcripts packages/cli/eval/transcripts/sandbox-state.json \
  --no-wait --min-gap 0
bun packages/cli/eval/report.ts <results>/runs.ndjson
```

Pacing: one CLI process at a time per CLI, a configurable minimum gap between spawns per CLI, and a per-CLI budget per five-hour window; a rejected or rate-limited run is recorded with outcome `throttled`, not retried.

Result line fields: `runId`, `row`, `variant`, `task`, `seed`, `outcome` (`pass`, `fail`, `timeout`, `throttled`, `crash`), `firstOperation`, `firstOperationAccepted`, `callCount`, `schemaRejections`, `errorCalls`, `durationMs`, `assertReason`.

`packages/cli/eval/report.ts` reads one or more `runs.ndjson` files and prints, per variant and row, selection accuracy, argument validity, completion rate, mean calls per completed task, and a bootstrap 95% interval over tasks for each.

## 7. Ownership

| Part | Owns | Must not touch |
|---|---|---|
| headless | `packages/cli/src/bridge/server/headless.ts`, `local-bridge.ts`, `audit.ts`, `bridge.ts` (event type only), `packages/cli/src/cli/mcp-proxy.ts`, their tests | anything under `bridge/surface/` or `eval/` |
| variants | new `packages/cli/src/bridge/surface/` and its tests; one small seam in `headless.ts`: `buildHeadlessMcpServer(sandbox, { surface })` accepting a variant id | everything else in `bridge/server/` |
| runner | `packages/cli/eval/run.ts`, `report.ts`, `score.ts`, `providers/`, `test/` under `eval/` | `bridge/`, `corpus/`, `matrix/` |
| corpus | `packages/cli/eval/corpus/`, `packages/cli/eval/matrix/` | everything else |

The `surface` seam in `headless.ts` is declared by the headless part as `surface?: string` passed through to a function `renderSurface(surfaceId)` imported from `../surface/index.js`; the variants part implements that function. Until both land, the headless part ships a stub that returns today's default surface for any id.
