---
title: "API reference: pyric-admin/app"
navLabel: "API reference"
group: "pyric-admin / app"
section: "Reference"
order: 18002
---
# API reference: `pyric-admin/app`

Exact public surface of the sandbox-only admin app registry.

## `initializeApp(config?, name?)`
```ts
function initializeApp(
  config?: { sandbox: Sandbox },
  name?: string,
): PyricAdminApp;
```
The default name is `'[DEFAULT]'`.

- `initializeApp({ sandbox })` binds an in-process or remote sandbox.
- A bare `initializeApp()` obtains the remote sandbox factory installed by
  activated `@pyric/cli/register`.
- A non-sandbox config throws. Production callers load `firebase-admin/app`
  directly with Pyric activation absent.

For a bare call, `PYRIC_SANDBOX` accepts `remote` (discover a running `pyric
dev`) or `remote:<url>` (explicit host). Missing activation, an unknown value,
or a missing factory throws with remediation. When `NODE_ENV=production`,
sandbox activation is refused unless `PYRIC_SANDBOX_FORCE=1` is explicit.

Repeated initialisation for the same name is idempotent only when it represents
the same binding: bare after bare, or the same `Sandbox` reference. A different
binding throws a Firebase-shaped duplicate/options error.

## `getApp(name?)`
```ts
function getApp(name?: string): PyricAdminApp;
```
Return the registered app. The default name is `'[DEFAULT]'`. A missing app
throws `app/no-app`; an empty or non-string name throws
`app/invalid-app-name`.

## `getApps()`
```ts
function getApps(): PyricAdminApp[];
```
Return a copy of the registered app list.

## `deleteApp(app)`
```ts
function deleteApp(app: PyricAdminApp): Promise<void>;
```
Remove the app from the registry. The sandbox lifetime remains owned by its
creator. An invalid value throws `app/invalid-argument`.

## `isSandboxAdminApp(app)`
```ts
function isSandboxAdminApp(app: PyricAdminApp): app is SandboxAdminApp;
```
Test the package brand without inspecting the object structurally.

## Types and constants
```ts
const ADMIN_APP_TARGET: unique symbol;
const DEFAULT_APP_NAME = '[DEFAULT]';

type PyricAdminAppTarget = 'sandbox';
type InitializeAdminAppConfig = { sandbox: Sandbox };
type PyricAdminApp = SandboxAdminApp;

interface SandboxAdminApp {
  readonly [ADMIN_APP_TARGET]: 'sandbox';
  readonly sandbox: Sandbox;
  readonly name: string;
}
```
`ADMIN_APP_TARGET` uses `Symbol.for('pyric.admin.app.target')` so the brand is
stable across module instances.

## Resolution boundary

This module never delegates to Firebase Admin. Activated development resolves
canonical imports to this sandbox mirror. Inactive production execution leaves
resolution untouched and loads `firebase-admin/app` directly.
