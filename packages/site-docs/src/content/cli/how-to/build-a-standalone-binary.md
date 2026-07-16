---
title: "Build a standalone pyric binary"
navLabel: "Build a standalone binary"
group: "@pyric/cli"
section: "How-to"
order: 30
---
# Build a standalone `pyric` binary

Ship `pyric` as a single self-contained executable: no Node, no npm, no
`node_modules`. Built with [`bun build --compile`](https://bun.sh/docs/bundler/executables).

## Build

From the repo root:
```bash
bun run compile:standalone        # clean build + all four cross-targets
```
or, iterating inside the package (assumes `bun run build` already ran):
```bash
bun run --cwd packages/cli compile        # all four targets
bun run --cwd packages/cli compile host   # just this machine (fast)
```
Binaries land in `packages/cli/dist-bin/`:

| File | Platform |
|---|---|
| `pyric-linux-x64` | Linux x64 |
| `pyric-linux-arm64` | Linux arm64 |
| `pyric-darwin-x64` | macOS Intel |
| `pyric-darwin-arm64` | macOS Apple Silicon |
| `pyric` | copy of this host's binary, for local runs |

`dist-bin/` is git-ignored and **outside the npm `files` allowlist**. The
~100 MB binaries are release artifacts, never published to npm or committed.

Verify a build:
```bash
bun run --cwd packages/cli smoke:standalone
```
## How `dev` works in the binary

Every command runs from the binary, including `dev` (the headline one).

Normally `pyric dev` bundles its `firebase/*` → sandbox SDK shims with esbuild
**at runtime**, reading the installed `pyric` dist. Neither esbuild's native
helper nor that on-disk dist exist inside a compiled binary's virtual
filesystem. But those bundles are **deterministic**: a pure function of
`@pyric/cli`'s wrapper entries and the `pyric` version baked into the CLI, not
your project (pyric dev ships its *own* sandbox; your app imports `firebase/*`, nothing more).

So the compile step runs the bundler **once on the build host** and embeds the
result (the SDK + worker bundles and the Studio UI) into the binary. At
runtime `dev` materializes those bytes to a temp dir and serves them
unchanged. `dev`, `dev --ui`, and `dev --bridge` all work fully offline.
`--no-cache` is a no-op in the binary (there is nothing to rebuild).

## How `init` scaffolds an installable project (vendoring)

`pyric` and `@pyric/cli` are embedded in the standalone binary. It makes them
available to a scaffold by **vendoring**: the
compile step also `npm pack`s both packages and embeds the tarballs, and
`pyric init` (in the standalone binary) writes them into `vendor/` and points the
project's deps at them:
```jsonc
"devDependencies": { "@pyric/cli": "file:vendor/pyric-cli.tgz", "pyric": "file:vendor/pyric.tgz", … },
"overrides": { "pyric": "file:vendor/pyric.tgz" }
```
`bun install` then resolves `pyric`/`@pyric/cli` from `vendor/` and everything
else (`firebase`, `vite`, `@inbrowser/agent`, `esbuild`) from npm. The
`overrides` pin is load-bearing: a **placeholder `pyric` is published to npm at a
higher version than the local `0.0.0`**, so `@pyric/cli`'s transitive `pyric@*`
would otherwise pull that empty stub instead of the vendored package.
(`@pyric/cli`'s own `pyric` dependency is rewritten to `*` at pack time so it dedupes to
the override.) `vendor/` is committable (the scaffold ignores only `.pyric/`), so
a clone installs offline too.

### `--deps npm`: opt out of vendoring

Once the packages are published (or against a private registry), scaffold with
registry deps instead:
```bash
pyric init --template web --deps npm                 # ^<binary version>
pyric init --template web --deps npm --pyric-version 0.1.0
```
Default is `vendor` in the standalone binary, `npm` otherwise (e.g. `npx pyric`
from the monorepo). `PYRIC_INIT_DEPS=npm` sets the default; `--deps` overrides it.

Smoke the whole chain (`init → bun install → vite build`, offline for
`pyric`/`@pyric/cli`) against a compiled binary:
```bash
bun run --cwd packages/cli smoke:vendor
```
## Contract

- **ESM-only**, like the npm package. The binary embeds its own runtime.
- The embedded SDK bundle is pinned to the `pyric` version compiled in. To ship
  a new `pyric`, rebuild the binary.
- Sourcemaps are not embedded (they 4× the size and only serve devtools); the
  npm `dev` path still emits them.
