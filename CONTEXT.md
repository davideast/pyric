# Pyric codebase context

Last checked: 2026-07-13.

Pyric is a Firebase-shaped development sandbox for people and coding agents.
It runs Firestore, Auth, Realtime Database, Storage, Security Rules, and related
tooling locally, in TypeScript, without a Firebase project or Emulator Suite.

The product boundary is deliberate:

- Pyric owns sandbox development, artifact generation, and verification.
- Firebase owns production execution.
- `firebase-tools` and the Firebase Console own production deployment.

`PRIORITIES.md` is law for proposed work. Current work must reduce first-run
friction, simplify the product model, or make the contract and gaps easier to
trust.

## Workspace map

The repository is a Bun workspace with these principal packages:

| Directory | Package | Role |
|---|---|---|
| `packages/pyric` | `pyric` | Firebase Web SDK mirrors, sandbox runtime, rules tooling |
| `packages/pyric-admin` | `pyric-admin` | Firebase Admin-shaped sandbox mirrors |
| `packages/cli` | `@pyric/cli` | `pyric` binary, Vite/Node resolution seams, bridge, verify, assurance |
| `packages/create-pyric` | `create-pyric` | `npm create pyric` scaffolder |
| `packages/ui` | `@pyric/ui` | Headless React components and hooks |
| `packages/studio` | `@pyric/studio` | Local console served by `pyric dev --ui` |
| `packages/site-docs` | `@pyric/site-docs` | Generated Astro documentation site |
| `packages/conformance` | `@pyric/conformance` | Private evidence registry, observations, probes, and gates |
| `packages/playground` | `@pyric/playground` | Private browser agent playground |

Examples live in `examples/`. The Claude Code plugin lives in
`pyric-plugin/`. Repository-local agent skills live in `.agents/skills/`.

All public packages are ESM-only and require Node 22 or later. Prefer public
package subpaths; do not import through another package's source tree.

## Package contracts

### `pyric`

`pyric` mirrors Firebase Web SDK shapes against a sandbox. Important public
subpaths include:

- `pyric/app`
- `pyric/auth`
- `pyric/firestore`
- `pyric/database`
- `pyric/storage`
- `pyric/rules`
- `pyric/firestore-values`
- `pyric/sandbox`
- service-specific sandbox controls under `pyric/sandbox/*`

The exact contract is `packages/pyric/package.json#exports`. Some exported
internal seams exist for adapters; application code should use the ordinary
service and sandbox fronts.

### `pyric-admin`

`pyric-admin/{app,auth,firestore,database,storage}` provides Admin-shaped
handles for the sandbox. Production server code should import
`firebase-admin/*` directly. During activated development, the CLI resolver can
map those canonical imports to the sandbox mirrors without changing source.

### `@pyric/cli`

`@pyric/cli` has no package-root import. Its public subpaths are exactly:

- `@pyric/cli/credentials/node`
- `@pyric/cli/verify`
- `@pyric/cli/assurance`
- `@pyric/cli/assurance/browser`
- `@pyric/cli/bridge`
- `@pyric/cli/bridge/client`
- `@pyric/cli/discover`
- `@pyric/cli/vite`
- `@pyric/cli/serve/worker`
- `@pyric/cli/remote`
- `@pyric/cli/register`

The package intentionally has no Firebase or Firebase Admin runtime dependency.
The manifest, packaging gates, and generated declaration reference enforce this
surface.

## Package resolution

Application source keeps canonical `firebase/*` and `firebase-admin/*` imports.
The execution environment chooses the implementation.

Browser development:

- `@pyric/cli/vite` maps supported `firebase/*` imports to `pyric/*` while
  Vite is serving development code.
- `pyric dev` serves import maps that point a pre-built/static application at
  the same sandbox mirrors.
- A normal production Vite build leaves the development swap inactive and
  includes Firebase directly.

Node development:

- `pyric dev` runs the child command with `PYRIC_SANDBOX` set and
  `@pyric/cli/register` preloaded through `NODE_OPTIONS`.
- The active resolver maps `firebase/*` to `pyric/*` and `firebase-admin/*` to
  `pyric-admin/*`.
- Without `PYRIC_SANDBOX`, the register module is inert. Normal resolution
  loads Firebase directly.
- Activation is refused under `NODE_ENV=production` unless
  `PYRIC_SANDBOX_FORCE=1` is explicitly set for controlled development or CI.

File presence does not activate package substitution. The invocation does.

## CLI contract

The binary is `pyric`. General commands are:

```text
pyric bridge
pyric dev
pyric init
pyric vendor
pyric snapshot
pyric verify
pyric verify cases
pyric mcp
```

Artifact commands use one service-first grammar:

```text
pyric <service> <artifact> <operation>
```

The complete family is:

```text
pyric firestore rules lint <path>
pyric firestore rules validate <path>
pyric firestore rules simulate [--stdin]
pyric firestore rules resolve <path> [--out <path>]
pyric firestore indexes generate <path...> [--out <path>]
pyric storage rules lint <path>
pyric storage rules simulate [--stdin]
pyric database rules lint <path>
pyric database rules validate <path>
pyric database rules simulate [--stdin]
pyric database rules generate [--config <path>] [--out <path>]
```

`packages/cli/src/cli/index.ts` owns top-level dispatch and help.
`packages/cli/src/cli/service-commands.ts` owns the service-first hierarchy.
`packages/cli/docs/reference/cli.md` is the authored reference.

`pyric verify` replays captured sandbox sessions against candidate Firestore or
RTDB rules. The default engine is local. The Firestore Rules Test API engine
evaluates derived cases on Google's engine; it verifies rules and does not
deploy them.

## Sandbox and bridge

The browser sandbox normally lives in a SharedWorker, giving tabs on one origin
a shared backend. IndexedDB provides browser-local durability. `--persist`
adds the committable `.pyric/state/state.json`; `pyric snapshot` promotes lived
state to a fixture; the session capture at `.pyric/last-session.json` feeds
`pyric verify`.

`pyric dev --bridge` mounts MCP on the development server and routes calls to
the same sandbox as the open application and Studio. `pyric bridge` provides a
standalone sandbox bridge. `pyric mcp` is the stdio editor front: it attaches to
a running development bridge when possible or hosts a headless sandbox.

The default bridge contract is exactly 35 tool names in
`packages/cli/src/bridge/server/mcp-contract.ts`. `scripts/tool-parity.mjs`
checks that exposed tool registries stay explicit.

## Conformance

Conformance is evidence, not a parity badge. The system separates:

- total surface coverage;
- intended surface coverage; and
- fidelity across tracked behaviour rows.

Authoritative inputs live under `packages/conformance/`:

- `surfaces/` defines measured surfaces;
- `registry/` owns every published conformance row;
- `observations/` stores frozen Firebase behaviour;
- `probes/` replays observations against Pyric;
- `rules-language/` tracks rules constructs;
- `assurance-capabilities/` derives what the evidence can support;
- `baselines/` ratchets regressions without turning an absolute percentage
  into an incentive to relabel gaps.

Generated outputs include service `COMPAT.md` files and
`packages/pyric/docs/conformance/SCORES.md`. Never hand-edit generated
conformance files. Run `bun run compat:generate` and then `bun run
compat:check`.

Any PR that changes a published number, status, denominator, snapshot, or
assurance capability needs an adversarial coverage review.

## Documentation

The documentation system has two authored inputs:

- outcome-first guides in `docs/site-rewrite/content/`;
- package documentation under each `packages/*/docs/` tree.

`packages/site-docs/scripts/port-content.ts` owns the generated collection at
`packages/site-docs/src/content/docs/` apart from its explicit keep-list. Never
edit generated projections by hand; edit the source and run:

```bash
bun run --cwd packages/site-docs port
```

The CLI and library declaration receipts are generated by TypeDoc from the
`types` targets in package export maps:

```bash
bun run build
bun run docs:api:generate
bun run docs:api:check
```

The committed `*.api.generated.md` files are mechanical reference receipts.
Hand-written API and CLI pages carry task context and behavioural guidance.

Run the complete documentation gate with:

```bash
bun run --cwd packages/site-docs test
```

That ports sources, builds the site and Markdown twins, verifies the output and
links, and audits documentation rhythm.

## Build and tests

Install with the pinned Bun version from CI, then use the root scripts:

```bash
bun install
bun run build
bun test
bun run compat:check
bun run tool:parity:check
npm run test:packaging
```

`scripts/build.sh` cleans package output, emits declaration stubs for the
workspace, performs strict builds in dependency order, builds Studio and the
documentation site, and embeds those assets into `@pyric/cli`.

The main PR workflow builds every package, checks declaration-document drift,
runs the documentation site gate, validates conformance and assurance
artifacts, checks tool exposure, and runs tests. Packaging and install-matrix
jobs run on PRs carrying the `ci-packaging` label.

## Working conventions

- Read `PRIORITIES.md` before proposing work.
- Read `docs/code-conventions.md` before changing module boundaries.
- Preserve unrelated work in a dirty tree.
- Use public subpaths between packages.
- Keep browser/Node/platform-specific imports at explicit boundary modules.
- Generated sources name their owner command; regenerate rather than editing.
- Use British English in authored documentation.
- Treat unsupported behaviour as an explicit error or documented gap, never a
  silent approximation.
