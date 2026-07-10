---
title: "@pyric/ui"
navLabel: "Overview"
group: "@pyric/ui"
section: ""
order: 174
---
# `@pyric/ui` docs

Per-component reference. Each page is one-screen — import, minimal example, props table, common gotchas.

## Primitives

`@pyric/ui/primitives`

- [CopyButton](../ui-primitives-copybutton/) — clipboard button exposing `data-copied`.
- [Badge](../ui-primitives-badge/) — headless pill exposing `data-pyric-badge-kind`.
- [JsonView](../ui-primitives-jsonview/) — collapsible JSON tree.
- [SegmentedControl](../ui-primitives-segmentedcontrol/) — single-select chip group (ARIA radiogroup).
- [ConfirmDialog](../ui-primitives-confirmdialog/) — headless dialog + imperative `useConfirm` provider.
- [Toast](../ui-primitives-toast/) — toast queue + `useToast` hook.
- [VirtualList](../ui-primitives-virtuallist/) — TanStack-Virtual wrapper for long lists.

## Firestore

`@pyric/ui/firestore`

- [DocumentPreview](../ui-firestore-documentpreview/) — read-only field renderer.
- [DocumentEditor](../ui-firestore-documenteditor/) — reducer-backed editor + compound component.
- [CollectionList](../ui-firestore-collectionlist/) — headless list renderer for collections.
- [DocumentList](../ui-firestore-documentlist/) — paginated + optionally virtualized doc list.
- [ReferencePicker](../ui-firestore-referencepicker/) — path text input + browseable panel.
- [QueryBuilder](../ui-firestore-querybuilder/) — single-level where/orderBy/limit form.
- [DeleteWithConfirm](../ui-firestore-deletewithconfirm/) — composes useConfirm + useRecursiveDelete.

## Auth

`@pyric/ui/auth` — emulator-style sign-in for sandbox auth.

- [AuthSignInHelper](../ui-auth-authsigninhelper/) — account picker + add-account
  form behind `useAuthFlowHelper` (the `AuthFlowResolver` host for
  `signInWithPopup` / `signInWithRedirect`), with emulator-grade
  custom-claims validation.
- [Auth users admin](../ui-auth-authusers/) — `useAuthUsers` +
  `useAuthUserEditor`, the `AuthUserList` table, `AuthUserForm`,
  `ClaimsField`, and confirm-gated delete/clear actions.

## Storage

`@pyric/ui/storage` — browse Firebase Storage (sandbox or prod) via one
`FirebaseStorage` handle. See the [subpath overview](../ui-storage/)
for the wiring + hooks.

- [ObjectBrowser](../ui-storage-objectbrowser/) — folders-first row list; folder rows navigate, object rows select; virtualized above 100 rows.
- [PathBreadcrumb](../ui-storage-pathbreadcrumb/) — clickable ancestor trail.

## Traffic

`@pyric/ui/traffic` — observe rule-eval traffic. See the
[subpath overview](../ui-traffic/) for the decoupling contract + hooks.

- [TrafficLog](../ui-traffic-trafficlog/) — the DevTools-style event stream (+ `TrafficRow`, `TrafficGroupRow`).
- [TrafficDetail](../ui-traffic-trafficdetail/) — drill-in panel for one event.
- [RuleHeatmap](../ui-traffic-ruleheatmap/) — per-rule fire / deny rollup.
- [TrafficStats](../ui-traffic-trafficstats/) — totals + breakdowns.

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
See `examples/admin-playground/src/styles/global.css` for a complete set of Tailwind-based rules covering every component the library ships.
