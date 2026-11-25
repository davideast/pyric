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
