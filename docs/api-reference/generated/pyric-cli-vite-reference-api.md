---
title: "API reference: @pyric/cli/vite"
navLabel: "@pyric/cli/vite"
outcome: "Published declarations for @pyric/cli/vite."
slug: "pyric-cli-vite-reference-api"
kind: "api"
apiPackage: "@pyric/cli"
apiImportPath: "@pyric/cli/vite"
apiSubpath: "vite"
apiSymbolCount: 4
---

<!-- Generated from published package declarations via TypeDoc. Do not edit by hand; run bun run docs:api:generate. -->

## Interfaces

<a id="pyricsandboxoptions"></a>

### PyricSandboxOptions

#### Properties

| Property | Type | Description |
| :------ | :------ | :------ |
| <a id="bridge"></a> `bridge?` | \| `boolean` \| \{ `disableAuditLog?`: `boolean`; `project?`: `string`; \} | Mount the MCP **bridge** on Vite's dev origin so an external agent (Claude Code, Cursor) can drive this sandbox over MCP — `POST /__pyric/mcp` + `GET /__pyric/health` + `WS /__pyric/sandbox`, all on Vite's port. `true` is shorthand for `{}`. The agent and the page share ONE sandbox. ⚠ **Forces the in-page sandbox (single-tab).** The bridge peer is the in-page sandbox, never the SharedWorker, so enabling `bridge` disables the default multi-tab SharedWorker path — otherwise the agent would drive an empty in-page sandbox while the app's data lived in the worker. |
| <a id="capture"></a> `capture?` | `boolean` | Write the live session fixture to `.pyric/last-session.json` (for `pyric verify`). Default `true`; pass `false` to suppress. |
| <a id="fresh"></a> `fresh?` | `boolean` | With `persist`: discard any existing state file and re-seed from scratch. |
| <a id="persist"></a> `persist?` | `boolean` | Persist sandbox state to `.pyric/state/state.json` so data + test users survive reloads/restarts. Off by default (ephemeral). |
| <a id="root"></a> `root?` | `string` | Project dir for `firebase.json` / rules discovery. Default: Vite's `root`. |
| <a id="rules"></a> `rules?` | `string` | firestore.rules path (relative to `root`). Default: `firebase.json`'s `firestore.rules`, else `firestore.rules` in the project root. |
| <a id="seed"></a> `seed?` | `string` | Seed file: a `"collection/doc" → fields` JSON map, or a `pyric snapshot` state-file envelope. Applied at page init (state wins once it exists). |
| <a id="swapinbuild"></a> `swapInBuild?` | `boolean` | Force whether `vite build` runs the firebase→pyric swap, overriding the mode default. Unset (default): swap for any NON-production mode, keep real firebase for mode `production`. `true` = always produce a sandbox build; `false` = never swap in build (real firebase regardless of mode). `vite dev` is unaffected — the swap is always on there. |
| <a id="ui"></a> `ui?` | `boolean` | Serve the **Pyric Studio** app at `/__pyric/ui/` on Vite's dev origin (the `pyric dev --ui` equivalent). Mounts the disk-backed workspace/project routes Studio's `local` mode talks to AND serves the built Studio assets (vendored in this package at `dist/serve/studio-ui`). **On by default**; pass `ui: false` to disable. Not compatible with `bridge`: bridge forces the app in-page, but Studio's live plane reads the SharedWorker, so Studio would observe nothing. Under `bridge` ui therefore defaults OFF (an explicit `ui: true` still works but warns). Use `ui` without `bridge`, or `pyric dev --ui`. |

## Variables

<a id="node_builtin_re"></a>

### NODE\_BUILTIN\_RE

```ts
const NODE_BUILTIN_RE: RegExp;
```

The node builtins pyric's browser graph reaches for (via the rules module
 resolver). Bare and `node:`-prefixed both match.

***

<a id="node_builtin_shims"></a>

### NODE\_BUILTIN\_SHIMS

```ts
const NODE_BUILTIN_SHIMS: Record<string, string>;
```

Benign browser shim SOURCE per builtin (see header — droppable only when
 pyric breaks the `firestore/index → rules/tools → modules/resolver` static
 chain, #553). Exported so the Vite plugin (`./vite`) reuses the SAME shims
 through its own resolveId/load + optimizeDeps esbuild pass, instead of
 re-deriving them.

## Functions

<a id="pyricsandbox"></a>

### pyricSandbox()

```ts
function pyricSandbox(options?: PyricSandboxOptions): Plugin;
```

The dev-only Vite plugin. Add to `vite.config`:

  import { pyricSandbox } from '@pyric/cli/vite';
  export default defineConfig({ plugins: [pyricSandbox()] });

#### Parameters

| Parameter | Type |
| :------ | :------ |
| `options?` | [`PyricSandboxOptions`](#pyricsandboxoptions) |

#### Returns

`Plugin`
