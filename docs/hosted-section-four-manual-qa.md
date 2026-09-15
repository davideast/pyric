# Section 4 manual checkpoint: installed packages and admission

Run from this checkout with its dependencies installed. This procedure creates a
separate npm consumer and disposable data. Earlier demos on 43110, 48765 and 48768
remain available. Use Node 22.15.0 or newer.

## Build and install the candidate

```bash
repo_dir="$PWD"
bun run --cwd packages/pyric build
bun run --cwd packages/pyric-admin build
bun run --cwd packages/cli build
bash scripts/pack-packages.sh --skip-build
consumer_dir="$(mktemp -d "${TMPDIR:-/tmp}/pyric-section-four.XXXXXXXX")"
printf '{"private":true,"type":"module"}\n' > "$consumer_dir/package.json"
cd "$consumer_dir"
npm install --no-audit --no-fund \
  "$repo_dir/dist/packages/pyric-0.1.0-alpha.22.tgz" \
  "$repo_dir/dist/packages/pyric-admin-0.1.0-alpha.22.tgz" \
  "$repo_dir/dist/packages/pyric-cli-0.1.0-alpha.20.tgz" \
  "$repo_dir/dist/packages/create-pyric-0.1.0-alpha.22.tgz" \
  vite@5.4.21
mkdir manual-checkpoint
cp "$repo_dir"/packages/cli/test/manual/section-four/* manual-checkpoint/
cd manual-checkpoint
```

These filenames identify the September 15 candidate. For a later version, use the
filenames in `dist/packages/manifest.json`. Preserve `package-lock.json` and the
tarballs to reproduce exactly the same dependencies. Vite is pinned to the tested
5.4.21; this checkpoint does not establish other Vite versions.

On the tested Mac, normal npm installation completed successfully while optional
`node-liblzma` failed to compile because `pkg-config` was unavailable. npm omitted
that optional dependency. The sandbox checks below passed with that installation.
This is not a warning-free native-dependency installation claim.

## Hosted CLI, reload and warm startup

```bash
node ../node_modules/@pyric/cli/dist/cli/index.js sandbox \
  --hosted --bridge --no-open --no-capture --port 48769
```

1. Open <http://localhost:48769/>. Expect runtime `hosted`, a nonempty anonymous
   user, connection `Connected`, module `version-one`, status `Ready` and listener updates `1`.
2. Click **Write document**. Expect `Written`, updates `2`, and a JSON document
   whose `uid` equals the displayed user. Each further click adds exactly one
   listener update and a distinct message.
3. Reload. Expect runtime `hosted`, one initial listener delivery and `Ready`.
   Click again; expect `Written` and updates `2`.
4. Close the checkpoint tab. Stop the server with Ctrl+C and repeat the same
   command without deleting `.pyric`. Reopen the URL and repeat steps 1–2. This
   exercises warm startup, including the existing build cache.

During an observed disconnection, **Connection** becomes `Reconnecting` and
**Write document** is disabled. After recovery it becomes `Connected` and the
button is enabled. The last write result remains separate: an uncertain-outcome
error stays visible until your next explicit write. Recovery never retries it.
Detection is asynchronous; a click made before the SDK detects a broken socket
can still report an error.

The running checkpoint is also available privately over Tailscale at
<https://davids-macbook-pro-2.tail8926aa.ts.net:48769/>. Its server additionally uses
`--allowed-host davids-macbook-pro-2.tail8926aa.ts.net,100.67.73.11`, and Tailscale
Serve forwards HTTPS port 48769 to `http://127.0.0.1:48769`. Refresh the page to
load fixture changes. The DNS name supplies the valid HTTPS certificate.

For the already prepared September 15 consumer, skip building/installing and use:

```bash
cd /Users/davideast/.codex/worktrees/5df7/pyric
consumer_dir="$(cat ignored/section4/consumer-dir.txt)"
cd "$consumer_dir/manual-checkpoint"
```

The hosted checkpoint is already running on 48769 after this verification turn;
do not start a second server on the same port.

## SharedWorker and genuine in-page fallback

Close the checkpoint tab and stop only its server. Run the same CLI command
without `--hosted`:

```bash
node ../node_modules/@pyric/cli/dist/cli/index.js sandbox \
  --bridge --no-open --no-capture --port 48769
```

Repeat the hosted checklist at <http://localhost:48769/>, expecting runtime
`shared-worker`. Then close that tab and repeat at
<http://localhost:48769/?runtime=inpage>, expecting `in-page`. The query parameter
belongs to this fixture and selects the existing fallback before SDK startup.
The runtime label is essential: an unverified selector is not parity evidence.

## Installed Vite plugin and HMR

Close the checkpoint tab and stop its CLI server. In the same directory:

```bash
PORT=48769 node vite-server.mjs
```

1. Open <http://localhost:48769/> and expect `shared-worker`. Click **Write
   document** and check exactly one additional delivery. Record the displayed UID.
2. In a second terminal, change only the module marker:

   ```bash
   cd /Users/davideast/.codex/worktrees/5df7/pyric
   consumer_dir="$(cat ignored/section4/consumer-dir.txt)"
   cd "$consumer_dir/manual-checkpoint"
   node --input-type=module <<'JS'
   import { readFileSync, writeFileSync } from 'node:fs';
   writeFileSync('main.js', readFileSync('main.js', 'utf8').replace('version-one', 'version-two'));
   JS
   ```

   For a newly installed consumer, use its directory instead of the saved path.
3. Without reloading, expect `version-two`, the same UID, runtime `shared-worker`
   and a reset listener counter of `1`. Click; expect `Written` and updates `2`.
   The fixture disposes its previous subscription and click handler during HMR.
4. Reload and repeat the write. Close the tab, stop and restart Vite without
   clearing `.vite` or `.pyric`, reopen and repeat. Expect one delivery per write.
5. Restore the marker from the second terminal:

   ```bash
   cp /Users/davideast/.codex/worktrees/5df7/pyric/packages/cli/test/manual/section-four/main.js main.js
   ```

   Close the tab and repeat steps 1–4 at
   <http://localhost:48769/?runtime=inpage>, expecting `in-page`.

Vite currently supports SharedWorker and in-page sandbox execution. Hosted mode is
selected through `pyric sandbox --hosted`; no Vite hosted option is introduced.

## Repeatable admission and complete packed checks

Foreign grants and discovery files require deliberate fault injection. Run the
public socket, served SDK and installed CLI checks from the repository:

```bash
cd "$repo_dir"
PYRIC_PACKED_CONSUMER="$consumer_dir" node node_modules/@playwright/test/cli.js test \
  --config packages/cli/test/e2e/hosted/playwright.section-four.config.ts
```

For the existing consumer, set the variables first:

```bash
repo_dir=/Users/davideast/.codex/worktrees/5df7/pyric
consumer_dir="$(cat "$repo_dir/ignored/section4/consumer-dir.txt")"
```

Expect 11 passing cases, no retries or skips. The suite creates and cleans up its
own projects and ephemeral ports. It includes all five runtime flows above plus:

- Untrusted browser/socket origins and opaque `null` origins are refused by the
  installed hosted and Vite servers. A legitimate app keeps reading and writing.
  WebSocket rejection closes the socket (1006); HTTP MCP rejection returns 403.
- A foreign host's grant cannot resume against the destination host identity
  (1008). Its issuing host can still resume it.
- Changed host identity intentionally obtains a new grant and session for restart
  recovery. It never resumes the foreign session.
- Installed CLI MCP refuses a copied discovery record from another project; the
  owner still writes through MCP and its browser observes the result.
- A served SDK directed to another project's bridge refuses before enabling writes
  or receiving that project's data; the destination's legitimate app still works.

Admission uses a hostname allowlist, not strict scheme/port origin equality.
Loopback hosts and explicitly allowed hosts are trusted; non-browser clients may
omit Origin. These checks establish that existing local-development policy, not
an authentication boundary against admitted local developers.
