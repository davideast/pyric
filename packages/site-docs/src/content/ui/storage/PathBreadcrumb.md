---
title: "<PathBreadcrumb>"
group: "@pyric/ui"
section: "Storage"
order: 190
---
# `<PathBreadcrumb>`

Headless breadcrumb for a storage path. Renders a root crumb plus one crumb per segment; every crumb (including the current one) is a real `<button>` firing `onNavigate` with that ancestor's absolute path.

```ts
import { PathBreadcrumb } from '@pyric/ui/storage';
```

## Example

```tsx
import { usePathState } from '@pyric/ui/storage/hooks';

function Crumbs() {
  const nav = usePathState({ defaultPath: 'docs/sub' });
  return (
    <PathBreadcrumb
      path={nav.path}
      onNavigate={nav.setPath}
      rootLabel="my-bucket"
      separator="›"
    />
  );
}
```

## Props

| Prop | Type | Description |
|---|---|---|
| `path` | `string` | Current path. Normalized internally (edge slashes stripped). `''` renders just the root crumb. |
| `onNavigate` | `(path: string) => void` | Fired with the clicked crumb's absolute path (`''` for root). Wire to `usePathState.setPath`. |
| `rootLabel` | `ReactNode` | Root crumb label. Default `'/'` — pass the bucket name for a `gs://bucket` feel. |
| `separator` | `ReactNode` | Rendered between crumbs. Default `'/'`. |
| `className` | `string` | Forwarded to the `<nav>` root. |

## Styling hooks

```
[data-pyric-ui="path-breadcrumb"]            /* the <nav> */
[data-pyric-breadcrumb-list]                 /* the <ol> */
[data-pyric-breadcrumb-item]                 /* each <li> */
[data-pyric-breadcrumb-link]                 /* each crumb button */
[data-pyric-breadcrumb-link][data-pyric-current]   /* the current level (also aria-current="page") */
[data-pyric-breadcrumb-root]                 /* the root crumb's button */
[data-pyric-breadcrumb-separator]            /* the separators (aria-hidden) */
```

## Notes

- **The current crumb is clickable** — wiring `onNavigate` to a path-keyed loader makes it a free "refresh this level" affordance. Disable via CSS (`[data-pyric-current] { pointer-events: none }`) if you'd rather not.
- **Controlled vs uncontrolled** lives in `usePathState`, not here — this component is fully controlled (`path` in, `onNavigate` out), same as every other component in the package.

## See also

- [`<ObjectBrowser>`](./ObjectBrowser.md) — the row list below the trail.
- `usePathState` — the navigation state source.
