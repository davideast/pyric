# This adapter

This is the adapter that `--agent codex` selects; `codex` is its id in the
registry. It runs the agent in its non-interactive mode, printing JSON
events, with the configured model at reasoning effort `max`. `max` is the
deepest reasoning the configured model lists short of `ultra`, which also
delegates to sub-agents. The factory's generic session (`../../agent.ts`,
`../../../README.md`) does the rest.

- **Install** (`install.ts`). The agent's launcher on PATH, resolved to its
  real path, inside an npm install whose `package.json` names the agent's
  package (`CODEX_PACKAGE`); the sandbox binds that package read-only. Any
  other layout is refused, so the bind is never a launcher's parent
  directory.
- **Credential** (`login.ts`). The credential file, which the adapter
  config names, read the way `round` reads a token file: a regular file,
  owned by the current user, mode 0600 or stricter, holding a token
  credential. The forwarder sets `Authorization: Bearer <access token>` and
  the identity header from it. No bind may reach the directory that holds
  the credential file.
- **Command** (`command.ts`). The agent's HOME is the seat's own, and its
  config home is a directory under it that holds no credential. Every
  setting comes from the command line, with `--ignore-user-config` and
  `--ignore-rules`, so nothing a session leaves in its config home
  configures the next. The model provider is `pyric`, a custom provider
  whose base URL is the bridge (`http://127.0.0.1:<port><base path>`, the
  Responses wire format, the provider's auth requirement off, websockets
  off), so the agent sends every request with no credential, one HTTP
  request per turn. Web search and image generation are off. The role's
  skill is the agent's developer instructions.
- **The agent's own sandbox is bypassed**
  (`--dangerously-bypass-approvals-and-sandbox`, which the agent reserves
  for environments that are sandboxed outside it). The bwrap sandbox is the
  boundary. Nested, the agent's sandbox would also cut its commands off
  from loopback, where the dev server, the harness browser and the bridge
  listen.
- **Upstream policy** (`policy.ts`). Only `POST <base path>/responses` and
  `<base path>/responses/compact` with no query, to the upstream host on
  port 443; only the headers the agent sends (`FORWARDED_EXACT` and
  `FORWARDED_PREFIXES`); only a JSON body for the configured model. Its
  tools must all be ones the agent runs itself, `function`, `custom`,
  `local_shell` and the `namespace`s that group them, at the top or in an
  `input` item's `tools` (the agent sends them in an `additional_tools`
  item); any other type, one added later included, is a tool the upstream
  would run and is refused. Its `input` may name no URL other than an
  inline `data:` one and no file ID, since the upstream would fetch it.
- **Rate limit** (`rate-limit.ts`, `events.ts`). Every response carries a
  used-percent and a reset-at header for a primary and a secondary window;
  a request over the limit gets a 429 whose body names `resets_at`. The
  agent prints that it hit the limit, or that it gave up after a 429, with
  the reset only as local wall-clock text, so the reset comes from the
  forwarder's record.

## Refreshing the credential

The harness never refreshes the credential. The refresh token rotates on
each refresh, so a second writer would invalidate the host's credential.
The access token lasts ten days; the forwarder reads the file per request,
so a refresh made on the host is picked up at once, and it refuses with
401 from five minutes before the token lapses, saying so in the record. A
token with no `exp` is used without that margin. Refresh the credential on
the host before a run that would cross that time.

## Limits

- **A compaction is untested.** The forwarder passes `/responses/compact`
  only with a body the same policy accepts. If the agent sends it in
  another shape, a long session's compaction fails with 400 or 403, and
  the record names the reason.
- **The agent waits for the network forever.** When its requests can't
  connect (the forwarder is down), the agent prints that it is waiting for
  the network and never exits, so the session ends at its deadline.
- **The top-level body keys are not allowlisted.** The policy checks the
  model, every tool list and the input; other keys pass as the agent sends
  them.
