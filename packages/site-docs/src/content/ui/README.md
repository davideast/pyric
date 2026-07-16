---
title: "@pyric/ui"
navLabel: "Overview"
group: "@pyric/ui"
section: ""
order: 10
---
# `@pyric/ui` docs

Per-component reference. Each page is one-screen — import, minimal example, props table, common gotchas.

## Primitives

`@pyric/ui/primitives`

- [CopyButton](./primitives/CopyButton.md) — clipboard button exposing `data-copied`.
- [Badge](./primitives/Badge.md) — headless pill exposing `data-pyric-badge-kind`.
- [JsonView](./primitives/JsonView.md) — collapsible JSON tree.
- [SegmentedControl](./primitives/SegmentedControl.md) — single-select chip group (ARIA radiogroup).
- [ConfirmDialog](./primitives/ConfirmDialog.md) — headless dialog + imperative `useConfirm` provider.
- [Toast](./primitives/Toast.md) — toast queue + `useToast` hook.
- [VirtualList](./primitives/VirtualList.md) — TanStack-Virtual wrapper for long lists.

## Firestore

`@pyric/ui/firestore`

- [DocumentPreview](./firestore/DocumentPreview.md) — read-only field renderer.
- [DocumentEditor](./firestore/DocumentEditor.md) — reducer-backed editor + compound component.
- [CollectionList](./firestore/CollectionList.md) — headless list renderer for collections.
- [DocumentList](./firestore/DocumentList.md) — paginated + optionally virtualized doc list.
- [ReferencePicker](./firestore/ReferencePicker.md) — path text input + browseable panel.
- [QueryBuilder](./firestore/QueryBuilder.md) — single-level where/orderBy/limit form.
- [DeleteWithConfirm](./firestore/DeleteWithConfirm.md) — composes useConfirm + useRecursiveDelete.

## Auth

`@pyric/ui/auth` — emulator-style sign-in for sandbox auth.

- [AuthSignInHelper](./auth/AuthSignInHelper.md) — account picker + add-account
  form behind `useAuthFlowHelper` (the `AuthFlowResolver` host for
  `signInWithPopup` / `signInWithRedirect`), with emulator-grade
  custom-claims validation.
- [Auth users admin](./auth/AuthUsers.md) — `useAuthUsers` +
  `useAuthUserEditor`, the `AuthUserList` table, `AuthUserForm`,
  `ClaimsField`, and confirm-gated delete/clear actions.

## Storage

`@pyric/ui/storage` — browse Firebase Storage (sandbox or prod) via one
`FirebaseStorage` handle. See the [subpath overview](./storage/README.md)
for the wiring + hooks.

- [ObjectBrowser](./storage/ObjectBrowser.md) — folders-first row list; folder rows navigate, object rows select; virtualized above 100 rows.
- [PathBreadcrumb](./storage/PathBreadcrumb.md) — clickable ancestor trail.

## Traffic

`@pyric/ui/traffic` — observe rule-eval traffic. See the
[subpath overview](./traffic/README.md) for the decoupling contract + hooks.

- [TrafficLog](./traffic/TrafficLog.md) — the DevTools-style event stream (+ `TrafficRow`, `TrafficGroupRow`).
- [TrafficDetail](./traffic/TrafficDetail.md) — drill-in panel for one event.
- [RuleHeatmap](./traffic/RuleHeatmap.md) — per-rule fire / deny rollup.
- [TrafficStats](./traffic/TrafficStats.md) — totals + breakdowns.

## Hooks

All hooks are exported from the corresponding subpath (`/firestore/hooks` or `/primitives`). The hook documentation lives in the source JSDoc — every exported hook has a description, an options interface, and a return-shape interface with comments per field. Open the source or your editor's hover-help to read them.

Highlights:

- `useFirestoreDoc(ref)`, `useFirestoreCollection(query)` — `onSnapshot` subscriptions returning `{ data, error, isLoading }`.
- `useDocumentEditor({ initial })` — owns the editor reducer; returns `{ tree, errorCount, isDirty, isValid, setValue, …, toData }`.
- `useReferencePicker({ firestore, listCollections })` — browse + parse state machine.
- `useQueryBuilder({ initial })` — composes a Firestore `Query` from a where/orderBy/limit form.
- `useCollectionList`, `useDocumentList`, `useRecursiveDelete`, `useConfirm`, `useToast`, `useContainerSize`.
- `useStorageList(storage, path)` — `listAll` + prefix→folder synthesis; `{ status, items, prefixes, entries, error, refresh }` + the optimistic insert/remove seam.
- `usePathState({ path?, onPathChange?, defaultPath? })` — controlled/uncontrolled storage-path navigation.
- `useTrafficMonitor({ source })` — capped ring buffer over a `TrafficSource`; `pause`/`resume`/`clear` + `counts`.
- `useTrafficFilter`, `useRuleHeatmap`, `useTrafficStats`, `useTrafficGroups` — pure derivations over a traffic buffer.

## See also

- Live showcase — one Astro page per component with copy-pasteable Tailwind styling for the `[data-pyric-*]` selectors.

## Styling pattern (all components)

The library ships **no CSS**. Components emit structural `data-pyric-*` attributes that consumers target with attribute selectors:
```css
[data-pyric-ui='document-preview'] { /* root */ }
[data-pyric-field-type='reference'][data-pyric-clickable] { /* clickable refs */ }
[data-pyric-toast][data-pyric-toast-kind='error'] { /* error toast */ }
```
See [`examples/admin-playground/src/styles/global.css`](../../../examples/admin-playground/src/styles/global.css) for a complete set of Tailwind-based rules covering every component the library ships.
