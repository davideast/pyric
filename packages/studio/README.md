# @pyric/studio

The data-management and debugging console for the pyric sandbox — the "Firebase
console for Pyric". Served by `pyric dev --ui`.

Studio is **cross-service** (Firestore / Auth / Storage / RTDB over one event
stream) and **agentic-dev-focused**: an Action Center digest of what changed,
cross-service viewer/editor with clickable references, traffic monitoring,
rules-failure debugging (re-run as the attempting user / against an edited
ruleset), a permission dial, and the Pyric Agent plan→dry-run→accept flow. The
playground's app-building experience folds in as the **App Builder** tab on the
same project.

## Layout

| Path                | What                                                              |
| ------------------- | ---------------------------------------------------------------- |
| `src/ports.ts`      | Storage ports — `WorkspaceStore`, `ProjectStore`, `RemoteLifecycle` (exported as `@pyric/studio/ports`). |
| `src/env.ts`        | `StudioEnvironment` + `createStudioEnvironment(mode)` factory (`@pyric/studio/env`). |
| `src/App.tsx`       | App shell — nav, tabs, panes.                                    |
| `src/styles/tokens.css` | Tailwind v4 `@theme` token contract + `[data-theme]` hook.  |

## Storage modes

`createStudioEnvironment(mode)` is the single wiring seam:

- **`local`** — `pyric dev --ui`: disk via the pyric devr. Ships first.
- **`browser`** — browser-persisted state over the same ports. Future.
- **`hosted`** — a remote API behind the same ports. Future.

The ports are shaped from the union of disk + playground so the playground is a
valid future `browser` implementation, not a rewrite.

## Scripts

```sh
bun run dev        # vite dev server
bun run build      # tsc (emits ./ports + ./env) then vite build (app → dist/app)
bun run test       # unit tests
bun run typecheck  # tsc --noEmit
```
