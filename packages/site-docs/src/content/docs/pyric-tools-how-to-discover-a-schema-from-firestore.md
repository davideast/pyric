---
title: "How to infer a schema from an existing Firestore"
navLabel: "Infer a schema"
group: "pyric-tools"
section: "How-to"
order: 8006
---
# How to infer a schema from an existing Firestore

You have a real Firestore database and you want its inferred shape: the
collections, their fields, field types, presence ratios, enum-like value
sets, and example values. This guide walks you through running
`pyric firestore:discover` against that database so you can use the output
to write security rules, seed the local sandbox, or hand a schema to an
agent.

`pyric firestore:discover` crawls a **real, live Firestore**. It issues
list and read operations against the project you point it at, so make sure
you are targeting the database you intend to.

## Prerequisites

Discover talks to Google's APIs with a service account, so you need
credentials and a project before you run anything.

### Credentials

Provide a service account through **one** of these environment variables:

- `FIREBASE_SA_BASE64`: the service-account JSON, base64-encoded. It is
  decoded in memory and never written to disk, which makes it the better
  fit for CI runners.
- `GOOGLE_APPLICATION_CREDENTIALS`: a filesystem path to the
  service-account JSON file (the standard Google ADC convention).

If both are set, `FIREBASE_SA_BASE64` wins. If neither is set, the command
exits with an error telling you to set one of them.

```bash
# Option A — base64-encoded JSON (good for CI)
export FIREBASE_SA_BASE64="$(base64 < service-account.json)"

# Option B — path to the JSON file
export GOOGLE_APPLICATION_CREDENTIALS="/path/to/service-account.json"
```

The service account needs read access to the Firestore you want to crawl.

### Project

The project id is resolved in this order:

1. `--project <id>` on the command line.
2. The `PYRIC_PROJECT` environment variable.
3. The `default` project in a `.firebaserc` in the working directory.
4. The `project_id` baked into the service account.

For a one-off run against a specific database, pass `--project` explicitly
so there is no ambiguity:

```bash
pyric firestore:discover --project my-project-id
```

## Run the discover crawl

### Crawl the whole database

Omit the positional argument to walk every root collection and recurse
into subcollections:

```bash
pyric firestore:discover --project my-project-id
```

### Crawl a single collection

Pass a collection id as the positional argument to narrow the crawl to
that root collection (and its subcollections). This is the "tell me about
this one collection" probe. It avoids walking the whole tree:

```bash
pyric firestore:discover users --project my-project-id
```

The argument matches the **root collection id** exactly (for example
`users`), not a full path.

For the complete flag list, see the
[`pyric firestore:discover` reference](../pyric-tools-reference-cli/).

## Read and use the output

The command prints a single JSON object to stdout with these top-level
fields:

- `complete`: `true` if the crawl finished without a pending
  continuation, `false` otherwise.
- `listOps`: cumulative count of list operations the crawl issued.
- `readOps`: cumulative count of document reads the crawl issued.
- `schemaByTemplate`: a map keyed by **template path** (for example
  `users/{userId}/posts`), each value being the inferred schema for that
  collection.

Each entry under `schemaByTemplate` describes one collection:

- `templatePath`: the templated collection path, e.g.
  `users/{userId}/posts`. This is the cross-reference key you would line up
  against your security rules.
- `examplePath`: a concrete observed path, e.g. `users/uid_42/posts`,
  when one was sampled.
- `schema.fields`: a map of field name to a descriptor that carries the
  observed `types`, presence counts (`presenceSeen` / `presenceTotal`),
  whether the field was ever `null` (`nullable`), an optional
  `enumCandidate` (the low-cardinality value set), and an `example` value.
- `schema.samplesSeen`: how many documents were fed into the inference
  for that collection.
- `samplingComplete`: how sampling terminated for the collection:
  `converged_via_stable`, `converged_via_exhausted`, `converged_via_max`,
  or `sampling_open`. Treat `converged_via_max` and `sampling_open` as
  "schema may be incomplete".
- `declaredAt`: the document index at which convergence was declared, or
  `null` if it was not.
- `subcollectionTemplatePaths`: the child collection template paths
  discovered beneath this collection.

Redirect the output to a file so you can feed it into your next step:

```bash
pyric firestore:discover --project my-project-id > schema.json
```

From there you can use the inferred schema to author security rules
against the `templatePath` keys, seed the local sandbox with realistic
fixtures from the `example` values, or hand `schema.json` to an agent as
ground truth for the database's shape.
