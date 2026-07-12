---
title: "Every sandbox call your agent can make"
navLabel: "What an agent can do"
group: "Work with an agent"
section: ""
order: 6002
description: "The 23 tools a connected agent gets in sandbox mode, grouped by what they prove, each with a call and its result."
---

# Every sandbox call your agent can make

Connect an agent (see [set up an agent](../set-up-an-agent/)) and it gets the same sandbox you do: read and write data as any identity, ask whether a rule allows a request before writing it, run a stateful session with undo, lint and compose rules from the standard library, and inspect what just happened. Twenty-three tools, identical whether the agent reaches them through `pyric dev --bridge`, `pyric bridge`, `pyric mcp` over stdio, or the Vite plugin's `pyricSandbox({ bridge: true })`.

Every response also carries `_pyric: { mode, project }`, so the agent, and you reading its transcript, always know which backend answered.

## Seed and query data as any user

Eight tools cover the Firestore data plane. Each one takes an `as` argument: omit it, or pass `'admin'`, and the write bypasses rules, the right mode for seeding. Pass `{ uid, claims? }` and the call runs as that user with rules enforced, so a read that should be denied is denied for the agent too.

| Tool | Does |
|---|---|
| `firestore_get_document` | Get one document by path |
| `firestore_list_documents` | List a collection, with `orderBy` and `limit` |
| `firestore_create_document` | Create or replace at an explicit path |
| `firestore_add_document` | Create with an auto id (mirrors `addDoc`) |
| `firestore_update_document` | Merge fields into an existing document |
| `firestore_delete_document` | Delete a document |
| `firestore_batch_write` | Up to 500 set/update/delete ops, one call |
| `firestore_query_where` | One or more where clauses, AND semantics |

An agent seeds as admin, then reads back as the user whose access it wants to prove:
```json
{
  "tool": "firestore_query_where",
  "arguments": {
    "collection": "notes",
    "where": [{ "field": "ownerId", "op": "==", "value": "alice" }],
    "as": { "uid": "alice" }
  }
}
``````json
{
  "ok": true,
  "summary": "2 matches in notes",
  "data": {
    "docs": [
      { "id": "n1", "data": { "ownerId": "alice", "text": "grocery list" } },
      { "id": "n2", "data": { "ownerId": "alice", "text": "reading list" } }
    ]
  }
}
```
Swap `"as": { "uid": "alice" }` for `"as": { "uid": "bob" }` and the same call comes back empty, not because bob has no notes, because the rule says he can't see alice's.

## Ask whether a request would be allowed

`firestore_simulate_rules` takes a rules source and a list of test cases, and returns a verdict for each, in-process, no deploy, no propagation wait. The response names the exact rule that decided it.

| Tool | Does |
|---|---|
| `firestore_simulate_rules` | Verdict per test case, with the deciding rule |
```json
{
  "tool": "firestore_simulate_rules",
  "arguments": {
    "source": "rules_version = '2';\nservice cloud.firestore {\n  match /databases/{db}/documents {\n    match /notes/{id} {\n      allow read: if resource.data.ownerId == request.auth.uid;\n    }\n  }\n}",
    "testCases": [{
      "description": "owner can read their own note",
      "expectation": "ALLOW",
      "method": "get",
      "path": "notes/n1",
      "auth": { "uid": "alice" },
      "resource": { "ownerId": "alice" }
    }]
  }
}
``````json
{
  "ok": true,
  "summary": "1/1 test cases passed",
  "data": {
    "success": true,
    "data": {
      "passed": 1, "failed": 0, "unsupported": 0,
      "results": [{
        "description": "owner can read their own note",
        "state": "PASSED",
        "decision": "ALLOW",
        "trace": [{ "ruleIndex": 0, "verdict": "ALLOW", "conditionText": "resource.data.ownerId == request.auth.uid" }]
      }]
    }
  }
}
```
An agent asserting "this rule works" without this call is guessing. With it, the assertion has a rule index and a condition string behind it.

## Open a session, write into it, undo what didn't work

Nine tools drive a stateful sandbox session: seed it, execute single writes, batch, run a declarative transaction, undo and redo, read the event log.

| Tool | Does |
|---|---|
| `firestore_simulator_create` | Seed rules and initial documents, resets prior state |
| `firestore_simulator_execute` | One write (create/update/delete), rules-checked |
| `firestore_simulator_read` | `get` or `list`, admin by default or rules-enforced |
| `firestore_simulator_batch` | Many writes, atomic: any denial rolls back all |
| `firestore_create_with_auto_id` | Create at a minted id, rules-checked like a normal create |
| `firestore_simulator_transaction` | Declarative reads-then-writes, evaluated atomically |
| `firestore_simulator_undo` | Undo the last allowed write |
| `firestore_simulator_redo` | Re-apply the most recently undone write |
| `firestore_simulator_events` | Every event seen, allowed and denied, with debug messages |

Seed, then try a write that should fail:
```json
{ "tool": "firestore_simulator_create", "arguments": {
  "rules": "rules_version = '2';\nservice cloud.firestore {\n  match /databases/{db}/documents {\n    match /notes/{id} {\n      allow read, write: if resource.data.ownerId == request.auth.uid;\n    }\n  }\n}",
  "documents": { "notes/n1": { "ownerId": "alice", "text": "hi" } }
} }
``````json
{ "tool": "firestore_simulator_execute", "arguments": {
  "method": "update", "path": "notes/n1", "auth": { "uid": "bob" }, "data": { "text": "hacked" }
} }
``````json
{
  "ok": false,
  "summary": "update on notes/n1 denied",
  "data": {
    "allowed": false,
    "debugMessages": ["Rule #0 (read,write) → deny", "Simulated: DENY"]
  }
}
```
The write never touched state. `firestore_simulator_undo` would have nothing to undo, because the denial already stopped it.

## Lint rules and pull functions from the stdlib

Four tools work on rules source directly, no session needed: catch mistakes before they deploy, and reuse tested building blocks instead of writing every rule from scratch.

| Tool | Does |
|---|---|
| `firestore_lint_rules` | Parse errors, JS-style mistakes, budget and depth limits |
| `firestore_resolve_modules` | Inline `2+modules` imports, rewrite to plain v2 |
| `firestore_rules_stdlib_list` | List every stdlib module by key, kind, description |
| `firestore_rules_stdlib_get` | Full detail for one module: signatures, examples, import line |

Lint catches a JavaScript habit that parses but never runs in rules:
```json
{ "tool": "firestore_lint_rules", "arguments": {
  "source": "...allow read: if resource.data.tags.filter(t => t == 'public').size() > 0;..."
} }
``````json
{
  "ok": false,
  "summary": "Lint found 1 error, 0 warnings",
  "data": {
    "warnings": [{
      "rule": "HALLUCINATED_METHOD",
      "severity": "error",
      "message": "`.filter()` does not exist in Firestore rules. No equivalent in rules, restructure logic instead of filtering a list"
    }]
  }
}
```
Before writing the fix, the agent looks up what's actually available. `firestore_rules_stdlib_get({ "key": "auth" })` returns the module's purpose, its two functions, and the exact line to write, `import { isAuthenticated, isOwner } from 'auth';`, ready to paste into a `2+modules` rules file.

## See what the sandbox just did

One call answers "what state is this in right now": the current rules with a lint summary, a document count by collection, and the most recent denials and requests.

| Tool | Does |
|---|---|
| `sandbox_inspect` | Rules + lint summary + document census + recent denials, one call |
```json
{ "tool": "sandbox_inspect", "arguments": {} }
``````json
{
  "ok": true,
  "summary": "rules: 412B, 0 errors / 0 warnings · docs: 3 across 1 collections · events: 5 total, 1 recent denials",
  "data": {
    "rules": { "sizeBytes": 412, "isEmpty": false, "lint": { "errors": 0, "warnings": 0 } },
    "documents": { "totalCount": 3, "byCollection": { "notes": 3 } },
    "events": { "totalCount": 5, "recentDenials": [{ "method": "update", "path": "notes/n1", "auth": { "uid": "bob" } }] }
  },
  "_pyric": { "mode": "sandbox", "project": "demo-notes" }
}
```
This is the tool a well-set-up agent calls first, before guessing at anything. A debug session that once took fifty-one tool calls and seventy-two thousand tokens of grepping to answer "why aren't my rules working" now takes one.

## The production surface, not yet CLI-wired

Everything above is the sandbox, reachable today from the CLI and the Vite plugin. Pyric also has a prod control-plane tool registry, up to forty-one tools composed by `composeMcpRegistry`: deploy rules and indexes, configure auth providers and authorized domains, replay a captured session against a candidate ruleset, discover the shape of a live database, extract composite indexes from query source, and operate Realtime Database rules and data. That registry is programmatic only today. `pyric bridge --mode prod` exits pointing at the `startServer({ prodTools })` path instead of exposing those tools over the CLI; wiring it up is a v1.1 follow-up. Until then, an agent reaches the production surface only through code you write that calls `composeMcpRegistry` directly, never through `pyric dev --bridge` or a CLI flag.

## Where to go next

The tools are the hands. [Skills](../skills/) are the method that decides which ones to call, and in what order, for a hard Firebase problem.
