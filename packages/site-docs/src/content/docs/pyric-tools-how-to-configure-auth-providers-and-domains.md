---
title: "How to configure auth providers and authorised domains"
navLabel: "Configure auth providers"
group: "pyric-tools"
section: "How-to"
order: 34
---
# How to configure auth providers and authorised domains

When you move from building in the sandbox to running against a real Firebase
project, you have to prepare that project's authentication: turn on the sign-in
providers your app uses, and authorise the domains your app will redirect from.
`pyric auth:configure-provider` and `pyric auth:manage-domains` do both from the
CLI (or from an agent), so you don't have to click through the Firebase Console.

> **These commands mutate a real Firebase project, not the sandbox.** They call
> Google's Identity Toolkit admin API directly against the resolved project.
> There is no dry-run — a successful invocation changes production auth config.
> Point them at the project you actually intend to change.

## Prerequisites

Because these commands write to a real project, they need credentials and a
target project before they will do anything.

1. **Service-account credentials.** Provide *one* of:

   - `FIREBASE_SA_BASE64` — base64-encoded service-account JSON (ideal for CI;
     decoded in memory, never written to disk), or
   - `GOOGLE_APPLICATION_CREDENTIALS` — a filesystem path to a service-account
     JSON file (the standard Google ADC convention).

   If neither is set, the command fails before making any request:
   ```
   pyric: no service-account credentials found. Set FIREBASE_SA_BASE64
   (base64-encoded JSON) or GOOGLE_APPLICATION_CREDENTIALS (path to JSON file).
   ```
2. **A target project.** The project id is resolved in this order:

   1. the `--project <id>` flag,
   2. the `PYRIC_PROJECT` environment variable,
   3. the `default` project in `.firebaserc`,
   4. the service account's own `project_id`.

   Pass `--project` explicitly whenever you want to be certain which project you
   are mutating.

The service account must have permission to edit the project's Identity Toolkit
config; a `403` surfaces as a `PERMISSION_DENIED` error in the command output.

## Enable or disable a provider
```sh
pyric auth:configure-provider <anonymous|email|phone|google> <true|false>
```
The first argument is the provider, the second is whether to enable (`true`) or
disable (`false`) it. Both are required, and the provider must be exactly one of
the four supported ids — `anonymous`, `email`, `phone`, or `google`.

To turn on anonymous sign-in:
```sh
pyric auth:configure-provider anonymous true --project my-app
```
To turn on email/password sign-in (Identity Toolkit enables it with a password
requirement):
```sh
pyric auth:configure-provider email true --project my-app
```
To disable a provider, pass `false`:
```sh
pyric auth:configure-provider phone false --project my-app
```
The command prints the result as JSON and exits `0` on success, `2` on a failed
operation, and `1` on bad arguments or an unresolved scope.

### Provider-specific behaviour

- **`phone`** — enabling phone succeeds, but SMS delivery requires a billing
  account. The result includes a `warning` reminding you to confirm billing is
  enabled for the project in the Google Cloud Console.
- **`google`** — Google sign-in can only be *toggled* once its OAuth client has
  been provisioned. If it has never been set up, the command returns a
  `GOOGLE_NOT_PROVISIONED` error: enable Google once in the Firebase Console
  (Authentication → Sign-in method → Google) to auto-provision the OAuth client,
  after which this command can enable or disable it freely.
- **`anonymous`** and **`email`** — enabled or disabled instantly, with no
  external dependency.

## Manage authorised domains

Authorised domains are the allowlist Firebase Auth uses for OAuth redirects. If
you deploy to a new hosting domain and forget to authorise it, Google sign-in
and other redirect-based providers will fail. Use this command to inspect and
edit that list.
```sh
pyric auth:manage-domains <add|remove|list> [domain]
```
The action is required and must be `add`, `remove`, or `list`. The `domain`
argument is required for `add` and `remove`, and ignored for `list`.

### List the current domains
```sh
pyric auth:manage-domains list --project my-app
```
This reads the project's auth config and prints the current `authorizedDomains`
array. It makes no changes.

### Add a domain
```sh
pyric auth:manage-domains add app.example.com --project my-app
```
Adds the domain to the allowlist and writes the updated list back. If the domain
is already present, the command succeeds and returns the unchanged list (it is
idempotent).

### Remove a domain
```sh
pyric auth:manage-domains remove old.example.com --project my-app
```
Removes the domain and writes the updated list back. If the domain isn't in the
list, the command succeeds with the list unchanged. Removing `localhost`
succeeds but returns a `warning`, since dropping it can break local development —
re-add it with `add` if you need it.

Like `auth:configure-provider`, this command prints its result as JSON, exiting
`0` on success, `2` on a failed operation, and `1` on missing or invalid
arguments.

## Reference

For the full flag list and exit codes, see the CLI reference:

- [`pyric auth:configure-provider`](../pyric-tools-reference-cli/)
- [`pyric auth:manage-domains`](../pyric-tools-reference-cli/)
