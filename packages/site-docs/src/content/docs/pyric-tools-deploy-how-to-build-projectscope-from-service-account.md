---
title: "How to build a ProjectScope from a service account"
navLabel: "Scope from service account"
group: "pyric-tools / deploy"
section: "How-to"
order: 9004
---
# How to build a `ProjectScope` from a service account

This guide shows you how to wire a Google service-account JSON into a `ProjectScope` for use with every primitive in `pyric-tools/deploy`.

## From a file path

```ts
import { fromServiceAccount } from 'pyric-tools/deploy';

const scope = await fromServiceAccount('./service-account.json');
```

The function reads the JSON, validates the required fields (`client_email`, `private_key`, `project_id`), and returns a scope whose `resolveToken` is internally memoised. You don't need to wrap it in `memoizeTtl` yourself.

## From a base64-encoded env var

Useful when shipping the SA in CI or an environment variable instead of a file:

```bash
SA_KEY="base64:$(base64 -w0 service-account.json)"
```

```ts
const scope = await fromServiceAccount(process.env.SA_KEY!);
```

`fromServiceAccount` decodes anything prefixed with `base64:`.

## From a literal JSON string

If the SA already lives in memory as a JSON string:

```ts
const scope = await fromServiceAccount(rawJsonString);
```

The function detects this by looking at the first non-whitespace character: a `{` means parse as JSON, otherwise treat as a path.

## Required IAM

The service account needs OAuth scopes for what each primitive touches:

- `https://www.googleapis.com/auth/firebase`
- `https://www.googleapis.com/auth/cloud-platform`

`fromServiceAccount` requests both scopes from Google's token endpoint, so the service account principal needs the matching IAM roles. The simplest setup grants **Firebase Admin** + **Service Account Token Creator**; more granular setups grant the minimum per-operation IAM listed in each namespace's reference page.

## What the returned scope contains

```ts
const scope = await fromServiceAccount('./service-account.json');

scope.projectId;       // string — frozen, can't be reassigned
await scope.resolveToken();  // Promise<string> — cached for ~90% of TTL
```

The scope is `Object.freeze`d, so accidental mutation of `projectId` fails at runtime as well as compile-time. This matters because `projectId` is a security-relevant identity field.

## Where to look next

- Don't have a service account? Use [Build a `ProjectScope` from Firebase Auth (browser)](../pyric-tools-deploy-how-to-build-projectscope-from-firebase-auth/).
- Want to understand why the resolver is memoised at 90% TTL? See [Token caching and `memoizeTtl`](../pyric-tools-deploy-explanation-token-caching/).
