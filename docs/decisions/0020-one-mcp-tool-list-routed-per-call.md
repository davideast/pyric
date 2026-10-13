# 0020: `pyric mcp` serves one tool list and routes each call

Status: Proposed. Blocked on the SharedWorker host decision below.

Date: 2026-10-07

## Context

`pyric mcp` picks its contract once, at startup:

- When the project's `.pyric/serve.json` pointer names a running host, the
  command relays stdio to that host's `/__pyric/mcp`. That endpoint serves the
  transport surface: the flat bridge tool names in `BRIDGE_TOOL_NAMES`,
  several dozen of them.
- Otherwise it runs the in-process product server: the ten service tools in
  `DEFAULT_MCP_TOOL_NAMES`, rendered from the method records under
  `packages/cli/src/bridge/surface/methods/`.

An agent therefore sees a different tool list depending on whether the dev
server started before the editor. A prompt, a skill or an evaluation written
against one list fails against the other.

ADR 0016 added per-call routing to the in-process server: `TargetRouter`
resolves the project's host before each call and sends the method key and
arguments to the host's `/__pyric/hosted/method`. That path only runs when no
host was up at startup, because a host at startup selects the relay instead.

There are two kinds of host, and they differ in what they can execute:

- **Node host** (`pyric sandbox --hosted`, or the Vite plugin's `hosted`
  option). The sandbox lives in the Node process. The bridge mount answers
  `/__pyric/hosted/method` by running the method record with `callMethod`
  against that sandbox, so every product method runs there unchanged.
- **SharedWorker host** (the default for `pyric sandbox --bridge` and the Vite
  plugin). The sandbox lives in a browser page. The mount answers
  `/__pyric/hosted/method` with 404. The page executes only the forwarded tool
  families, by transport tool name, over the bridge's `tool-call` frame
  (`buildSandboxDispatcher`); it has no method records and no way to run one.

## Decision

1. **One tool list.** `pyric mcp` always runs the in-process product server.
   Its `tools/list` is `DEFAULT_MCP_TOOL_NAMES`, rendered from the method
   records, whether or not a host is running and whenever it started. The
   stdio relay to `/__pyric/mcp` is deleted. The transport surface stays at
   `/__pyric/mcp` for clients that connect to it directly over HTTP.
2. **Each call routes at call time.** `TargetRouter` resolves the host before
   every call, cached for one second. It selects a host only through the
   shared `discoverServe` and `selectProjectHost` in `serve/discovery.ts`: a
   pointer in this project names it, and a server found only by the port scan
   is never used. The router's own pointer reader is deleted. A selected host
   runs the call through `callHostedMethod`; with none, the call runs on the
   in-process sandbox. Every result carries `_pyric.target`, `host` or
   `in-process`.
3. **A host appearing or disappearing changes the target, not the list.** No
   `tools/list_changed` is sent, because the list never changes. The first
   result after a change carries a notice, once per direction (ADR 0016,
   item 3). A call whose send to the host fails is reported as failed with an
   unknown outcome and is never replayed; the next call resolves the host
   again and falls back to in-process if it is gone. This replaces the relay's
   reconnect and re-`initialize` handling, which has nothing to reconnect once
   there is no relay.
4. **Identity and tenant.**
   - The held identity (`auth.impersonate`, `auth.actAsAdmin`,
     `auth.actAsAnonymous`, `auth.useAppSession`) belongs to the sandbox the
     call runs on. A switch method routed to a host sets the host's held
     identity; the in-process identity is untouched. The host-started notice
     says that calls now run under the host's identity.
   - The transport surface's per-call `as` argument accepts
     `{ uid, tenant?, claims? }`. `actorDb` in `bridge/client/dispatch.ts`
     builds its auth state with `projectIdentity` from
     `bridge/surface/identity.ts`, the function `SurfaceIdentity.projectionFor`
     delegates to, so the tenant reaches `request.auth.token.firebase.tenant`
     through the shared `normalizeAuthState` exactly as it does for a held
     identity. The page dispatcher holds no `SurfaceIdentity`, so it uses the
     pure projection rather than the stateful one.
5. **Host-only methods.** No product method is host-only today: every method
   record has a local handler. A method added later whose result exists only
   on a host stays in the tool list and, with no host, is refused the way an
   unmounted `production` method is: `ok: false`, `data.code` set to a new
   `RejectionCode`, `host_required`, and a summary that names the command
   that starts a host. It is never omitted from the list.
6. **`--in-process`** never looks for a host, as before. **`--attach`** means
   every call must run on a host: the server starts, lists the same tools, and
   a call with no host returns `host_required` instead of running in-process.

## The SharedWorker host

Decision items 1 to 6 need no wire change for a Node host. For a SharedWorker
host they do, and without one this ADR regresses the default host mode:
today, with that host running at startup, the relay gives the agent the
application's sandbox; under items 1 and 2 alone, `callHostedMethod` gets a
404 and every call runs in-process, against data the application never sees.

Options:

- **A. A method frame on the bridge.** A new `method-call` frame carries
  `{ key, args, allowProduction, identity }` from the bridge process to the
  page, and a page-side runner executes the record with `callMethod` against
  the page's sandbox. The mount answers `/__pyric/hosted/method` by forwarding
  that frame. Cost: a protocol addition (`bridge/protocol.ts`, request
  envelope validation, peer forwarding, the worker client), and a split of the
  method records into the browser-safe part and the part that reads the
  project directory (rules files, checkpoints, fixtures), which stays in the
  bridge process.
- **B. Records run in the bridge process against a remote sandbox.** The
  mount runs the record in Node with a context whose sandbox is the existing
  worker-op client (`createRemoteSandboxHandle` in `remote/index.ts`). No new
  frame. Cost: the handlers take a `LocalSandbox` and reach engine internals
  the remote handle does not expose, so each service's handlers move to a
  narrower interface.
- **C. Node host only, with a notice.** Ship items 1 to 6. With a
  SharedWorker host, every result says the host keeps its sandbox in a browser
  page, that calls run in-process, and that `--hosted` makes the host
  reachable. Cost: the regression above, for the default mode.

Recommendation: A. The page already runs the sandbox and the forwarded
families; a method frame reuses the bridge's routing, ordering, identity and
timeout handling, and keeps one execution path per method. B touches every
handler. C trades one startup-order surprise for another.

## Consequences

- Prompts, skills and evaluations target one list. The transport names remain
  an HTTP-only contract for the bridge and Studio.
- A session can span two sandboxes, as ADR 0016 describes; `_pyric.target` and
  the notices make that visible.
- Each call pays one cached pointer check, and a routed call pays one local
  HTTP round trip.
- The in-process server holds the project's `in-process` lock while a host
  runs. A running host owns different state files, so the two do not
  conflict.
