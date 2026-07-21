# @pyric/studio

The data-management and debugging console for the pyric sandbox — the "Firebase
console for Pyric". Astro consumes Studio as a React application and serves it
from the public site or from `pyric dev --ui`.

Studio is **cross-service** (Firestore / Auth / Storage / RTDB over one event
stream) and **agentic-dev-focused**: an Action Center digest of what changed,
cross-service viewer/editor with clickable references, traffic monitoring,
rules-failure debugging (re-run as the attempting user / against an edited
ruleset). Assurance remains available during local
Studio development while it is being tested, but is disabled in published
builds. The standalone agent Playground is developed separately.

## Layout

| Path                | What                                                              |
| ------------------- | ---------------------------------------------------------------- |
| `src/ports.ts`      | Storage ports — `WorkspaceStore`, `ProjectStore`, `RemoteLifecycle` (exported as `@pyric/studio/ports`). |
| `src/env.ts`        | `StudioEnvironment` + `createStudioEnvironment(mode)` factory (`@pyric/studio/env`). |
| `src/studio-app.tsx` | Host-facing application component.                              |
| `src/App.tsx`       | App shell — nav, tabs, panes.                                    |
| `src/shell/routes.ts` | Finite service routes shared with the Astro host.              |
| `src/styles/tokens.css` | Tailwind v4 `@theme` token contract + `[data-theme]` hook.  |

## Storage modes

`createStudioEnvironment(mode)` is the single wiring seam:

- **`local`** — `pyric dev --ui`: disk via the pyric devr. Ships first.
- **`browser`** — browser-persisted state over the same ports. Future.
- **`hosted`** — a remote API behind the same ports. Future.

The ports are shaped so a future browser-persisted implementation can satisfy
the same interface without changing Studio surfaces.

Studio owns the browser application, routes, and styles. The Astro application
in `packages/site-docs` owns HTML pages, navigation, and static assets. Sandbox
document paths remain client-side URL state inside Studio rather than becoming
unbounded static pages.

## Scripts

```sh
bun run build      # compile the Studio module and copy its CSS assets
bun run test       # unit tests
bun run typecheck  # tsc --noEmit
```
