# The Codex adapter

`--agent codex`: OpenAI's Codex CLI (`codex exec --json`), signed in with
`codex login` on the host, with GPT-6.1 Sol (`gpt-6.1-sol`) at reasoning
effort `max`. `max` is the deepest reasoning the model lists short of
`ultra`, which also delegates to sub-agents. The factory's generic session
(`../../agent.ts`, `../../../README.md`) does the rest.

- **Install** (`install.ts`). The `codex` launcher on PATH, resolved to its
  real path, inside an npm install whose `package.json` names
  `@openai/codex`; the sandbox binds that package read-only. Any other
  layout is refused, so the bind is never a launcher's parent directory.
- **Credential** (`login.ts`). The login in `~/.codex/auth.json`, read the
  way `round` reads a token file: a regular file, owned by the current
  user, mode 0600 or stricter, holding a ChatGPT login. The forwarder sets
  `Authorization: Bearer <access token>` and `chatgpt-account-id`. The
  credential directory is `~/.codex`, which no bind may reach.
- **Command** (`command.ts`). Codex's HOME is the seat's own, and its
  CODEX_HOME is `.codex` under it, holding no login. Every setting comes
  from the command line, with `--ignore-user-config` and `--ignore-rules`,
  so nothing a session leaves in CODEX_HOME configures the next. The model
  provider is `pyric`, a custom provider whose base URL is the bridge
  (`http://127.0.0.1:<port>/backend-api/codex`, `wire_api = "responses"`,
  `requires_openai_auth = false`, websockets off), so Codex sends every
  request with no credential, one HTTP request per turn. Web search and
  image generation are off. The role's skill is
  `developer_instructions`.
- **Codex's own sandbox is bypassed** (`--dangerously-bypass-approvals-and-sandbox`,
  which Codex reserves for environments that are sandboxed outside it).
  The bwrap sandbox is the boundary. Nested, Codex's sandbox would also cut
  the agent's commands off from loopback, where the dev server, the harness
  browser and the bridge listen.
- **Upstream policy** (`policy.ts`). Only `POST
  /backend-api/codex/responses` and `.../responses/compact` with no query,
  to `chatgpt.com:443`; only the headers Codex sends (`originator`,
  `session-id`, `thread-id`, `x-client-request-id`, `x-codex-*`,
  `x-openai-*` and the like); only a JSON body for `gpt-6.1-sol`. Its tools
  must all be ones Codex runs itself, `function`, `custom`, `local_shell`
  and the `namespace`s that group them, at the top or in an `input` item's
  `tools` (Codex 0.164 sends them in an `additional_tools` item); any other
  type, one added later included, is a tool OpenAI would run and is
  refused. Its `input` may name no URL other than an inline `data:` one
  and no file ID, since OpenAI's side would fetch it.
- **Usage limits** (`rate-limit.ts`, `events.ts`). Every response carries
  `x-codex-primary-used-percent`, `x-codex-primary-reset-at` and the
  secondary pair; a request over the limit gets a 429 whose body names
  `resets_at`. Codex prints "You've hit your usage limit", or "exceeded
  retry limit, last status: 429", with the reset only as local wall-clock
  text, so the reset comes from the forwarder's record.

## Refreshing the login

The harness never refreshes the login. Codex rotates the refresh token on
each refresh, so a second writer would sign the host's Codex out. The
access token lasts ten days; the forwarder reads the file per request, so
a refresh made on the host is picked up at once, and it refuses with 401
from five minutes before the token lapses, saying so in the record. A
token with no `exp` is used without that margin. Start Codex on the host
(or run `codex login`) before a run that would cross that time.

## Limits

- **A Codex compaction is untested.** The forwarder passes
  `/responses/compact` only with a body the same policy accepts. If Codex
  sends it in another shape, a long session's compaction fails with 400
  or 403, and the record names the reason.
- **Codex waits for the network forever.** When its requests can't
  connect (the forwarder is down), Codex prints "Reconnecting... waiting
  for network" and never exits, so the session ends at its deadline.
- **The top-level body keys are not allowlisted.** The policy checks the
  model, every tool list and the input; other keys pass as Codex sends
  them.
