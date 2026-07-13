---
title: "useStorageRulesGate"
group: "@pyric/ui"
section: "Storage"
order: 23023
---
# `useStorageRulesGate`

Pre-flight rules evaluation — evaluate the current identity against storage paths **before the click**, so the UI can mark denied affordances (`data-pyric-denied` rows, disabled-with-reason buttons) instead of letting the user discover a denial through a thrown `storage/unauthorized`. Built on the pure evaluator exports from `pyric/storage` (`parseStorageRules` + `evaluateStorageRules`) — the same evaluator the sandbox enforces with.
```ts
import { useStorageRulesGate } from '@pyric/ui/storage/hooks';
```
## Example
```tsx
function GatedAdmin({ storage }) {
  const nav = usePathState();
  const list = useStorageList(storage, nav.path);
  const selection = useStorageSelection();
  const gate = useStorageRulesGate(storage);
  const pathVerdict = gate.verdictFor(nav.path);

  return (
    <>
      <UploadDropzone
        disabled={!pathVerdict.upload}
        disabledReason={pathVerdict.reasons.write.join('; ')}
        onFiles={/* … */}
      >
        <ObjectBrowser entries={list.entries} gate={gate} /* … */ />
      </UploadDropzone>
      <DeleteSelectionWithConfirm
        storage={storage}
        entries={selection.selected}
        gate={gate}
      />
    </>
  );
}
```
## Signature
```ts
useStorageRulesGate(storage, {
  paths?, rules?, identity?, writeResource?,
}): {
  status, source, advisory, identity, verdicts, verdictFor, error,
}
```
### Options

| Option | Type | Description |
|---|---|---|
| `paths` | `string \| readonly string[]` | Paths pre-evaluated into `verdicts` (keyed by normalized path). Ad-hoc paths go through `verdictFor` — same evaluation. |
| `rules` | `string \| StorageRules` | Explicit rules source — raw text (parsed here; malformed → `status: 'error'`) or pre-parsed. Overrides the sandbox's deployed ruleset. |
| `identity` | `StorageAuth \| null` | Identity override. `null` = anonymous; **omit** to use the handle's own identity (the sandbox context's `auth`). |
| `writeResource` | `{ size: number; contentType?: string }` | Bound as `request.resource` for the WRITE evaluation — pass it when gating a specific upload so size/contentType-conditioned rules evaluate truthfully. Omitted = delete semantics (no inbound payload). |

### Result

| Field | Type | Description |
|---|---|---|
| `status` | `'idle' \| 'loading' \| 'ready' \| 'error'` | `'idle'` only when `storage` is null. Sandbox rules resolve async (one await). |
| `source` | `'option' \| 'sandbox' \| 'none'` | Where the active ruleset came from. `'none'` = nothing reachable — everything allows (open-by-default, matching `pyric/storage` enforcement). |
| `advisory` | `boolean` | Always `false`; `pyric/storage` handles are sandbox mirrors. |
| `identity` | `StorageAuth \| null` | The identity verdicts evaluate under. |
| `verdicts` | `Record<string, StorageGateVerdict>` | Pre-evaluated verdicts for `paths`. |
| `verdictFor` | `(path: string) => StorageGateVerdict` | Evaluate any path — pure + synchronous once ready. |
| `error` | `Error \| undefined` | Rules-resolution failure (e.g. malformed `rules` text). |

`StorageGateVerdict` is `{ read, write, delete, upload, reasons }` —
`delete` and `upload` are **derived aliases of `write`** (the rules subset
has exactly two verbs; Firebase Storage's `write` governs
create/overwrite/delete). `reasons.read` / `reasons.write` carry the
evaluator's trace for denied verbs (`"match /users/{uid}/… : condition
false"`), ready for tooltips.

## Where rules and identity come from

- **Sandbox handle** — both are on the handle: the ruleset
  `getStorageSandbox(ctx, { rules })` parsed at config time, and the
  context's `auth`. Pass nothing; verdicts are **truthful** (same
  evaluator, same bindings as enforcement).

Production applications select `firebase/storage` through package
resolution, so this Pyric-only hook is not present in production bundles.

## Evaluation contract

- `resource` (the existing object) binds `null` — the gate doesn't fetch
  per-path metadata, mirroring how the sandbox enforces `listAll`. Rules
  over `resource.*` evaluate as if the object doesn't exist.
- The gate **fails open**: idle/loading/error and rules-less states return
  the allow-all verdict. Affordances only ever add warnings; enforcement
  stays real.

## See also

- [Rules-aware affordances](../ui-storage-rules-aware-affordances/) — the concept
  note: which component consumes which verdict.
- the design rationale — the
  request/denial *stream* (traffic panel) spec, blocked on a
  `pyric/storage` event channel.
