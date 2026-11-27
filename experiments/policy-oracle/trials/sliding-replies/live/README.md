# Sliding-reply production observations

The two capture windows contain 238 distinct submitted match updates. Six rook inputs reuse their original IDs and signed operands among the 190 historical cases. The 18 bishop and 30 queen inputs come from the versioned native fixture directories. The capture reads their positions and proposed claims. Native answers and candidate predictions are separate. The first window contains all 54 focus cases. [Frozen positions](../native/)

From the sliding-replies trial directory, look up the exact SHA-256 of a complete ruleset.

```sh
bun --no-install live/run.mjs lookup "$RULES_SHA"
```

Lookup returns the expected and measured counts, qualified receipt hashes and one decision per case, including the server version on either side of the write. The public compressed receipts include both complete signed reads, server versions, and submitted fields. An unknown digest yields `unmeasured`. A digest with a completed subset yields `partial`. A digest becomes `measured` after all 238 distinct IDs have qualifying observations. Use `--archive /absolute/path/to/captures` to authenticate the original controller journal offline. The previous `5365dc51…` release has 190 measured cases in this corpus before any new deployment. Each of its 190 normalized signed inputs is compared with the complete operands of the new run.

## Controller

Use the SDK installed from Arcade’s live package lock. `node live/preflight.mjs` checks the target UID, the original deny-all source and current release, the absence of an active lease, and the validity of the actual management credential. A capture obtains fresh temporary signed SDK identities for each window. Check the compiled rules and their digest before preparing the capture plan.

```sh
node live/run.mjs prepare "$RULES_SHA" /absolute/path/to/complete.rules
node live/run.mjs capture "$RULES_SHA" sliding-part-1 "$PRIVATE_ARCHIVE"
node live/run.mjs retain "$RULES_SHA" sliding-part-1 "$PRIVATE_ARCHIVE" "$PART_1_RECEIPT"
node live/run.mjs capture "$RULES_SHA" sliding-part-2 "$PRIVATE_ARCHIVE"
node live/run.mjs retain "$RULES_SHA" sliding-part-2 "$PRIVATE_ARCHIVE" "$PART_2_RECEIPT"
```

The first window has 120 proposals and the second has 118. Each opens with at least 44 minutes of valid management credentials. The controller requests graceful termination twelve minutes before expiry to leave time for restoration. The later window reuses the immutable first ruleset after verifying its remote source, target attachment and prior closure. Both windows check the open/closed controls via authenticated clients, read back each complete match, restore the exact original deny-all release and release only their own versioned lease. A failed or interrupted window contributes zero rows. [Underlying journal qualification](../../for-of/live/evidence.mjs)
