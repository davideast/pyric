# Capturing the Arcade game probes

One operator runs the stock capture on the isolated named database pinned in the Arcade manifest. The stock command exercises two cases each for Yacht, Sokoban and Checkers. It uses the anonymous Firebase JS clients and the same exclusive release lease as the original counter capture.

From the worktree root, check the frozen inputs, install the pinned live SDK and select an existing operator-owned private archive outside any Git checkout. Keep this directory across captures.

```sh
node experiments/policy-oracle/arcade/live/controller/stock.mjs check-inputs
npm ci --prefix experiments/policy-oracle/arcade/live --ignore-scripts --no-audit --no-fund
node experiments/policy-oracle/arcade/live/controller/stock.mjs capture "$archive"
```

The capture prints its private run directory. Each state of an attempt has a separate journal entry. Each completed probe also has a content-addressed receipt at the archive root. The controller checks the deployed rules digest, database UID and lease before and after each scored write. Independent signed tic-tac-toe writes and reads establish propagation. It verifies both read denial and write denial after restoring the previous release. A changed release owner or failed restoration verification leaves the lease for operator inspection. An interrupt requests an orderly stop after the current operation. A force-killed process can leave an open release and lease. Inspect the active release, lock identity, version and journal before recovery.

After reviewing the signed controls, scored writes, server snapshots, versions and restoration journal, import the completed run into the candidate checkout. The import requires the immutable completion record created after restoration, lease release and client cleanup.

```sh
node experiments/policy-oracle/arcade/live/controller/stock.mjs import-reviewed "$archive" "$run_id"
python3 experiments/policy-oracle/core/oracle.py --trusted-captures "$archive"
```

The import preserves the observed verdict when it differs from a fixture prediction. The raw records include synthetic UIDs and test game state. The journal stores selected identity claims. Credentials and web app configuration stay in process memory.

## Candidate captures

After locking the reviewed candidate and its digest, run one command per complete bundle. Each command owns a separate lease and restores the deny-all release. The candidate receipts identify the candidate digest and contain the signed operation, readbacks and server versions for each case.

```sh
node experiments/policy-oracle/arcade/live/controller/candidate.mjs sokoban "$archive" "$bundle" "$bundle_sha256"
node experiments/policy-oracle/arcade/live/controller/candidate.mjs floor "$archive" "$bundle" "$bundle_sha256" "$floor_recipe" "$recipe_sha256"
```

Sokoban uses the frozen two score writes and two independent owners. Its propagation controls require the stock tic-tac-toe rules in the complete candidate bundle. Floor uses the supplied pinned `steps` fixture with the two timer proposals. Its controls send the known-valid update as the writer and as the reader on separate seeded documents. The scored observations use fresh documents and the named writer. Each invocation prints the receipt digest after cleanup.

For a scored candidate write, the controller journals the first privileged post-write document, then reads it with the same signed reader. A temporary permission denial, unavailable response or deadline during this read allows up to six signed attempts, five seconds apart. Each attempt records its response and rechecks the database UID, active release and lease. An unreadable document leaves the capture incomplete. A successful read must match the privileged fields and version observed across the readback interval.

Yacht uses the same candidate command with mode `yacht` and the digest of the complete linked Arcade bundle. Its authenticated transactions read the seeded match before submitting an update. Each observation retains the proposed changes, full match readbacks and server versions.
