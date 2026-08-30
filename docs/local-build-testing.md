# Testing a local build in a real app

How to run an application against the packages in this checkout instead of the
published npm releases — before publishing, or while reproducing a bug that
only shows up in a consuming app.

There are two paths. They answer different questions:

- **Vendored tarballs** answer "will the *published* packages work?" — the app
  installs real tarballs through npm/bun, exactly as a user would. Use this
  before a release and when chasing packaging-class bugs (exports, `files`,
  bins, workspace-dep rewriting).
- **Workspace resolution** answers "does my *source change* work?" — the app
  lives inside this repo's Bun workspace and resolves `pyric` / `@pyric/cli`
  straight from `dist/`. Use this for fast iteration.

Both need a build first.

## Build the packages

```bash
bun install
bash scripts/build.sh --packages-only
```

`--packages-only` skips the docs site. Every package's `dist/` is now fresh;
tests and both paths below resolve through `dist/`, so rebuild after source
changes (`bun run build` inside a single package is enough when you know what
you touched).

## Path 1: vendored tarballs (the published-package rehearsal)

`pyric vendor` needs the standalone binary — it carries the packed tarballs
inside itself, with `workspace:*` deps already rewritten to concrete versions
(a hand-run `npm pack` does **not** rewrite them; consumers of such a tarball
hit `EUNSUPPORTEDPROTOCOL`, which is why the vendor flow exists).

```bash
# 1. Compile the standalone binary (embeds freshly packed tarballs).
#    Output lands in packages/cli/dist-bin/ as pyric-<os>-<arch>.
#    Pass a single target to skip the other three cross-compiles:
cd packages/cli && bun scripts/compile.ts linux-x64   # or darwin-arm64, ...

# 2. In your test app (anywhere on disk):
/path/to/pyric/packages/cli/dist-bin/pyric-linux-x64 vendor
bun install   # or npm install

# 3. Run the app through the same binary:
/path/to/pyric/packages/cli/dist-bin/pyric-linux-x64 dev
```

`vendor` lays the tarballs into `vendor/` and merges `file:` specifiers into
the app's `package.json` — `pyric`, `pyric-admin`, and `@pyric/cli` then
resolve from those tarballs like any npm dependency. The Vite plugin needs no
special configuration on this path: `@pyric/cli/vite` is a real
`node_modules` package.

```ts
// vite.config.ts — identical to the published-package experience
import { defineConfig } from 'vite';
import { pyric } from '@pyric/cli/vite';

export default defineConfig({ plugins: [pyric()] });
```

Re-vendoring after a change means recompiling (step 1) and re-running
`vendor` — the tarballs are baked into the binary. That cost is the point:
this path measures the shipped artifact, not the working tree.

## Path 2: workspace resolution (the iteration loop)

Put the test app inside the repo's Bun workspace and use `workspace:*` deps —
this is exactly how `examples/vite-sandbox-app` is wired, and copying it is
the fastest start:

```bash
cp -r examples/vite-sandbox-app examples/my-repro
cd examples/my-repro && bun install
```

```jsonc
// package.json — the resolution contract
{
  "dependencies": {
    "firebase": "^12.13.0",     // the app keeps CANONICAL imports
    "pyric": "workspace:*"      // the sandbox mirror resolves locally
  },
  "devDependencies": {
    "@pyric/cli": "workspace:*",
    "vite": "^6.0.0"
  }
}
```

Application source keeps `firebase/*` imports throughout — package resolution
owns backend selection (ADR-001). Two ways to activate the swap:

- **Vite plugin**: the same `vite.config.ts` as above, then `bun run dev`
  (i.e. `vite`). `pyric()` maps supported `firebase/*` imports to the
  workspace `pyric/*` mirrors while the dev server runs; a production
  `vite build` ships real Firebase.
- **`pyric sandbox`** (serves static/pre-built apps via import maps, runs Node
  children with the register preloaded, hosts Studio/bridge):

  ```bash
  # From the app dir, run the CLI straight out of the checkout:
  bun /path/to/pyric/packages/cli/dist/cli/index.js dev
  ```

The iteration loop: edit source in `packages/*` → `bun run build` in the
touched package(s) -> restart `vite dev` / `pyric sandbox`. Both resolve the
mirrors and the plugin at server start from `dist/`, so a restart (not just a
browser reload) picks up the rebuild.

## Verify you are actually on the local build

The version string cannot tell you. Local tarballs carry whatever `version`
the checkout's manifests hold — identical to the last npm release until a
release bumps it — so `pyric --version` and `package.json` look unchanged even
when the vendoring worked. Worse, a setup that quietly fell back to published
npm dependencies (no `vendor/` laid, or an install that resolved the registry)
looks exactly the same at a glance. Verify by content and provenance:

```bash
# 1. Are file: tarballs actually installed (not registry packages)?
grep '"pyric"' package.json          # must be a file:vendor/... specifier
ls -la vendor/*.tgz                  # exist, with a build-time mtime you expect

# 2. Does the installed pyric contain the change under test?
#    (pick any symbol your branch adds — example: the resetAll seam)
#    NAME THE EXACT TARBALL: vendor/ holds pyric.tgz, pyric-admin.tgz,
#    create-pyric.tgz AND pyric-cli.tgz, and a wildcard matching several
#    makes tar treat the later files as member names ("Not found in
#    archive" — a false negative, not a missing fix).
tar -xzOf vendor/pyric.tgz package/dist/sandbox/internal/sandbox-impl.js | grep -c resetAll

# 3. Definitive: the local tarball's checksum differs from npm's
#    (compare pyric.tgz against the pyric package — not the cli tarball)
shasum vendor/pyric.tgz
npm view pyric dist.shasum
```

Two rules that prevent the silent-fallback failure mode:

- **Compile from the branch under test.** The tarballs are baked into the
  standalone binary at compile time — a binary compiled from `main` cannot
  contain an unmerged fix branch's changes, no matter how it is vendored.
  Check out the branch, rebuild, recompile, re-vendor, reinstall.
- **Re-vendor after every recompile.** `vendor` copies the embedded tarballs;
  the app does not track the binary. Recompile without re-vendoring and the
  app keeps the previous build.

## Verifying the packaging story without an app

Three gates prove the publishable artifacts without hand-testing:

```bash
bun run test:packaging       # pack → install into a fresh consumer →
                             # import every advertised subpath (leaves its
                             # work dir behind on failure, for debugging)
cd packages/cli
bun run smoke:standalone     # the compiled binary boots and serves
bun run smoke:vendor         # `vendor` lays working tarballs into a fresh app
```

`test:packaging` is the one that would have caught a broken subpath or a
`workspace:*` leak before it reached npm — run it before any release, and
run it first when a consumer-only bug report comes in.

## Which path for which bug

| Symptom | Path |
|---|---|
| Works in-repo, breaks for npm users | Vendored tarballs (then `test:packaging`) |
| Reproducing a runtime/sandbox bug from an app | Workspace resolution |
| Vite-specific resolution/swap issues | Workspace resolution first; confirm on tarballs before closing |
| Bin/CLI behavior (`pyric sandbox`, `init`, Studio serving) | Either, but confirm fixes on the standalone binary, which is what `vendor`-based users run |
