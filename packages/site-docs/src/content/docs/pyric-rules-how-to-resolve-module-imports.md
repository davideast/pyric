---
title: "How to resolve 2+modules imports"
navLabel: "Resolve 2+modules imports"
group: "pyric / rules"
section: "How-to"
order: 12007
---
# How to resolve `2+modules` imports

Write rules that import reusable helper functions, then resolve them into a standard Firestore rules source.

`2+modules` is a Pyric extension. The Firestore rules engine itself only understands `rules_version = '2'`. The resolver inlines all imported functions and rewrites the version, so the output is something Firebase will accept.

`resolveModules` is an engine-internal, Node-only seam, imported from `pyric/rules/internal/node`. It's not part of the public `pyric/rules` contract and may change without notice, but it's the supported way to resolve `2+modules` imports today.

## Author rules with imports

Set the version to `'2+modules'` and add `import` statements at the top of the file:

```rules
import { isAuthenticated, isOwner } from 'auth';
import { hasRequired, hasOnly } from 'validation';

rules_version = '2+modules';

service cloud.firestore {
  match /databases/{db}/documents {
    match /notes/{id} {
      allow read: if isAuthenticated();
      allow create: if isOwner(request.resource.data.ownerId)
                    && hasOnly(['ownerId', 'title', 'body']);
      allow update: if isOwner(resource.data.ownerId)
                    && hasRequired(['ownerId', 'title']);
    }
  }
}
```

## Resolve to standard rules

```ts
import { resolveModules } from 'pyric/rules/internal/node';

const result = resolveModules(source);
if (!result.success) {
  console.error(`[${result.error.code}] ${result.error.message}`);
  process.exit(1);
}

console.log(result.data.resolved);   // standard '2' rules, ready to deploy
console.log(result.data.modules);    // ['auth', 'validation']
```

The output uses `rules_version = '2'` and has the imported functions inlined at the root scope of the match block.

## Use the stdlib

Fifteen modules ship with the package: `auth`, `validation`, `lobby`, `turns`, `state`, `membership`, `lifecycle`, `transitions`, `geometry`, `counters`, `timing`, `content`, `spaces`, `joining`, `atomic`. They resolve automatically; you don't need to configure anything.

For the full list of exports, see [Standard library modules](../pyric-rules-reference-stdlib-modules/).

## Use your own `.rules` files

For project-specific helpers, write a `.rules` file and use a relative import:

```rules
import { hasModeratorClaim } from './lib/moderation';
```

Then point the resolver at the base directory:

```ts
const result = resolveModules(source, { basePath: './src' });
// Loads './src/lib/moderation.rules'
```

The resolved path is `${basePath}/${importPath}.rules`. Functions in your module file can be marked `export` (visible to importers) or left bare (private, renamed with a module prefix so they don't collide).

## Inject modules from memory

For tests, ephemeral environments, or any case where the source isn't on disk, pass `modules`:

```ts
const result = resolveModules(source, {
  modules: {
    './moderation': `
      export function hasModeratorClaim() {
        return request.auth.token.role == 'moderator';
      }
    `,
  },
});
```

The `modules` map takes priority over both `basePath` lookups and the stdlib, so you can override a stdlib module by name if you need to.

## Handle resolve failures

`result.error.code` discriminates the failure mode:

| Code | Meaning |
|---|---|
| `PARSE_FAILED` | The input source did not parse. Fix syntax first. |
| `NOT_MODULE_SOURCE` | The source has `rules_version = '2'`, not `'2+modules'`. No resolution needed; deploy as-is. |
| `UNKNOWN_MODULE` | An imported module name isn't in stdlib, the `modules` map, or `basePath`. |
| `UNKNOWN_FUNCTION` | The module exists but doesn't export the named function. The error message tells you if it exists but is private. |
| `DUPLICATE_FUNCTION` | Two modules export the same function name, or an imported function collides with one defined in the source. |

## Where to look next

- For all stdlib modules and their exports, see [Standard library modules](../pyric-rules-reference-stdlib-modules/).
- For the design rationale, see [The `2+modules` extension](../pyric-rules-explanation-the-2-plus-modules-extension/).
