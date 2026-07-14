# Served-mode auth e2e (Tailscale repro)

A Playwright demo that drives a real Chromium (SharedWorker-capable) against
`pyric dev` to exercise the served-mode Google popup sign-in. It found the
secure-context worker bug (#724): `onAuthStateChanged` never fired over a
Tailscale / non-localhost http origin because the worker threw on
`crypto.randomUUID()` (a secure-context-only API) during init.

These tests are **not** part of `bun test` / CI: they need a browser + a running
serve, and the localhost run passes (the bug only shows off-box). They are named
`*.pw.ts` so `bun test` (which matches `*.test.ts` / `*.spec.ts`) ignores them.
The CI guard for the fix is the unit test `test/serve/worker/random-uuid.test.ts`.

## Layout
- `fixture/` — a minimal firebase/* app (`signInWithPopup` + `onAuthStateChanged`).
- `auth-popup.pw.ts` — the test.
- `ai-demo.pw.ts` — the AI graduation demo smoke test. Self-booting: spawns its
  own `pyric dev` on `examples/ai-chat` and drives both answer engines
  (scripted with a zero-Google-requests assertion; local model through
  `/__pyric/ai-proxy`, skipped when Ollama isn't reachable on localhost:11434).
- `playwright.config.ts` — `testMatch: **/*.pw.ts`; auto-starts `pyric dev` for localhost.
- `soak/` — the bridge lifecycle soak suite (its own config; files are
  `*.soak.ts`, so neither `bun test` nor this config picks them up). Each
  scenario spawns a real `pyric dev --ui --bridge --no-open --port 0 --json`
  serve and drives real tabs (app + Studio), a real Node remote client
  (`@pyric/cli/remote`), and the MCP streamable-HTTP endpoint — the
  connection-lifecycle layer (peer slot, standby, sub re-issue dedup) that
  headless tests can't see. On its first run it found the admin-lens
  listener denial (pinned as an expected-fail test) and the stale
  serve-bundle-cache masking of `@pyric/cli` client fixes (the suite runs
  `--no-cache`). Run from the repo root with `bun run test:soak` (same
  prerequisites as below; ~1.5 minutes, the headline scenario soaks ~60s).

## Run (localhost — passes)
```sh
bun run build:cli          # the webServer runs the built CLI
bunx playwright install chromium   # once
cd packages/cli
bunx playwright test --config test/e2e/playwright.config.ts
```

Run from `packages/cli` (like `test:soak`): from the repo root the
runner and the test files resolve two different `@playwright/test` instances
and collection fails with "did not expect test() to be called here".

## Run (Tailscale repro — fails on a build without the fix)
Start a serve reachable on your tailnet, then point the test at it:
```sh
node packages/cli/dist/cli/index.js dev --port 5190 --host 0.0.0.0 \
  --no-open --allowed-host <your-tailnet-host> &
E2E_BASE=http://<your-tailnet-host>:5190 \
  bunx playwright test --config packages/cli/test/e2e/playwright.config.ts
```
Without the fix, `onAuthStateChanged` never fires (status stuck on `loading`).
With the fix it fires `[null, "google.com:..."]`.
