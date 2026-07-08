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
- `playwright.config.ts` — `testMatch: **/*.pw.ts`; auto-starts `pyric dev` for localhost.

## Run (localhost — passes)
```sh
bun run build:pyric-tools          # the webServer runs the built CLI
bunx playwright install chromium   # once
bunx playwright test --config packages/pyric-tools/test/e2e/playwright.config.ts
```

## Run (Tailscale repro — fails on a build without the fix)
Start a serve reachable on your tailnet, then point the test at it:
```sh
node packages/pyric-tools/dist/cli/index.js dev --port 5190 --host 0.0.0.0 \
  --no-open --allowed-host <your-tailnet-host> &
E2E_BASE=http://<your-tailnet-host>:5190 \
  bunx playwright test --config packages/pyric-tools/test/e2e/playwright.config.ts
```
Without the fix, `onAuthStateChanged` never fires (status stuck on `loading`).
With the fix it fires `[null, "google.com:..."]`.
