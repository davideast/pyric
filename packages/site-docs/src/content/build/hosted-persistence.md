---
title: Hosted persistence and recovery
group: Build
order: 90
---

# Hosted persistence and recovery

With `pyric sandbox --hosted` or the Vite plugin's `hosted: true`, one Node
process owns the sandbox and saves it in `.pyric/state/hosted/state.sqlite`.
Firestore, Auth and Realtime Database use the existing structured value format.
Storage files are raw SQLite BLOBs with their metadata. Each Storage operation
retains the 8 MiB limit.

Hosted mode requires Node 22.15 or later. The Bun standalone binary and Vite
running under Bun cannot run the hosted backend yet. SharedWorker mode remains
available and keeps its existing browser persistence. The in-process MCP JSON
store also remains separate. Switching runtime modes does not move or import
state, and hosted startup does not inspect old JSON files.

Use a local, unsynced disk. Network filesystems are unsupported. Pyric warns
about some known synced folders, but the absence of a warning does not establish
that a directory is safe. SQLite uses WAL and FULL synchronization; durability
still depends on the filesystem and device honoring synchronization requests.

## What a successful write means

A successful mutation response follows its persistence commit. A structured
flush commits changed records and deletions together. A Storage mutation commits
bytes and metadata together. There is no new transaction across separate
Firebase calls. AI/Traffic history, delivery queues and browser sign-in sessions
do not gain a persistence guarantee from this store.

If the connection disappears before a response, inspect the data before retrying:
the operation may have committed. If an in-memory change cannot be saved, the
caller gets `committed-but-not-durable`. A failed Storage transaction leaves its
previous state intact and reports `persistence-unhealthy`. Further mutations are
blocked until the store is repaired and the host restarts. Reads remain useful,
but may include unsaved in-memory changes. Diagnostics, Studio and the runtime
chip report the failure.

## Export or start fresh

Export a portable fixture with the existing command:

```sh
pyric snapshot --out saved-state.json
```

With the host stopped, this reads the hosted database when present. Passwords are
redacted by default. Use `--include-passwords` only when the fixture needs them,
and protect that file. Restore a fixture into an empty hosted store with:

```sh
pyric sandbox --hosted --seed saved-state.json
```

To start empty while preserving the old hosted state:

```sh
pyric sandbox --hosted --fresh
```

The old directory becomes `hosted.archive-<timestamp>-<id>` beside the new store.
In Vite, `fresh: true` does the same on each server start; remove it after use.
Archives retain damaged databases and their sidecars even when they cannot be
checkpointed. Never copy just `state.sqlite` from a running host: recent commits
may still be in its WAL file.

## Recover a damaged store

1. Stop every host for this project. Preserve the complete hosted directory.
2. Run recovery into a directory that does not exist:

   ```sh
   pyric sandbox salvage --source .pyric/state/hosted --out .pyric/state/recovered
   ```

3. Read `.pyric/state/recovered/recovery-report.json`. It lists recovered counts
   and excluded records. Exclusions can leave incomplete application data.
4. If the recovered copy is acceptable, keep the original and activate the copy:

   ```sh
   mv .pyric/state/hosted .pyric/state/hosted-before-repair
   mv .pyric/state/recovered .pyric/state/hosted
   ```

   Choose another archive name if `hosted-before-repair` already exists.
5. Restart the host and reload the app and Studio. Verify the affected records
   and files before continuing work.

Recovery operates on a copy and never activates it automatically. It refuses
unsupported formats, existing output directories, and an empty recovery result.
Some physical SQLite corruption cannot be recovered by this command. A failure
preserves the original; it does not silently create an empty replacement.
