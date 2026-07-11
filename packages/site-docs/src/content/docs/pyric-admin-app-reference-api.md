---
title: "API reference: pyric-admin/app"
navLabel: "API reference"
group: "pyric-admin / app"
section: "Reference"
order: 169
---
# API reference: `pyric-admin/app`

Exact signatures of every public export. This subpath owns the app registry and the sandbox-vs-production decision; the service subpaths dispatch on the handle it returns.

---

## Initialization

### `initializeApp(config?, name?)`
```ts
function initializeApp(
  config?: { sandbox: Sandbox } | AppOptions,
  name?: string, // default '[DEFAULT]'
): PyricAdminApp;
```
Initialize an app and register it under `name`, mirroring `firebase-admin/app.initializeApp`. The `config` argument selects one of three arms:

**Production arm: `initializeApp({ credential, ... })`.** Any `firebase-admin/app` `AppOptions` object. Delegates to `firebase-admin/app.initializeApp` and wraps the resulting `App` in a `ProdAdminApp`. Every service subpath resolves this handle to the genuine firebase-admin service.

**Sandbox arm: `initializeApp({ sandbox })`.** Takes a `Sandbox` from `pyric/sandbox`'s `initializeSandbox()`, or a remote sandbox handle (a Node-side handle onto the browser-hosted worker sandbox). Registers a `SandboxAdminApp`. This is the one pyric-flavored line in otherwise firebase-admin-shaped code.

**Ambient arm: `initializeApp()` with no config.** The environment decides:

- `PYRIC_SANDBOX` unset or empty: exactly firebase-admin's behavior. Delegates to `firebase-admin/app.initializeApp()` (its autoInit path: `FIREBASE_CONFIG` env plus application-default credentials) and registers the prod arm.
- `PYRIC_SANDBOX=remote`: obtains a remote sandbox from the factory installed at `globalThis[Symbol.for('pyric.remote.sandboxFactory')]` by `pyric-tools/register`, and registers the sandbox arm. One activation line is logged to stderr.
- `PYRIC_SANDBOX=remote:<url>`: same, with an explicit host url (split on the first colon only, since urls contain colons).
- Any other `PYRIC_SANDBOX` value throws. An unrecognized activator never silently falls through to production.
- If the env is set but no factory is installed, throws with remediation: run under `pyric dev`, or add `--import pyric-tools/register` to `NODE_OPTIONS`.

**Production guard.** When `NODE_ENV === 'production'` and `PYRIC_SANDBOX` is set, the ambient arm throws instead of routing firebase-admin to a development sandbox. Set `PYRIC_SANDBOX_FORCE=1` if the routing is intentional.

Ambient resolution happens only on the bare call. Any explicit config (`{ sandbox }`, prod options, even `{}`) bypasses the environment entirely.

**Idempotency and duplicate names** mirror firebase-admin's lifecycle:

| Repeat call for the same name | Result |
|---|---|
| bare after bare | returns the existing auto-initialized app |
| bare after config'd (or config'd after bare) | throws `app/invalid-app-options` |
| `{ sandbox }` with the SAME `Sandbox` reference | returns the existing app (reference identity is the deep-equal analog) |
| `{ sandbox }` with a different `Sandbox` | throws `app/duplicate-app` |
| prod options after prod options | delegated to firebase-admin itself: deep-equal options return the same app; a `credential` or `httpAgent` re-init throws `app/invalid-app-options`; different options throw `app/duplicate-app` |

### `getApp(name?)`
```ts
function getApp(name?: string): PyricAdminApp; // default '[DEFAULT]'
```
Return the registered app for `name`. Throws `app/no-app` with firebase-admin's exact message text on a miss, and `app/invalid-app-name` for a non-string or empty name.

### `getApps()`
```ts
function getApps(): PyricAdminApp[];
```
A copy of the list of all registered apps.

### `deleteApp(app)`
```ts
function deleteApp(app: PyricAdminApp): Promise<void>;
```
Remove `app` from the registry. Prod-backed apps also delete the underlying firebase-admin app, freeing its slot so the name can be re-initialized. Sandbox-backed apps only deregister; the `Sandbox` handle's lifetime belongs to its creator. Throws `app/invalid-argument` for a value that is not a branded app, and `app/no-app` if the app is not registered.

---

## Arm guards

### `isSandboxAdminApp(app)` / `isProdAdminApp(app)`
```ts
function isSandboxAdminApp(app: PyricAdminApp): app is SandboxAdminApp;
function isProdAdminApp(app: PyricAdminApp): app is ProdAdminApp;
```
Type guards over the brand symbol. Use these instead of structural sniffing when code needs to branch on the backend.

---

## Error identity

App-lifecycle errors reuse `firebase-admin/app`'s own exported `FirebaseAppError` class. `instanceof`, `constructor.name`, `.code`, and message text match production byte for byte (verified against recorded `admin-app-*` observations).

| Code | Thrown by |
|---|---|
| `app/no-app` | `getApp` on a missing name; `deleteApp` on an unregistered app |
| `app/duplicate-app` | re-init of a config'd name with a different configuration |
| `app/invalid-app-options` | bare-vs-config'd mismatch (firebase-admin's autoInit mismatch); prod re-init carrying `credential`/`httpAgent` |
| `app/invalid-app-name` | non-string or empty `name` |
| `app/invalid-argument` | `deleteApp` on a non-app value |

The ambient guard errors (production refusal, missing factory, unrecognized `PYRIC_SANDBOX` value) are plain `Error`s with remediation text, not `FirebaseAppError`s.

### `PyricAdminAppError`
```ts
const PyricAdminAppError: new (code: string, message: string) => Error & { readonly code: string };
type PyricAdminAppError = InstanceType<typeof PyricAdminAppError>;
```
Deprecated alias kept for pre-merge call sites. It IS `FirebaseAppError`; catch that instead.

---

## Types and constants

### `PyricAdminApp`
```ts
type PyricAdminApp = SandboxAdminApp | ProdAdminApp;

interface SandboxAdminApp {
  readonly [ADMIN_APP_TARGET]: 'sandbox';
  readonly sandbox: Sandbox;
  readonly name: string;
}

interface ProdAdminApp {
  readonly [ADMIN_APP_TARGET]: 'prod';
  readonly adminApp: App; // firebase-admin/app's App
  readonly name: string;
}
```
The branded handle every service subpath dispatches on. `name` mirrors firebase-admin's `App.name`.

### `ADMIN_APP_TARGET`
```ts
const ADMIN_APP_TARGET: unique symbol; // Symbol.for('pyric.admin.app.target')
```
The brand symbol. Registered under `Symbol.for` so it matches across module instances.

### `PyricAdminAppTarget`
```ts
type PyricAdminAppTarget = 'sandbox' | 'prod';
```
### `DEFAULT_APP_NAME`
```ts
const DEFAULT_APP_NAME = '[DEFAULT]';
```
firebase-admin's default app name.

### `InitializeAdminAppConfig`
```ts
type InitializeAdminAppConfig = { sandbox: Sandbox } | AppOptions;
```
The accepted `config` shapes for `initializeApp`.

---

## Where to go next

- [`pyric-admin/firestore` reference](../pyric-admin-firestore-reference-api/) for the first service that consumes these handles.
- [`pyric-admin/auth` reference](../pyric-admin-auth-reference-api/) for the three-arm dispatch pattern in full.
