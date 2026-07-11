---
title: "<QueryBuilder>"
group: "@pyric/ui"
section: "Firestore"
order: 200
---
# `<QueryBuilder>`

Single-level where/orderBy/limit query builder. Composes state into a real Firestore `Query` via the hook's `buildQuery(base)`.
```ts
import { QueryBuilder } from '@pyric/ui/firestore';
```
## Example
```tsx
import { useState } from 'react';
import { collection } from 'pyric/firestore';
import { QueryBuilder, useDocumentList, type UseQueryBuilderResult } from '@pyric/ui/firestore';

function FilteredDocs({ firestore }) {
  const [builder, setBuilder] = useState<UseQueryBuilderResult | null>(null);
  const base = collection(firestore, 'users');
  const query = builder?.buildQuery(base);
  const { documents } = useDocumentList({ collection: base, query });

  return (
    <>
      <QueryBuilder
        initial={{
          conditions: [{ id: 'c1', field: 'active', op: '==', value: true }],
          orderBy: { field: 'score', direction: 'desc' },
          limit: 20,
        }}
        onChange={setBuilder}
      />
      <DocumentList documents={documents} />
    </>
  );
}
```
## Props

| Prop | Type | Description |
|---|---|---|
| `initial` | `Partial<QueryBuilderState>` | Pre-populate conditions, orderBy, limit. |
| `onChange` | `(builder: UseQueryBuilderResult) => void` | Fires on every state change. Capture this to call `buildQuery`. |
| `className` | `string` | Forwarded to the root. |

## Value parsing

The value input is JSON-parsed on every change. So:

- `42` → number
- `"text"` → string
- `true` / `false` / `null` → those primitives
- `[1, 2, 3]` → array (for `in` / `not-in` / `array-contains-any` ops)
- Anything that doesn't parse as JSON → falls through as a raw string

For non-JSON Firestore values (Timestamp, GeoPoint, Reference, Bytes), the bundled component isn't enough — use `useQueryBuilder` directly with your own value editor.

## Direct hook access
```tsx
import {
  useQueryBuilder,
  QUERY_OPS,
  MULTI_VALUE_OPS,
} from '@pyric/ui/firestore/hooks';

const builder = useQueryBuilder({ initial: { conditions: [...] } });
// {
//   conditions, orderBy, limit,
//   addCondition, updateCondition, removeCondition,
//   setOrderBy, setLimit, reset, buildQuery,
// }
```
## What's not in v1

- **Compound `and()` / `or()` groups.** Single-level only — every condition is implicitly AND-joined. Compound groups deferred.
- **Cursor-based pagination (`startAfter`).** Use `useDocumentList` with the composed query — pagination is its job.

## Styling hooks
```
[data-pyric-ui="query-builder"]
[data-pyric-query-conditions]
[data-pyric-query-condition]
[data-pyric-query-field]
[data-pyric-query-op]
[data-pyric-query-value]
[data-pyric-query-remove]
[data-pyric-query-add-condition]
[data-pyric-query-modifiers]
[data-pyric-query-orderby]
[data-pyric-query-orderby-field]
[data-pyric-query-orderby-direction]
[data-pyric-query-limit]
[data-pyric-query-limit-input]
```
## Notes

- **Empty-field conditions are dropped** silently in `buildQuery`. The UI lets users add a row and fill it in over multiple keystrokes; passing a `where('', '==', '')` to Firestore would throw.
- **`limit: 0`** is treated as "no limit" (same as `undefined`). Firestore rejects `limit(0)` outright.
- **The hook is stable.** Calling `addCondition` / `updateCondition` etc. returns identity-stable callbacks; including the hook return value as an effect dep is safe.
