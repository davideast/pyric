---
title: "Package exports and resolution"
group: "@pyric/cli"
section: "Reference"
order: 100
---
# Package exports and resolution

Install `@pyric/cli` as a development dependency. It provides the `pyric`
binary and a small set of explicit programmatic subpaths; the package root is
not an import target.

```bash
npm install -D @pyric/cli
npx pyric --help
```

## Public subpaths

| Import | Purpose |
|---|---|
| `@pyric/cli/credentials/node` | Build a credential scope for hosted Rules Test API verification. |
| `@pyric/cli/verify` | Replay captured sessions and derive Rules Test API cases. |
| `@pyric/cli/assurance` | Define and run assurance campaigns. |
| `@pyric/cli/assurance/browser` | Attach a browser to an assurance campaign. |
| `@pyric/cli/bridge` | Start or connect to a sandbox bridge. |
| `@pyric/cli/bridge/client` | Use the browser bridge client directly. |
| `@pyric/cli/discover` | Credential-free discovery against a supplied sandbox or data source. |
| `@pyric/cli/vite` | Resolve canonical Firebase Web SDK imports to the browser sandbox during Vite development. |
| `@pyric/cli/serve/worker` | Use the SharedWorker sandbox host. |
| `@pyric/cli/remote` | Connect Node code to a running sandbox. |
| `@pyric/cli/register` | Activate Node package-resolution hooks when the development environment requests them. |

The package manifest is the authority for this list. An import that is not in
`exports` is private and may not resolve from a packed release.

## Activated development resolution

Application and server source keeps canonical imports such as
`firebase/firestore` and `firebase-admin/app`.

- `@pyric/cli/vite` activates the Web SDK swap during `vite dev`. Vite resolves
  canonical `firebase/*` specifiers to the `pyric/*` sandbox mirrors, including
  imports made by dependencies.
- `pyric dev` activates the Node swap for the child process it runs. It sets
  `PYRIC_SANDBOX` and preloads `@pyric/cli/register`; the hook resolves
  `firebase/*` to `pyric/*` and `firebase-admin/*` to `pyric-admin/*`.
- A declared Functions source runs its CommonJS entry with the real installed
  `firebase-functions` package in its own Node child. Native ESM Functions
  entries are outside the first slice. Its `firebase-admin/app` and
  `firebase-admin/database` dependencies resolve to the same sandbox Admin
  adapters, so `event.data.ref` reads and writes share the app's RTDB.

Activation belongs to the development invocation, not to application source or
the presence of a file. That keeps the source identical on both sides of the
boundary.

## Inactive production resolution

Without `PYRIC_SANDBOX`, `@pyric/cli/register` is inert and installs no
resolution hooks. A production Vite build also leaves the development swap
inactive. The runtime's normal resolver therefore loads `firebase` and
`firebase-admin` directly.

`NODE_ENV=production` refuses accidental sandbox activation unless
`PYRIC_SANDBOX_FORCE=1` is set explicitly. That override is for controlled
development or CI only; it is not a production mode.

This resolution boundary does not deploy anything. Pyric owns sandbox
development, artifact generation, and verification. Firebase and
`firebase-tools` own production execution and deployment.
