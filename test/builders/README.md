# App-builder harness

Cheap agents build throwaway pyric apps aimed at weak areas. The harness
records everything those apps send over the network, and a verifier agent
confirms and files only what reproduces. This directory holds the harness code. Run
data and scratch apps live outside the repo.

This is dev tooling. Nothing here runs on pull requests: `scripts/ci/plan.ts`
starts app scenarios only for `^test/apps/`, `test/apps/run.ts` never sees
this directory, and no test list in `package.json` or the workflows names it.
Builder apps never enter CI.

## Commands

```
bun test/builders/harness.ts canary [--build] [--packages <dir>]
bun test/builders/harness.ts round <round> --models <id,id> --max-budget-usd <usd> --max-round-usd <usd>
    [--builder claude|<script>] [--briefs <dir>] [--packages <dir> | --build] [--concurrency 1|2]
    [--token-file <path>]
bun test/builders/harness.ts check-briefs <round> [--briefs <dir>]
bun test/builders/harness.ts reproduce <round> <run> --list
bun test/builders/harness.ts reproduce <round> <run> <problem> --script <file.mjs>
    [--expect <text>] [--register] [--packages <dir>] [--minutes <n>]
bun test/builders/harness.ts measure [--file <measurements.jsonl>] [--runs-per-night <n>] [--json]
```

`canary` is the harness's integration test. Run it before every round.

- `--build` builds the workspace before packing it. Without it, the current
  build is packed, as `bun test/apps/run.ts` does.
- `--packages <dir>` installs tarballs already in `<dir>`.

`round` runs every brief of a round once per model (below).
`check-briefs` validates a round's briefs as `round` would and starts
nothing. `reproduce` re-runs one problem of a kept run for the verifier
(below). `measure` summarizes `measurements.jsonl`. The `run` command comes
in a later pull request.

## The skills

Three agents work a round, each from a skill in `.agents/skills/`:

- `builder-brief-writer` writes the round's briefs (Opus 5.5, with repo
  access) and checks them with `check-briefs`.
- `app-builder` is each builder's rules: `round` passes it to `claude -p` as
  `--append-system-prompt-file`.
- `builder-verifier` judges each run (Opus 5.5): valid or not, reproduced
  with `reproduce` or not, classified, shrunk to an app scenario, deduped
  against GitHub issues through REST reads, and staged. In round 1 it stages
  issue drafts in `<data root>/runs/<round>/issue-drafts/` for David and
  files nothing. It writes `verdict.json` per run.

## Setting up

Rounds run from a checkout of main that contains `test/builders/`, with
`bun install` run in it. Set these up once.

**The token file.** The model forwarder needs a long-lived token. Generate
one with `claude setup-token`, then write it to a file only you can read.
`cat` reads the pasted token from the terminal, so it stays out of your
shell history; end it with Enter, then Ctrl-D:

```
mkdir -p ~/.config/pyric-builders
(umask 077 && cat > ~/.config/pyric-builders/oauth-token)
```

Pass the file to each round with
`--token-file ~/.config/pyric-builders/oauth-token`. Only the harness
process reads it, outside every sandbox, and hands it to the forwarder and
the token scan. It never enters a log, a record, the builder's environment
or the sandbox's, and no message prints it.

`round` refuses the file, before it spends anything, unless it is a regular
file (not a link), owned by the current user, with no group or other access
(mode 0600 or stricter), holding exactly one non-empty line. The refusal
names the file and the rule, never what the file holds.

Without `--token-file`, the token comes from `CLAUDE_CODE_OAUTH_TOKEN` in
the harness's environment. When both are set, the file wins, and `round`
says so without printing either. An agent's shell does not inherit that
variable, which is why the file exists. `round` is the only command that
needs the token: `canary` and `reproduce` run with no model channel.

**The settings file.** Every `claude -p` builder runs with
`--settings <data root>/builder.settings.json`, a Claude Code permission
file. Its template is `test/builders/builder.settings.template.json`: it
allows Bash, Read, Write, Edit, Glob, Grep and TodoWrite, and denies web
access, `gh`, `firebase`, `gcloud`, `git push` and `git commit`, and
reading, searching or listing anything under `/home/david/repos`. Under
`claude -p` nothing can answer a permission prompt, so a tool the file
does not allow is denied. Copy the template into the data root:

```
mkdir -p ~/pyric-ops/assurance/builders
cp test/builders/builder.settings.template.json ~/pyric-ops/assurance/builders/builder.settings.json
```

Before it spends anything, `round` checks that the file is JSON with a
`permissions` object whose `allow` and `deny` are non-empty lists of
rules, and stops with each problem otherwise. A missing file stops it with
the `cp` command above.

**The data root.** `round` and `check-briefs` read a round's briefs from
`<data root>/briefs/<round>/` and create nothing there. When the directory
is missing they stop and print the command that makes it, for example
`mkdir -p ~/pyric-ops/assurance/builders/briefs/r1`. The brief writer
writes the briefs into it. `round` makes `runs/` and `measurements.jsonl`
itself.

**Letting an agent start rounds.** So an agent session can start a round,
add this rule to the allow list in your own `~/.claude/settings.json`,
never in the repo:

```
Bash(bun test/builders/harness.ts round *)
```

## A round

```
bun test/builders/harness.ts round r1 --models claude-haiku-5-5,claude-sonnet-5-5 --max-budget-usd 2 --max-round-usd 12 \
  --token-file ~/.config/pyric-builders/oauth-token
```

`--models`, `--max-budget-usd` and `--max-round-usd` are required and have
no default: a round spends money only at caps someone typed, one per run
and one for the round. Every run gets the same cap, so the comparison
between models is findings per dollar. Before it packs or spends anything,
`round` checks every brief, the builder and its settings file, the token,
the checkout (as the canary does),
that no run of the round has started yet (a round never redoes a run), and
that the runs times the run cap fit under the round cap. Any problem exits 2
with the whole list. The start line says what the round could spend: `6
runs (3 briefs × 2 models), $2.00 cap per run, possible spend $12.00 under a
round cap of $12.00`.

A run has started once its sandbox has (`<run>/sandbox-started`). When a
run's sandbox can't start, `round` starts no more runs, lets any under way
finish, and exits 2. That run left only empty directories, so the same
round can run again once the sandbox works.

It then packs the workspace once and runs each brief once per model, brief
by brief, at most two at once (`--concurrency 1` for one). Each run holds a
heavy-run slot (`scripts/lib/heavy-run-slots.ts`) for its whole length, so
builders never pile onto a full app run. A run is `<brief id>-<model>`, for
example `r1-1-haiku-5-5`.

**The builder is injectable.** `--builder claude` (the default) starts

```
claude -p <prompt> --model <id> --max-budget-usd <usd> --output-format json \
  --settings <data root>/builder.settings.json --append-system-prompt-file .agents/skills/app-builder/SKILL.md
```

and needs `claude` on PATH, both files, and the token, from `--token-file`
or `CLAUDE_CODE_OAUTH_TOKEN` (see Setting up); the run's HOME holds no
login. **The token never enters the sandbox.** claude gets a placeholder in
its place and `ANTHROPIC_BASE_URL` pointed at the model channel (below),
whose forwarder, outside, holds the real token. `--builder <script>` starts
`node <script>` in the same place with the same environment, less the
placeholder: `fixtures/fake-builder.mjs` is a scripted builder with no
model, which is how `round` is tested end to end. A scripted builder's
forwarder holds no token and refuses every request.

**Each run, in order** (`builder-run.ts`):

1. Lays out `<builders root>/<round>/<run>/`: the starter app for the
   brief's framework (`starters/<framework>/package.json`) with its Pyric
   dependencies pinned to the tarballs (`prepareApp`, which calls
   `pinPyricPackages`), a fake Firebase config (a `demo-<run>` project and a
   fake API key), `brief.md` and `brief.json`, and `docs/site/`, the site's
   Markdown from `packages/site-docs/src/content/` at the same commit.
2. Starts the run's own sandbox, as the canary does, and installs the app
   inside it (`app-install.ts`, the canary's install).
3. Writes `docs/conformance/`: the conformance pages the installed
   `@pyric/cli/conformance/docs` ships, exported inside the sandbox
   (`docs-export.mjs`). So a builder reads the docs of the tarballs it builds
   with.
4. Enters the run phase (`run-phase.ts`) into the sandbox, with the model
   channel's forwarder (below) listening outside it. The phase checks it is
   inside the sandbox, starts the channel's bridge and the harness browser,
   and runs the builder in `app/` under the recorder with the run's scratch
   HOME, for at most the brief's wall-clock minutes. The phase's
   environment is built from nothing (PATH, HOME, LANG, TMPDIR, where
   Playwright's browsers are), so nothing else of the harness's reaches it.
5. Appends the forwarder's record to the run's `network.jsonl`, then looks
   for the harness's token in every file it is about to keep (below).
6. Reads the builder's `report.json`, its usage, and the network record, and
   keeps the run in `<data root>/runs/<round>/<run>/`: `report.json` (the
   builder's report and the harness's fields), `brief.json`,
   `network.jsonl`, `logs/` and `app.tgz` (the app without `node_modules`).
7. Appends the run's line to `<data root>/measurements.jsonl`.

The sandbox's uid 0 is the harness's own uid, so a builder can take the
owner's permissions away inside the run root. Before step 5, the harness
gives the owner back read and write on every file and search on every
directory there, following no link (`owner-access.ts`). The measurement
line goes in as soon as the run's record is built, before the token scan
and the copies. A failure after that point, such as a file the harness
still can't read, stops the copies there: `report.json` is kept, but the
copies after the unreadable file, `app.tgz` and `phase-output.log` are not.

When the sandbox left a link on a file step 5 or 6 would read or append to
(`planted-links.ts`), or the harness can't check it, merge into it or
write it, the run still gets its record and its measurement line. The
harness skips the merges for a link, and every such file in the reads,
the token scan and the copies, and keeps the phase's output, redacted, as
`phase-output.log` beside `report.json`, where no file of the run root is
copied. `harness.plantedLinks` names each file, relative to the run root,
with why (`network.jsonl: network.jsonl is a link`), and the verifier
treats the run as invalid.

`round` exits 0 when every run ended with a valid report and no planted
link, 1 otherwise.

**Where things go.** Scratch is under the builders root (`~/pyric-builders`,
or `PYRIC_BUILDERS_DIR`). Run data is under the data root
(`~/pyric-ops/assurance/builders`, or `PYRIC_BUILDERS_DATA_DIR`): briefs in
`briefs/<round>/` unless `--briefs` names a directory, the runs, the
measurements, and `builder.settings.json`, the Claude Code permission file.
The repo ships only its template; the copy a round uses lives in the data
root.

## Reproducing a problem

```
bun test/builders/harness.ts reproduce r1 r1-1-haiku-5-5 --list
bun test/builders/harness.ts reproduce r1 r1-1-haiku-5-5 p1 --script repro.mjs --expect 'permission-denied'
```

`--list` prints each problem of the kept run by its selector: a builder
problem's id, `refusal-allowed-<n>` (the n-th must-be-refused action the
builder reported allowed), or `google-host:<host>`. Before it starts a
sandbox, `reproduce` checks (exit 2 with every problem): the run's kept
`report.json` and `app.tgz`, that the selector names a problem, the script
(`.mjs`, `.js` or `.cjs`), the checkout as the canary checks it, and that
the tarballs in `--packages` (`dist/packages` by default) have the sha256
the run recorded. A reproduction on other tarballs tests other code, so it
refuses.

It then makes up to two tries and stops at the first that reproduces. Each
try, in `<builders root>/<round>/<run>.repros/<slug>/<stamp>-try-<n>/`:

1. extracts `app/` from `app.tgz`, pins its Pyric dependencies to the
   tarballs, writes the fake config again and copies the script in as
   `pyric-repro.<ext>`. These writes happen outside the sandbox into the
   builder's work, so each target must be a plain file or absent, and `app`
   a plain directory. The app's own `.npmrc` is renamed `.npmrc.from-builder`,
   so only the harness's flags configure npm;
2. starts the try's own sandbox and installs the app inside it, offline from
   the shared cache. Unlike a round's run, it never falls back to installing
   on the host: the app's `package.json` is the builder's, and could name any
   dependency or source. A cold cache makes the try inconclusive;
3. enters the run phase (`run-phase.ts`) with `modelChannel: false`: the
   sandbox inventory first, then the harness browser and
   `node [--import @pyric/cli/register] pyric-repro.<ext>` in the app under
   the recorder, for at most `--minutes` (10 by default). There is no bridge,
   no forwarder and no token: nothing the script starts can leave the
   sandbox.

A try reproduces a builder problem or an allowed refusal when the script
exits 1, and with `--expect`, only when its output holds that text. Exit 0
means pyric behaved as production does. Any other exit or a timeout is
inconclusive (`repro-verdict.ts`). A `google-host:` problem reproduces when
the try's network record reaches for that host again, whatever the exit.

Any other failure of a try (the extract, the install, the phase) is an
inconclusive try too, kept like the rest. Once a try's sandbox has stopped,
the harness checks that each file it reads or appends to (`network.jsonl`,
the NetLog, the phase's result and logs) is absent or a plain file reached
through plain directories (`planted-links.ts`), since the sandbox could have
left a link there to a file of the host's; a round's run checks its own the
same way. A try with such a link is invalid, not inconclusive: something in
the builder's app or the script reached for the host's files. The tries stop
there, and the reproduction is invalid whatever the other try found.

The command exits 0 when a try reproduced, 1 when a try found pyric
behaving as production does and none reproduced (unconfirmed), 3 when no
try could tell (inconclusive), and 4 when a try planted a link (invalid). It keeps `repro.json` (each try's outcome, reason, exit and
Google hosts), the script, and each try's `network.jsonl` and `logs/` in
`<data root>/runs/<round>/<run>/repros/<slug>/<stamp>/`, and never
overwrites an earlier reproduction. The slug is the selector in lowercase
letters, digits and dashes (`repro-target.ts`), since the builder chose the
ids. It files nothing.

Both builders and repro scripts get `PYRIC_BUILDER_PLAYWRIGHT`, the
harness's own `@playwright/test` entry: the run's app installs offline and
has no Playwright, and the client must match the browser server's version.

## The model channel

A builder is `claude -p`, and it runs inside the sandbox with every tool it
starts, so the model API needs a way out that nothing else has, and that
carries no credential the sandbox could read (`model-channel.ts`):

- the **bridge**, inside the sandbox, listens on 127.0.0.1 and pipes each
  connection to `<run>/model.sock`. claude reaches it as
  `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>`, in plain HTTP, holding
  `CLAUDE_CODE_OAUTH_TOKEN=pyric-builder-placeholder-not-a-token`.
- the **forwarder** (`model-forwarder.ts`), in the harness, outside the
  sandbox, listens on that socket and reads one request per connection. It
  passes on only `POST /v1/messages` and `POST /v1/messages/count_tokens`,
  each with or without `?beta=true` (`model-policy.ts`). It sends on only
  an allowlist of the request's headers: `anthropic-version` and
  `anthropic-beta` as sent, `content-type`, `accept`, `user-agent`,
  `x-stainless-*`, and the `x-claude-code-*` headers the gateway page names.
  It sets `Authorization: Bearer <token>` from the harness's own
  environment and sends the request to `api.anthropic.com:443` over TLS.
  The response streams back unbuffered. Everything else is refused: a
  CONNECT, an absolute URI, any other method, path or query (claude's
  `HEAD /api/hello` warm-up and `GET /v1/models` lookup among them) gets
  `403`; a head it can't read gets `400`, one over 16 KiB `431`, one that
  doesn't end within 10 seconds `408`.
- the forwarder also reads the **body** (`message-body.ts`) against an
  allowlist taken from the
  [Messages API reference](https://platform.claude.com/docs/en/api/messages/create),
  and fails closed:
  - the body must be a JSON object nested no deeper than 64 levels, which
    a loop measures before any walk of the body, and must repeat no key at
    any depth (`strict-json.ts`), so it can't be checked as one request and
    run as another. If checking a body throws anyway, the builder gets
    `400` and the connection is recorded;
  - top-level fields must be on the list, case included. `mcp_servers`,
    `container`, `context_management`, `fallbacks`, `diagnostics` and any
    other field get `400` with the API's own wording, `<field>: Extra
    inputs are not permitted`, which claude matches to retry without
    `context_management`. `service_tier` may only be `standard_only`;
  - content blocks in `messages` and `tool_result` content must be
    client-side types (text, image, document, search result, thinking,
    tool use and result, tool reference). The system prompt and a search
    result's content take text only.
    An image's source must be `base64`, a document's `base64` or `text`: a
    `url` source has Anthropic fetch it, and a `file` isn't bounded by the
    body's size;
  - tools must be client tools. An entry with a `type` (a server tool such
    as `web_search_*`, `web_fetch_*`, `code_execution_*` or `advisor_*`) gets
    `400` naming the type after `Input tag`, the wording claude retries on
    without its advisor tool;
  - a Messages request needs a positive integer `max_tokens`.
- a forwarded request that hasn't ended after 10 minutes, claude's own
  default request timeout, is aborted (`504` when nothing came back yet),
  which frees its slot and keeps its whole reservation.

Why a placeholder `CLAUDE_CODE_OAUTH_TOKEN` and not `ANTHROPIC_AUTH_TOKEN`:
with the OAuth variable set, claude authenticates as a subscription and
sends the token as `Authorization: Bearer` with the OAuth capability in
`anthropic-beta`, which the API needs to accept a `claude setup-token`
token; `ANTHROPIC_AUTH_TOKEN` is a gateway's key and sends no such beta.
Sources: [env vars](https://code.claude.com/docs/en/env-vars),
[authentication precedence](https://code.claude.com/docs/en/authentication),
[gateway protocol](https://code.claude.com/docs/en/llm-gateway-protocol)
(paths, headers to forward, streaming).

**Every connection is recorded**, forwarded or refused, malformed, cut off,
or timed out: one `model-channel` line with the request line (shortened,
unprintable bytes escaped), the host it named, the reason, the status, and
for a forwarded request the model, tokens, metered cost, the worst case it
reserved and what the meter charged. It also names the headers it dropped
and the server tools it refused, never a header's value. The forwarder
writes `<builders root>/<round>/<run>.model-channel.jsonl`, beside the run
directory, which the sandbox can't see; `round` appends those lines to the
run's `network.jsonl` once the sandbox has stopped.

**The forwarder meters the round** (`model-meter.ts`). Before it sends a
request on, it reserves the request's worst case: a token per byte of the
body, plus an allowance per image or document and a fixed overhead, all
priced as cache writes, plus `max_tokens` of output. The request gets `403`
when that doesn't fit what is left of the run's `--max-budget-usd` or the
round's `--max-round-usd`, with every open reservation counted in full, so
requests sent at once can't pass a cap between them. A run has at most two
requests in flight; a third gets `429` with `retry-after: 2`. When the
response ends, the reservation settles to the cost of its usage
(`message_start` and `message_delta` in a stream, `usage` in JSON). A
response cut off keeps its whole reservation, and a `200` with no usage
costs its reservation, except a token count, which costs nothing.

The prices (`model-prices.ts`) are the first-party rates read from the
[pricing page](https://platform.claude.com/docs/en/about-claude/pricing) on
2026-10-29, by exact model id. They err high: any id the table doesn't name
exactly is charged its highest rate (Claude Opus 4 and 4.1's $15 and $75),
cache writes the one-hour rate, cache reads a tenth of input, Claude Haiku
5.5 its long-prompt rate, fast mode twice and US-only inference 1.1 times.
claude still gets `--max-budget-usd` too.

**The token scan.** Before `round` keeps anything, it looks for the token's
value in the report, the brief, `network.jsonl`, `logs/` and the app
(`token-scan.ts`). Kept copies have it replaced with `[redacted: the
harness token]`; when any file of the app held it, `app.tgz` is withheld.
The run record lists the files (`harness.tokenFoundIn`), never the value.
Since the token never enters the sandbox, any entry there is a defect.

Claude Code's other traffic is turned off with
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` and the telemetry switches.

## The brief

One JSON file per brief, validated by `brief.ts` before a round starts. The
builder gets it as `brief.md`, in the plan's layout, and as `brief.json`.

| Field | Holds |
|---|---|
| `id` | `<round>-<n>` |
| `targetArea` | `{ area, whyWeak }`: one area from the evidence map, and why it is weak |
| `stressDimensions` | one or two of `scale`, `lifecycle`, `integration`, `combination`, `concurrency` |
| `appIdea` | one paragraph |
| `framework` | `next-16`, `vite` or `node-server` |
| `features` | the pyric surfaces, named as the docs name them |
| `userJourney` | what a person does, step by step |
| `mustBeRefused` | two to five `{ action, firebaseDoc, productionAnswer }`; `firebaseDoc` must be an `https://firebase.google.com/` page |
| `limits` | `{ wallClockMinutes }` |

The model and the dollar cap are the round's, not the brief's, since each
brief runs once per model at one cap. A brief with a field the shape does
not name fails.

## The report

The builder writes `report.json` in its run directory; `report.ts`
validates it:

```
steps:     [{ n, did, result: worked | broke | stuck, log }]
worked:    [short lines]
problems:  [{ id, summary, step, docsLedMeToExpect: { page, quote } | null,
              whatHappened, errorText, logs: [paths], reproHint }]
refusals:  [{ action, firebaseDoc, productionAnswer, pyricAnswer,
              result: refused | allowed | not-attempted }]
stuck:     { where, lastError, whatIWouldTryNext } | null
```

A report with any other field fails, so a builder can't write the fields
only the harness writes. The kept `report.json` is
`{ builder, harness }` (`run-record.ts`): `builder` is the report, or null
when it is missing or invalid, and `harness` holds the run's identity and
cap, the commit and each tarball's sha256, how the builder ended, the
report's state and errors, every Google-host and metadata event in the
network record, whether the browser's record is cut short, the usage from
claude's result line (null when it printed none), the must-be-refused
actions the report leaves out, and the problems the harness adds itself:

- each must-be-refused action the builder reports pyric `allowed`;
- each Google host or metadata address the run reached for, one per host,
  with every layer that saw it. Chromium's UDP connect to a Google DNS
  address, its IPv6 check, sends no packet and is not counted.

## Measurement

`measurements.jsonl` is append-only (`measurement.ts`). `round` appends a
`builder` line per run: model, brief, the run's cap, the cost claude gave
(null when it printed none), the cost the forwarder metered, tokens, turns,
wall time (null when the run phase never said how the builder ended), the
report's state, problems reported (the builder's plus the harness's) and
Google-host events. The verifier, in a later pull request, appends a
`verification` line per judged run: its round and run, its cost and tokens,
and its count per verdict (confirmed by class, duplicate, needs capture,
unconfirmed, builder's own bug, invalid). A bad line is an error naming its
line number, never skipped.

A run's builder cost is claude's figure, or the metered one when claude gave
none (it crashed, or was stopped at its wall-clock cap). No run counts as
free.

`measure` joins them by round and run id (run ids repeat across rounds) and
prints, per model: cost per builder run,
cost per verifier report, confirmed new findings per app (confirmed, not
duplicates, per judged run), the share of reported problems the verifier
threw out (unconfirmed, builder's own bug, invalid run), cost per confirmed
new finding, and the 90th-percentile cost of a run plus its verification.
The nightly model is the one with the lower cost per confirmed new finding;
with `--runs-per-night <n>` it also prints the nightly cap, `n` times that
model's 90th-percentile cost.

## The canary

A scripted builder with no model. In order, it:

1. Checks the checkout: its own `node_modules` (the sandbox binds only the
   repo, so a worktree linking another checkout's has none inside), and
   without `--build` or `--packages`, a `dist/` in each package
   `scripts/pack-packages.sh` packs. A missing one exits 2 with what to run.
   Then runs the unit tests (`bun test ./test/builders`).
2. Takes a heavy-run slot (`scripts/lib/heavy-run-slots.ts`), so it never
   runs beside a full app run or a full suite.
3. Starts the run's sandbox (below) and checks it from inside. Where it
   can't, or a check fails, the harness refuses to run and exits 2.
4. Packs the workspace (`packWorkspace` from `test/apps/install.ts`) and
   copies `canary/app/` into `<root>/canary/<stamp>/app/` with its Pyric
   dependencies pinned to the tarballs (`prepareApp`), then writes a fake
   Firebase config: a `demo-` project id and a fake API key.
5. Runs `npm install --ignore-scripts --offline` inside the sandbox, from
   the shared npm cache, under the Node recorder. Only when the cache is cold
   for the app (npm reports `ENOTCACHED`) does it install outside the
   sandbox, still with `--ignore-scripts` and under the recorder. Nothing is
   planted in either.
6. Runs the plant phase (`canary/plant-phase.ts`) inside the sandbox. It
   first runs the sandbox inventory itself, so a caller that skips the
   sandbox fails before any plant runs. Then it starts the harness browser, the app's Vite dev server, and
   `node --import @pyric/cli/register node-plants.mjs` under pyric's default
   guard, each under the recorder, and plants requests:
   - from Node: `fetch`, `http.request` and `https.request`, raw `net` and
     `tls` sockets, `dns.lookup`, a request through a local proxy and a
     worker-thread `fetch`, to Google hosts and to the metadata server
     (169.254.169.254, also written `2852039166`, and
     `metadata.google.internal`);
   - from Chromium: a page `fetch`, an image, a WebSocket to
     `*.firebaseio.com` and a service-worker `fetch`;
   - from clients no recorder hooks: a Bun `fetch` to `oauth2.googleapis.com`
     and to 169.254.169.254, and `curl` to
     `firebaseinstallations.googleapis.com`.
7. Checks that each planted request is in the network record and was refused
   by the layer meant to refuse it: the Node preload for Node plants
   (`PYRIC_BUILDER_REFUSED`), Chromium's resolver rules for browser plants
   (`ERR_NAME_NOT_RESOLVED`), and the sandbox for the unhooked plants. The
   sandbox's resolver records an unhooked plant's lookup, and its catch-all
   listener records a connection by address, such as the Bun fetch to
   169.254.169.254. A Node or browser plant that only the sandbox stopped
   fails the check, since that layer's own refusal is what is under test.
   Each Node plant is judged by its own events: `node-plants.mjs` writes a
   marker line to `network.jsonl` before each plant, and the verdict reads
   only that plant's process's lines after its marker, since several plants
   share a host. It also checks that a local request from each side worked
   and is not flagged, that the Node layer allowed no Google host, that no
   browser TCP socket left loopback, and that the resolver and the catch-all
   listener saw only the unhooked plants. Each side must report exactly the
   plants `canary/plant-names.ts` names, so an empty or shortened report
   can't pass. It exits 1 if any check fails.

Before planting anything, each side checks its own refusal path. The Node
plants stop unless the recorder loaded in their process. The browser plants
first fetch from a server they run on 127.0.0.2; that fetch must fail without
reaching it, or the resolver rules are not in effect and nothing is planted.

Each run leaves `<root>/canary/<stamp>/` with `app/`, `home/`, `logs/` (one
file per process), `network.jsonl`, `chromium-netlog.json`, the sandbox's
`resolv.conf` and `hosts`, `plants.json` (what each plant saw) and
`canary.json` (that and the verdict). `<root>` is `~/pyric-builders`, or
`PYRIC_BUILDERS_DIR`. The harness never removes a run; clearing that
directory clears them all.

## The sandbox

The outermost layer, and the one that does not depend on hooking a runtime.
A hunter's in-process Node trap once missed Bun's `fetch`, and a request
reached `oauth2.googleapis.com`. A network namespace alone is not enough on
this machine either: it keeps the host's whole file system, including
`/run/WSL`, `/run/user/<uid>` and `/mnt`. So every process of a run's
install, plant or build phase runs in a bubblewrap sandbox (`namespace.ts`)
with an allowlist file system and a network namespace of its own:

```
bwrap --unshare-all --uid 0 --gid 0 --cap-add CAP_NET_ADMIN --cap-add CAP_NET_BIND_SERVICE <layout> --info-fd 3 \
  sh -c 'ip route add local 0.0.0.0/0 dev lo table local && ip -6 route add local ::/0 dev lo table local && exec node recorder/holder.mjs'
nsenter -t <child pid> -U -m -n -p -i -u -C --preserve-credentials --root env -C <dir> <command>
```

**The layout.** The sandbox sees only what the harness binds in:

- read-only: `/usr` (with the `/bin`, `/lib`, `/lib64` and `/sbin` links), a
  short list of `/etc` entries (the loader cache, `ssl/certs` and
  `ssl/openssl.cnf` but not the root-only `ssl/private`, fonts, `passwd`,
  `group`, `nsswitch.conf` and similar: `ETC_ENTRIES`), the harness's view
  of its repo (below), the packed packages, the `node` and `bun` installs,
  and Playwright's browsers;
- read-write: the run directory only;
- the npm cache read-only, with an overlay mounted on it from inside, before
  any run command enters, whose upper layer is in the sandbox's `/tmp`. npm writes local tarballs into its
  cache even offline; the overlay keeps those writes in the sandbox, and the
  shared cache never changes;
- fresh: `/dev`, `/proc` (its own pid namespace), `/tmp` and `/run`, both
  tmpfs, and the run's own `/etc/resolv.conf` (naming 127.0.0.1) and
  `/etc/hosts` (loopback names only).

There is no `/mnt`, no `/run/WSL`, no `/run/user` and no home directory
beyond the bound paths. The network namespace has only `lo`.

**The harness's view of its repo** (`harness-view.ts`). A builder works from
the public docs and the packed packages, so the sandbox never gets the
repo: its tests, its internals and its git history aren't there, and a
`cat <repo>/packages/pyric/src/...` from the builder's shell finds no file.
What a builder can read of pyric is what a real install of the published
packages holds, and that includes their `src/` under
`app/node_modules/pyric*` and `app/node_modules/@pyric/*`. David decided it
stays readable: the app-builder skill's rule, not the sandbox, keeps a
builder out of it, and the verifier marks a run that reads it invalid, the
same as one that planted a link. The harness keeps no record of a builder's
tool calls, so the verifier looks for those reads in the report, `logs/`
and the app (`.agents/skills/builder-verifier/SKILL.md`). The sandbox
gets, at the paths the host has them, `test/builders` (the run
phase, the recorder, the inventory, the docs export, the canary's plants),
the few repo files that code imports (`test/apps`' process driver and its
helpers, and `packages/cli/src/google-endpoints.ts`, the Google endpoint
catalog the recorder classifies hosts with), and zod and Playwright's
client, with their dependencies, at `node_modules/<name>`. Nothing else of
`packages/`, no other test, and no `.git`. A file the harness's code starts
importing inside the sandbox goes on that list: `harness-view.test.ts`
walks the imports of every entry point that runs inside and fails offline on
one that isn't bound.

**The holder.** bwrap's command adds two routes that send every IPv4 and IPv6
address to loopback, then runs `recorder/holder.mjs`, which holds the sandbox
open. It starts the resolver, `recorder/dns-log.mjs` on 127.0.0.1:53, which
records every DNS query in `network.jsonl` and answers NXDOMAIN, so a lookup
from Bun, curl or any other runtime is recorded. It also starts the catch-all
listener, `recorder/catch-all-log.mjs` on ports 80 and 443, which records
each TCP connection with the address the client dialed and resets it before
reading a byte. A connection by address needs no lookup, so the catch-all
listener is what records it.

**Privileges.** Processes run as uid 0 of the sandbox's own user namespace,
which bwrap maps to the harness's own uid, but with no capabilities. Only the
setup is privileged: the holder gets `CAP_NET_ADMIN` and
`CAP_NET_BIND_SERVICE` to add the routes and bind ports 53, 80 and 443, and
one entered command mounts the npm cache's overlay. Every other command
enters through `setpriv --bounding-set=-all --inh-caps=-all --ambient-caps=-all
--securebits=+noroot,+noroot_locked`. Without that, a command nsenter starts
in the sandbox's user namespace has every capability there, enough to
remount a read-only bind of a host directory (the harness's files, the npm cache's
lower layer, the node and bun installs, Playwright's browsers) read-write,
and since those files belong to the harness's uid, which is uid 0 inside,
writes would reach the host. With an empty bounding set and `noroot`
locked, no command, and nothing it execs, can regain a capability, so it
can't remount, mount or change the routes. What holds the containment: the
file system layout (nothing of the host outside it is mounted, and every
host bind but the run directory is read-only and stays so) and the network
namespace (loopback only).

**Entering.** A command enters through the child pid bwrap reports on
`--info-fd`, drops its capabilities as above, with an explicit list of
namespaces (user, mount, network, pid,
IPC, UTS, cgroup). `nsenter -a` would also name the time namespace, which the
sandbox shares with the host, and nsenter can't enter that. The command's
directory is set inside the sandbox with `env -C <dir>`, not with nsenter's
`--wd=<dir>`: that opens the directory on the host before entering, which
leaves the command's working directory on a host mount outside the
sandbox's root.

**The check.** Before any other work the harness checks from inside that
loopback is the only interface, then runs `sandbox-inventory.ts` as an
entered command, which confirms that:

- `ip -o link` and `os.networkInterfaces()` list only `lo` (Node leaves out
  an interface with no address; `ip` does not);
- `/etc/resolv.conf` names only 127.0.0.1;
- `/mnt`, `/run/WSL` and `/run/user` don't exist;
- its own `CapEff` and `CapBnd` are 0;
- every mount in `/proc/self/mountinfo` outside the run's own directories is
  `ro`, unless it is a fresh in-memory file system (tmpfs, proc, devpts,
  mqueue, or an overlay whose upper layer is in `/tmp`) or one of the device
  nodes bwrap's `--dev` binds (`/dev/null` and the like);
- no socket file exists anywhere under `/` outside the run's own
  directories (the run directory, the sandbox's `/tmp`, and `TMPDIR` only
  when it is inside that `/tmp`). The walk skips `/proc` and `/sys` and
  follows no symlinks. A directory it can't list is a problem, since it
  could hold a socket the walk didn't see, unless it is on the short
  `UNLISTABLE` list, each entry with its reason (today only the WSL
  kernel-modules image's `lost+found`).

The inventory only looks; it never tries to reach anything. The plant phase
runs it again before planting. Without `bwrap`, `nsenter` or `ip`, or when
any check fails, the harness refuses to run (exit 2); there is no fallback.

The cloud routine needs an equivalent egress block of its own: a sandbox
network policy, or a sandbox like this one, that leaves only loopback
reachable for builder processes. The recorders alone are not enough.

## The network recorder

Pyric's own net guard (`packages/cli/src/register/net-guard.ts`) is part of
what builders test (#1475), so the recorder does not use it.

**Node** (`recorder/node-egress.mjs`). The harness puts
`NODE_OPTIONS=--import <node-egress.mjs>` and `PYRIC_BUILDER_NETWORK_LOG` in
every process a run starts. The preload appends one JSON line per event:

- each request at creation, from the `undici:request:create` channel (fetch
  and undici) and the `http.client.request.*` channels (`http.request`,
  `https.request`);
- each DNS query: `dns.lookup` and the `resolve*` functions, callback and
  promise forms, `Resolver` instances included;
- each client socket connect, at `net.Socket.prototype.connect`, which
  `net.connect`, `tls.connect`, the http Agents and undici all reach.

For a Google host or the metadata server it writes the line first and then
refuses: the query fails, or the socket is destroyed before it connects, with
the code `PYRIC_BUILDER_REFUSED` and a `[pyric-builders recorder]` line on
stderr. It loads itself into worker threads that Node would start without it
(CommonJS `eval` source, or the worker's own `execArgv`). A process started
with the preload but without `PYRIC_BUILDER_NETWORK_LOG` does not start.

Each line has `layer`, `pid`, `thread`, `process`, `kind` (`request`, `dns`,
`connect`), `via`, `host` and the classification below, and `action`:
`refused` or `allowed` for a query, a socket or a proxied `http` request, and
`recorded` for a request at creation, whose refusal comes at its query or
socket.

**Browser** (`browser-server.ts`, `recorder/chromium-netlog.ts`). One
Playwright Chromium per run, launched as a browser server with
`--log-net-log` and `--host-resolver-rules` that leave only 127.0.0.1 and
localhost reachable. Chromium applies the rules to IP literals too, so the
metadata address fails like any other host, with `ERR_NAME_NOT_RESOLVED`,
before a socket opens. A builder connects with
`chromium.connect(process.env.PYRIC_BUILDER_BROWSER_WS)`. The NetLog sees
what `context.route` misses (#1606): WebSockets and service-worker requests.
When the browser stops, the harness appends each request (`url`, `method`,
`netError`) and each TCP and UDP connect to `network.jsonl`.

**Classification** (`recorder/google-hosts.ts`). Pyric's catalog decides
first (`lookupGoogleEndpoint`, in the catalog's one spelling from
`normalizeHostname`). A wider list of Google suffixes catches the rest:
`googleapis.com`, `google.com`, `gstatic.com`, `firebaseio.com`,
`firebasedatabase.app`, `firebaseapp.com`, `web.app`, `firebasestorage.app`,
`appspot.com`, `cloudfunctions.net`, `run.app`, `googleusercontent.com` and
`metadata.google.internal`. A Google host the catalog does not list is marked
`catalogGap`, the class of miss #1475 found.

## Limits

- **The Node layer is in-process.** A tool that strips `NODE_OPTIONS` from
  its children starts them unrecorded, and Bun never evaluates a Node
  `--import`, so a process run with `bun` is unrecorded there. Inside the
  sandbox such a request still fails, and its lookup is recorded by the
  sandbox's resolver. The canary covers Vite, npm, the register path, Bun
  and curl.
- **A cold npm cache installs outside the sandbox.** When the shared cache
  lacks something the app needs, `npm install --ignore-scripts` runs outside
  once to warm it. The Node recorder refuses any Google host it reaches for,
  but the kernel does not block that install. `reproduce` never does this
  for a builder's app. A builder that installs new
  packages itself (a later pull request) needs a registry it can reach from
  inside the sandbox, such as a local mirror.
- **The catch-all listener takes ports 80 and 443 only.** A connection by
  address to another port gets `ECONNREFUSED` without a record, or reaches
  one of the run's own loopback listeners on that port, since every address
  routes to loopback. Either way it stays on the machine.
- **A proxied undici request is recorded, not refused.** The
  `undici:request:create` channel gives no safe way to fail the request. A
  proxied `http.request` is refused. The proxy, when it is a Node process the
  run started, refuses the upstream connect itself.
- **Playwright's browser server and `connect` fail under Bun 1.3** (the
  WebSocket handshake to the server fails). The server runs in a Node child,
  and a builder's Playwright script runs under Node.
- **Chromium connects a UDP socket to `[2001:4860:4860::8888]:443`** to check
  IPv6 reachability. A UDP connect sends no packet; it appears in the record
  as a `udp` connect and is not treated as a request.
- **The NetLog is written when the browser closes.** A browser killed before
  it closes leaves a NetLog the reader still parses, up to its last whole
  line. When `browser-server.ts` kills the browser after its stop times
  out, it appends an `incomplete` marker (`layer: browser`, `kind:
  incomplete`) to `network.jsonl`, and a run's record says
  `browserIncomplete`, so missing browser events read as unknown, not as
  absent.
- **A builder can't install new packages.** The sandbox has no registry. A
  builder works with the starter's dependencies; one that needs more says so
  in its report. A local mirror inside the sandbox would lift this.
- **Anything in the run can spend the token, though nothing there can read
  it.** The channel takes Messages requests from any process in the
  sandbox, and the forwarder puts the token on each. So a process there can
  run model requests on the subscription, up to the run and round caps, but
  can't call another API with it, take it away, or reach another host.
- **The placeholder path is untested against a real claude.** No test runs
  claude or reaches the model API; the forwarder's tests use a local server
  and a made-up credential. The docs say claude sends a
  `CLAUDE_CODE_OAUTH_TOKEN` as `Authorization: Bearer` with the OAuth beta
  to `ANTHROPIC_BASE_URL`, but not whether it checks the token's form first.
  If it does, or sends something else, the first round fails at the first
  request (401 or 403 in the run's record), and spends nothing.
- **The reservation is an estimate of the worst case.** A token per byte
  bounds text. An image or a PDF is priced by its pixels or pages, and the
  allowance per block (10K tokens for an image, 200K for a document) could
  in principle be passed by a large PDF. A response that costs more than its
  reservation is charged in full when it settles, so the next request is
  refused, but that one response can carry a run past its cap. Charges
  beyond the body's tokens can't arise: server tools, URL and file sources,
  fallbacks, server-side compaction and priority tiers are all refused.
- **The price table is dated** (2026-10-29). A price rise would make the
  meter err low until the table is updated.
- **The header allowlist can drop a new capability.** The gateway page asks
  gateways to pass every `anthropic-*` header through, since Claude Code
  adds capabilities as new headers. The forwarder drops any header not on
  its list, so such a capability fails or turns off. Each request's line
  names the headers dropped, so a run shows it.
- **The body allowlist may refuse a field claude sends.** It fails closed:
  a field, block or source not on its list is refused, not guessed at. If
  the first real run shows Claude Code sending one, the run fails loudly
  (the field's name is in the record), and the field is added on purpose
  once it can be priced.
- **The in-flight cap slows claude.** claude runs subagents and side
  requests at once. Past two in flight it gets `429` and retries after two
  seconds, which shows up as wall-clock time, not as a failure.
- **The token scan finds the value as written.** It does not decode
  anything, so the token base64-encoded or split across lines would pass.
  It covers what is kept, not the rest of the scratch directory (the run's
  HOME, for one), which is never copied out.
- **Claude Code's direct calls fail.** Fast mode and the WebFetch domain
  check call `api.anthropic.com` directly, not through
  `ANTHROPIC_BASE_URL`; inside the sandbox they fail like any other host.
- **The in-sandbox layers of the network record are the builder's to
  edit.** The Node, namespace and browser layers write into the run
  directory, which the sandbox binds read-write. The model channel's lines
  come from the forwarder's own record, outside, and the metered cost is
  read from that record alone.
