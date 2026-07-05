# @pyric/ui

Headless React components and hooks for Firebase/Pyric admin surfaces. The
components ship behavior and structural `data-*` hooks, but no visual styling.

The same components can run against:

- a Pyric sandbox in local development;
- production Firebase handles in app/admin tooling;
- custom adapters that implement the documented API contracts.

## Subpaths

| Subpath | Surface |
|---|---|
| `@pyric/ui/auth` | Auth users, claims, and sign-in helper components |
| `@pyric/ui/auth/hooks` | Auth hooks |
| `@pyric/ui/firestore` | Firestore document, collection, query, and editor components |
| `@pyric/ui/firestore/hooks` | Firestore hooks |
| `@pyric/ui/storage` | Storage browser/editor components |
| `@pyric/ui/storage/hooks` | Storage hooks |
| `@pyric/ui/traffic` | Traffic log, detail, stats, and heatmap components |
| `@pyric/ui/traffic/hooks` | Traffic hooks |
| `@pyric/ui/events` | Activity/event digest components |
| `@pyric/ui/events/hooks` | Event hooks |
| `@pyric/ui/rules` | Rules debugging components |
| `@pyric/ui/rules/hooks` | Rules hooks |
| `@pyric/ui/primitives` | Copy button, dialog, toast, virtual list, badges, controls |
| `@pyric/ui/agents` | Agent-facing display primitives |

## Example

```tsx
import { DocumentPreview } from '@pyric/ui/firestore';
import { CopyButton } from '@pyric/ui/primitives';

export function Inspector({ snapshot }) {
  return (
    <section>
      <DocumentPreview snapshot={snapshot} />
      <CopyButton text={snapshot.ref.path}>Copy path</CopyButton>
    </section>
  );
}
```

## Styling

Every component emits structural attributes you can target from your own design
system:

```css
[data-pyric-ui='document-preview'] {
  display: grid;
  gap: 0.5rem;
}

[data-pyric-field-type='reference'] {
  color: var(--accent);
}
```

## Docs and Examples

- [Component docs](docs/README.md)
- [Admin playground](../../examples/admin-playground/)

## Development

```bash
bun run build
bun run test
bun run typecheck
```
