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
```

`canary` is the harness's integration test. Run it before every round.

- `--build` builds the workspace before packing it. Without it, the current
  build is packed, as `bun test/apps/run.ts` does.
- `--packages <dir>` installs tarballs already in `<dir>`.

The `round`, `run`, `reproduce` and `measure` commands come in later pull
requests.

## The canary

A scripted builder with no model. In order, it:

1. Runs the unit tests (`bun test ./test/builders`).
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
   listener saw only the unhooked plants. It exits 1 if any check fails.

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
  short list of `/etc` entries (the loader cache, certificates, fonts,
  `passwd`, `group`, `nsswitch.conf` and similar: `ETC_ENTRIES`), the repo,
  the `node` and `bun` installs, and Playwright's browsers;
- read-write: the run directory only;
- the npm cache read-only, with an overlay mounted on it from inside whose
  upper layer is in the sandbox's `/tmp`. npm writes local tarballs into its
  cache even offline; the overlay keeps those writes in the sandbox, and the
  shared cache never changes;
- fresh: `/dev`, `/proc` (its own pid namespace), `/tmp` and `/run`, both
  tmpfs, and the run's own `/etc/resolv.conf` (naming 127.0.0.1) and
  `/etc/hosts` (loopback names only).

There is no `/mnt`, no `/run/WSL`, no `/run/user` and no home directory
beyond the bound paths. The network namespace has only `lo`.

**The holder.** bwrap's command adds two routes that send every IPv4 and IPv6
address to loopback, then runs `recorder/holder.mjs`, which holds the sandbox
open. It starts the resolver, `recorder/dns-log.mjs` on 127.0.0.1:53, which
records every DNS query in `network.jsonl` and answers NXDOMAIN, so a lookup
from Bun, curl or any other runtime is recorded. It also starts the catch-all
listener, `recorder/catch-all-log.mjs` on ports 80 and 443, which records
each TCP connection with the address the client dialed and resets it before
reading a byte. A connection by address needs no lookup, so the catch-all
listener is what records it.

**Privileges.** Processes run as root of the sandbox's own user namespace,
as they did under `unshare -r`. bwrap maps that root to the harness's own
uid, and it gives the holder only `CAP_NET_ADMIN` and
`CAP_NET_BIND_SERVICE`. Containment comes from the file system layout and
the network namespace, not from dropping privileges: nothing of the host
outside the layout is mounted, and the only interface is loopback.

**Entering.** A command enters through the child pid bwrap reports on
`--info-fd`, with an explicit list of namespaces (user, mount, network, pid,
IPC, UTS, cgroup). `nsenter -a` would also name the time namespace, which the
sandbox shares with the host, and nsenter can't enter that. The command's
directory is set inside the sandbox with `env -C <dir>`, not with nsenter's
`--wd=<dir>`: that opens the directory on the host before entering, which
leaves the command's working directory on a host mount outside the
sandbox's root.

**The check.** Before any other work the harness checks from inside that
loopback is the only interface, then runs `sandbox-inventory.ts`, which
confirms that:

- `os.networkInterfaces()` lists only `lo`;
- `/etc/resolv.conf` names only 127.0.0.1;
- `/mnt`, `/run/WSL` and `/run/user` don't exist;
- no socket file exists anywhere under `/` outside the run's own
  directories (the run directory, the sandbox's `/tmp` and `TMPDIR`). The
  walk skips `/proc` and `/sys` and follows no symlinks.

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
  but the kernel does not block that install. A builder that installs new
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
  line. That is acceptable for the canary, since a missing browser event
  fails it. For PR 2: when `browser-server.ts` kills the browser after its
  stop times out, it must write an `incomplete` marker into `network.jsonl`,
  so a builder run's missing browser events read as unknown, not as absent.
  Today it only prints a console line.
