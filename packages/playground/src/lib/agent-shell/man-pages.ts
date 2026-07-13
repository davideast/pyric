/**
 * `man` page bodies for the agent shell — W2.1's pull-based replacement
 * for the killed C3 push-injection (conductor log 2026-06-10: injected
 * skills moved correctness DOWN at flat cost; docs-on-demand mirror how
 * developers actually consume documentation and carry zero standing
 * prefix cost).
 *
 * Contract: each page stays UNDER 80 lines — a page is one screenful of
 * targeted contract, not a manual. New commands get a page here and a
 * one-line entry in `shell`.
 */

export const MAN_TOPICS = ['test', 'rules', 'shell', 'workflow', 'diagnostics'] as const;
export type ManTopic = (typeof MAN_TOPICS)[number];

/** One-line apropos summaries — `man -k [keyword]` renders these. */
export const MAN_SUMMARIES: Record<ManTopic, string> = {
  test: 'run declarative workspace tests; test-file format + contract',
  rules: 'Firestore rules pitfalls, stdlib modules, verify + deploy',
  shell: 'the workspace-jailed bash: builtins, jail semantics, notes',
  workflow: 'tool orchestration — the authoring loop end to end',
  diagnostics: 'rule debugging tools: simulate, debug, try-edit, traffic, seed, fixtures',
};

const TEST_PAGE = `TEST(1)                      workspace dev loop

NAME
  test — run declarative workspace tests against the current rules

SYNOPSIS
  test [pattern]

DESCRIPTION
  Runs every /workspace/tests/*.test.json (optionally only files whose
  name contains PATTERN) against /workspace/firestore.rules. Each file
  is hermetic: fresh sandbox, ruleset deployed once, then cases execute
  through the real data plane under each case's identity. Cases are
  INDEPENDENT: the data plane resets to the file's seed before every
  case, so one case's writes never affect another.

FILE FORMAT  (/workspace/tests/<name>.test.json)
  {
    "seed":  [{ "path": "orders/o1", "data": { "userId": "alice" } }],
    "cases": [
      { "as": { "uid": "alice", "token": { "admin": true } },
        "do": { "method": "get", "path": "orders/o1" },
        "expect": "ALLOW",
        "name": "owner can read" }
    ]
  }
  - "as": identity. null = unauthenticated. Custom claims go under
    "token" and read as request.auth.token.<name> in rules.
  - "do.method": get | list | create | update | delete.
  - "do.path": document path ("orders/o1"); COLLECTION path for list.
  - "do.data": incoming data, create/update only.
  - "expect": "ALLOW" | "DENY".

CONTRACT
  - list runs as a REAL query through rules enforcement.
  - Cases are independent: state resets to "seed" between cases. A
    case's writes (even ALLOWed ones) are invisible to later cases —
    outcomes never depend on case order. Any doc a case reads,
    updates, or deletes must be declared in "seed".
  - got: "ERROR" means the test or seed is wrong (e.g. update on a
    missing doc), NOT the rules. Fix the test, then re-run.
  - Exit 0 = all green. Exit 1 = failures, one line per failing case.

WORKFLOW
  Author tests with write_file, run \`test\` after every rules edit.
  Tests are durable workspace files — the user's regression suite.
  A green FULL-suite run auto-commits a workspace checkpoint
  ("checkpoint <sha>" on stdout; nothing when the tree is unchanged) —
  a known-good state to roll back to. Filtered runs don't checkpoint.

SEE ALSO
  man rules, man shell`;

const RULES_PAGE = `RULES(7)                     Firestore rules pitfalls

READ BEFORE WRITING RULES
  - list (collection queries) evaluates 'allow list'/'allow read' with
    resource UNDEFINED. A rule referencing resource.data.<field> for
    list ALWAYS fails — there is no single document yet. Split read:
      allow get:  if <may reference resource.data>;
      allow list: if <must NOT reference resource.data>;
  - Per-user lists: the canonical pattern is
      allow list: if request.auth != null;
    and rely on the client query's .where("uid","==",auth.uid) filter,
    OR root a subcollection at the user (users/{uid}/todos/{id}).
  - allow create must reference request.resource.data (the incoming
    doc); resource.data is null for creates.
  - Custom claims read as request.auth.token.<name>, NOT
    request.auth.<name>.
  - Common hallucinations the linter flags: string.startsWith (use
    string.matches), auth.token.admin (use request.auth.token.admin),
    timestamp.now() (use request.time). Methods not in the rules
    stdlib fail compile — when unsure, firestore_rules_stdlib_list.

VERIFY
  - lint-rules            lint /workspace/firestore.rules (or a path)
  - test                  run the workspace suite (man test)
  - Unseeded docs are the classic false-DENY: owner-read/update cases
    need the doc to EXIST — declare it in the test file's "seed".

DEPLOY
  Writing /workspace/firestore.rules via write_file auto-deploys to
  the sandbox and returns lint + traffic-replay validation. Bash
  edits to that file do NOT auto-deploy — prefer write_file.

SEE ALSO
  man test, man shell`;

const SHELL_PAGE = `SHELL(1)                     agent shell

DESCRIPTION
  Workspace-jailed bash over /workspace (the playground VFS). No
  network, no subprocesses, no host filesystem — paths outside
  /workspace do not exist. cwd persists between bash tool calls and
  is clamped back to /workspace if a command leaves the jail.

BUILTINS (playground capabilities)
  test [pattern]      run workspace tests           (man test)
  lint-rules [path]   lint a rules file; defaults to
                      /workspace/firestore.rules    (man rules)
  man <topic>         these pages — man -k lists every topic
                      (test, rules, shell, workflow, diagnostics)

STANDARD COMMANDS
  ls cat head tail grep rg sed awk find tree mkdir rm cp mv touch
  echo printf wc sort uniq cut diff jq xargs which …

NOTES
  - \`git\` is NOT installed — use \`github_create_repo\`, \`github_push_branch\`,
    and \`github_create_pull_request\` to publish (see \`man workflow\` section  PUBLISH).
  - \`test\` routes to the test runner when it is the FIRST command of
    the line (also spelled run-tests). For shell conditionals use
    [ ... ] — e.g. [ -f notes.txt ] && echo yes.
  - Prefer write_file for whole-file writes: rules and App.tsx writes
    auto-deploy and auto-validate there; bash redirection/sed -i
    bypasses those gates.
  - Each command line runs in a fresh shell environment: variables
    and aliases do NOT persist across bash tool calls (cwd does).

SEE ALSO
  man test, man rules`;

const WORKFLOW_PAGE = `WORKFLOW(7)                  playground tool orchestration

THE LOOP (building or changing a feature)
  1. Orient — CURRENT RULES / CURRENT APP are already inline in your
     system prompt; use list_files / read_file (or ls/cat) for the rest.
     write_file REPLACES the whole file (no merge): read before you edit.
  2. Rules — read \`man rules\` first. Writing /workspace/firestore.rules
     via write_file auto-deploys to the sandbox and returns lint +
     traffic-replay validation. The file is pinned (cannot be deleted).
  3. Verify — simulate_firestore_write once per distinct operation/auth
     shape; author durable tests under /workspace/tests/ (\`man test\`)
     and run them (run_workspace_tests tool, or \`test\` in bash).
  4. App — write /workspace/src/App.tsx (recompiles the preview), then
     run firestore_extract_indexes so the user sees required indexes.
  5. Denials — debug_firestore_rules FIRST (\`man diagnostics\`). Calling
     inspect_denial as a tool (vs. reasoning silently) keeps the
     investigation visible to the user.

SANDBOX DATA
  sandbox_discover_paths, simulate_firestore_write, seed-/inspect-*
  talk to the IN-BROWSER sandbox. Route "my data / my collections /
  my schema" about the sandbox to sandbox_discover_paths.

AUTH IDENTITIES
  seed_auth_users bulk-creates sandbox test identities (custom claims
  read as request.auth.token.<name> in rules); inspect_auth_users
  lists every identity. The user sees the same list in the Firebase
  panel's Auth tab.

RULES STDLIB
  firestore_rules_stdlib_list → { key, kind, description }[] of every
  callable namespace/type/global/user module. firestore_rules_stdlib_get
  ({ key }) → purpose, whenToUse, signatures, examples, mistakes.
  User-authored modules are IMPORTED, never copied. The file starts
  with rules_version = '2+modules'; then one import line per module:
      import { isAuthenticated, isOwner } from 'auth';
      import { isSpaceMember, hasSpaceRole } from 'spaces';
  Call the functions directly in allow conditions. write_file inlines
  the imports automatically when saving firestore.rules (a bad import
  returns ok:false with the exact resolution error — fix and re-save).

PUBLISH (GitHub — requires PAT in Settings → github)
  When LINKED GITHUB REPO is in the system prompt, skip step 0 — push/PR
  to that repo only (omit \`repo\` on github_push_branch /
  github_create_pull_request).
  0. github_create_repo { name, description? } — ONLY when no linked
     repo. Always creates a **private** repo with README on \`main\`.
  1. workspace_git { action: "checkout", branch } — feature branch
     (not main/master). There is NO git in bash.
  2. workspace_git { action: "commit", message } — stage all + commit.
     (run_workspace_tests green also auto-checkpoints on main.)
  3. github_push_branch { branch, repo? } — feature branches only; same
     name on remote. \`repo\` required only when no linked repo.
  4. github_create_pull_request { head: branch, title, body?, base?, repo? }
     — open a PR into the default branch (or pass base).
  Only claim publish success when github_* tools return ok:true with URLs.
  Green run_workspace_tests auto-checkpoints /workspace; use
  workspace_checkpoints to revert if needed before publishing.

SEE ALSO
  man rules, man test, man diagnostics, man shell`;

const DIAGNOSTICS_PAGE = `DIAGNOSTICS(7)               rule debugging + verification

simulate_firestore_write — does the ruleset ALLOW this request?
  Browser-only, no deploy, no network. Call right after writing rules,
  once per distinct operation/auth shape (authed create, anon read,
  owner update) — and before telling the user to deploy. Do NOT
  re-pass \`rules\` per call: the deployed ruleset is used; pass it only
  for a hypothetical you haven't written (re-shipping it N times
  bloats context). ALLOW → permitted. DENY → \`summary\` names the
  determining line; drill into trace[i].expressionTrace (per-sub-
  expression evaluation with skipped/letBinding/inlinedFrom markers)
  for the load-bearing disjunct. UNSUPPORTED → the local simulator
  lacks that surface; fall back to deploy + live check.

debug_firestore_rules — FIRST call on any rule denial.
  Auto-locates the failing event (pass eventId from traffic for a
  specific one), re-simulates with the expression trace, reads doc
  state at the path, lints, and synthesizes one \`diagnosis\` — instead
  of 4+ primitive round-trips. Quote \`summary\` to the user;
  diagnosis.likelyCause drives the fix language, failingExpression is
  the line to attribute, sandboxStateAtPath shows actual resource.data.
  It PROPOSES only — write the accepted fix via write_file.

try_rules_edit — does my proposed edit break anything ELSE?
  Replays the captured session history under the proposed rules:
  fix.unblocked[] (denials that now pass) + regression.nowDenied[]
  (working flows now broken — surface every one before applying).
  Use AFTER simulate confirms the single failing case; NOT during
  initial authoring (no history yet). stats.fixes == 0 → the edit
  doesn't fix the denial. regression.drift[] is informational.

inspect_firestore_traffic — the full session log (default 100/cap 500).
  { decision: "deny" } to pattern-spot, { pathPrefix } before a rules
  change, { origin: "listener" } for suspected listener cascades. For
  ONE denial prefer inspect_denial({ path? }).

seed_firestore_data_as_admin — FIXTURE setup only (admin bypass; the
  ruleset is NOT consulted). Seed state the rules would reject so
  read/update/delete rules can be probed. Testing whether rules ALLOW
  a write is simulate_firestore_write's job. Methods: set/delete only;
  ≤100 ops per call (TOO_MANY_OPERATIONS above); per-entry failures
  land in errors[]. Seeded paths wake live onSnapshot listeners. Use this
  for live sandbox/demo/fixture state; workspace test-file seed blocks are
  hermetic and do not populate the live sandbox. ID policy: autoId:true on
  collection paths for addDoc-style user-created docs (posts, tasks,
  messages, orders, game sessions); explicit document IDs for stable docs
  like users/{uid}, membership keyed by UID, config/singleton docs, lookup
  docs, or rule-test paths you must reference. Use data.generated paths
  from auto-ID writes in follow-up references.

generate_fixture_from_session — after the user validates a flow
  end-to-end, capture history + final state as a replay fixture
  (permanent CI regression gate). One per feature, not per write.
  Surface data.serialized in a code block + the target path
  examples/replay/ci/fixtures/<data.filename> — it does NOT write to
  disk. ok:false → empty session; reproduce the flow first.

SEE ALSO
  man workflow, man rules, man test`;

export const MAN_PAGES: Record<ManTopic, string> = {
  test: TEST_PAGE,
  rules: RULES_PAGE,
  shell: SHELL_PAGE,
  workflow: WORKFLOW_PAGE,
  diagnostics: DIAGNOSTICS_PAGE,
};
