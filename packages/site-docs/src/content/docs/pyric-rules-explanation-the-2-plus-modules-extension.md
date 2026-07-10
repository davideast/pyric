---
title: "The 2+modules extension"
group: "pyric / rules"
section: "Explanation"
order: 117
---
# The `2+modules` extension

Firestore rules don't have imports. The DSL has functions, but every function has to be defined in the same file as the match block that calls it. This means real-world rules either repeat the same helper code across files (and drift) or live in one giant file (and become unreadable).

`2+modules` is a Pyric extension that adds imports to the rules language — on the way *into* the Firebase deploy. The production rules engine never sees `2+modules`; it only sees standard `'2'` rules. The resolver does the rewrite.

## What it adds

A new version string and an `import` statement:
```rules
import { isAuthenticated, isOwner } from 'auth';
import { hasOnly } from 'validation';

rules_version = '2+modules';
service cloud.firestore { … }
```
Module names are either:

- **Stdlib** names like `auth`, `validation`, `lobby` — built-in modules bundled with the package.
- **Relative paths** like `./moderation` — resolved against a `basePath` you supply.
- **In-memory entries** — passed via `options.modules` as a `Record<name, source>`.

Functions inside a module file declare visibility with `export`:
```rules
// auth.rules
export function isAuthenticated() { return request.auth != null; }
export function isOwner(userId) { return isAuthenticated() && request.auth.uid == userId; }

function _private() { return request.time != null; }
```
`isAuthenticated` and `isOwner` are importable. `_private` is not — it's an internal helper.

## What it doesn't add

Crucially: no new runtime behaviour. Every `2+modules` source is equivalent to a `'2'` source with all imported functions inlined and the version rewritten. The resolver does the work; the Firebase engine sees standard rules. There is no module system at runtime, no lazy loading, no separate compilation.

This is deliberate. We did not want to extend the rules language in any way that production wouldn't understand. The constraint is: anything you write in `2+modules` must reduce to something Firebase will accept after `resolveModules` runs. No new operators, no new types, no behaviour that doesn't exist in the underlying DSL.

## How resolution works

1. **Parse** the source. If `version !== '2+modules'`, return `NOT_MODULE_SOURCE`.
2. **Load** every imported module. Stdlib names resolve from a bundled assets directory; relative paths read from `basePath`; entries in `options.modules` win first.
3. **Prefix private functions** with the sanitised module name (`auth__isAuthenticated`) so they don't collide. Exported functions keep their original name.
4. **Collect** every requested function plus its transitive dependencies. A function `isOwner` that calls `isAuthenticated` brings the latter along automatically.
5. **Inject** the resulting function list at root scope inside the match block.
6. **Rewrite** the version to `'2'` and clear the import list.
7. **Assemble** the AST back to a rules source string.

The output is a standard `'2'` rules source with the imports gone and the relevant helpers inlined. You feed that to `firebase deploy` (or to `pyric-tools/deploy`'s release primitive) and Firebase is none the wiser.

## Why prefix only private functions

Two reasons:

- **Collision safety**: a private helper named `cfg` in `geometry.rules` should not collide with a function named `cfg` defined in the user's own rules. Prefixing it to `geometry__cfg` keeps the user-defined name available.
- **Stable export API**: exported functions are the module's public surface. Prefixing them would force every caller to use the prefixed name (`auth__isAuthenticated()`), which defeats the point of imports.

## Why no syntax-level module boundaries

The resolver flattens everything into a single function namespace. This means an exported function from `auth` and an exported function from `validation` cannot share a name — if they do, the resolver returns `DUPLICATE_FUNCTION` and refuses to assemble.

We considered keeping the prefix on exported functions and rewriting the call sites in the user's source. We rejected it because:

- The result is opaque (`auth__isOwner(...)`); the import was supposed to make it readable.
- Conflicts between exported names are rare in practice — the stdlib is small and curated, and project-local modules tend to be domain-specific.
- The diagnostic is clear: `DUPLICATE_FUNCTION` tells you exactly which modules collide.

## Why a custom version string

We needed a marker that distinguishes "this source needs resolution before deploy" from "this source is ready to deploy". The two choices were:

1. **A new version string** (`'2+modules'`): unambiguous, single-source-of-truth, fails fast on accidental deploy.
2. **A comment or directive** (`// @pyric:modules`): unobtrusive but easy to ignore.

We chose (1) because Firebase's deploy path validates the version string before parsing anything else. If a `2+modules` source leaks into a real deploy by accident, Firebase rejects it with a clear error — "unknown rules version" — instead of attempting to parse the imports as rules.
