# 0016: A running `pyric mcp` session follows the Node host

Status: Proposed

Date: 2026-09-21

## Context

`pyric mcp` decides once, at startup, what it talks to. If the project's
`.pyric/serve.json` names a running host, it relays stdio to that host. If not,
it starts a sandbox in its own process and persists it to
`.pyric/state/in-process.json`.

Editors start MCP servers when a workspace opens, which is before a developer
runs the dev server. So the usual order is: `pyric mcp` starts, finds no host,
and goes in-process; then `pyric sandbox --hosted -- npm run dev` starts. The two
no longer block each other, because each holds a lock only for the files it
writes. But the agent is still attached to its private sandbox. It creates a
user, and the application does not see that user. It reads a collection the
application just wrote, and finds it empty. Nothing tells it why. The session
stays that way until the editor restarts the MCP process.

Two facts shape the fix. First, the service CLI already runs a method against a
Node host: `pyric auth listUsers` in a project with a running host calls
`callHostedMethod`, which sends the method key and arguments to the host, and the
host executes the same method record against its own sandbox. Second, the
in-process MCP server and that path execute the same method records. The tool
surface the agent sees does not depend on where a method runs.

## Decision

The in-process server chooses where each call runs, at the time of the call.

1. **Per-call target.** Before dispatching a tool call, the server resolves the
   project's host pointer. If `.pyric/serve.json` names a live Node host for this
   project, the call runs there through `callHostedMethod`. Otherwise it runs on
   the local sandbox, as today. The pointer check is a file read and is cached
   for one second; a failed call to a pointer that has gone stale falls back to
   local on the next call, not the current one.
2. **Same tools either way.** The server keeps serving the surface it started
   with. No `tools/list_changed`, no reconnect, no restart. This is what
   separates this design from relaying to the host's `/__pyric/mcp`, which
   advertises the bridge's tool names and would change the list under the agent.
3. **The switch is announced, once per direction.** The first result after the
   target changes carries a notice in its summary and a `_pyric.target` field of
   `host` or `in-process`: "A sandbox host started for this project. Calls now
   run on it. Data written to the in-process sandbox earlier in this session is
   in .pyric/state/in-process.json and is not on the host." Every result carries
   `_pyric.target`, so a transcript shows where each call ran.
4. **No data moves.** In-process data is not copied into the host. The host's
   state is the application's state, and merging a private sandbox into it would
   overwrite documents by path and users by uid without the developer asking.
   A developer who wants that data runs `pyric snapshot` and seeds the host.
5. **The held identity is local to the target.** `auth.actAsAdmin` and its
   siblings set an identity on one sandbox. After a switch the host's held
   identity applies, which for a new connection is the default. The switch
   notice says so.
6. **Project identity, not working directory.** The in-process server resolves
   its project from `--project-dir` or `PYRIC_PROJECT_DIR`; host discovery reads
   the pointer relative to a directory. Both resolve to a real path and must be
   equal before a call is sent to a host. A pointer for another project is
   ignored, as the service CLI already does.
7. **Scope.** Node host only. A SharedWorker host keeps its sandbox in a browser
   page and does not execute method records for outside callers, so
   `callHostedMethod` refuses it. For that host the session stays in-process and
   the startup log keeps saying that a restart is needed to attach.
8. **`--in-process` means what it says.** With the flag, the server never looks
   for a host.

## Consequences

An agent that started before the dev server sees the application's data from the
first call after the host comes up, and is told the moment that happens. The
reverse also holds: when the dev server stops, calls return to the local sandbox
and the agent is told.

A session can now span two sandboxes. A sequence that creates a document before
the switch and reads it after will not find it. The notice exists for that case,
and `_pyric.target` makes it visible in a log. This is a smaller surprise than
the current one, where the agent and the application disagree for the whole
session with no signal.

Each call pays one cached pointer check. A call that runs on the host pays one
local HTTP round trip, the same cost a service CLI command pays today.

Resources and resource templates the discriminator surface registers read from a
sandbox too. They follow the same per-read target, or they are documented as
local only. That needs a decision before implementation.

The in-process server keeps its `in-process` lock for its lifetime whether or not
calls are running on the host, so a second in-process server is still refused.

## Open questions

1. Should the server stop persisting the local sandbox while calls run on the
   host? It writes nothing then, so this is only about the final flush at exit.
2. Is a notice in the result summary enough, or should the switch also be sent
   as an MCP logging notification for clients that surface those?
3. When the host stops mid-session, falling back to local is the symmetric
   choice. The alternative is to fail calls with "the host stopped" until the
   agent acknowledges. Falling back silently writes to a sandbox the application
   will never see.
