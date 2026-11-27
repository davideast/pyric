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
node live/upload.mjs "$RULES_SHA" "$PRIVATE_ARCHIVE"
node live/run.mjs capture "$RULES_SHA" sliding-part-1 "$PRIVATE_ARCHIVE"
node live/run.mjs retain "$RULES_SHA" sliding-part-1 "$PRIVATE_ARCHIVE" "$PART_1_RECEIPT"
node live/run.mjs capture "$RULES_SHA" sliding-part-2 "$PRIVATE_ARCHIVE"
node live/run.mjs retain "$RULES_SHA" sliding-part-2 "$PRIVATE_ARCHIVE" "$PART_2_RECEIPT"
```

The first window has 120 proposals and the second has 118. Each opens with at least 44 minutes of valid management credentials. The controller requests graceful termination twelve minutes before expiry to leave time for restoration. The later window reuses the immutable first ruleset after verifying its remote source, target attachment and prior closure. Both windows check the open/closed controls via authenticated clients, read back each complete match, restore the exact original deny-all release and release only their own versioned lease. A failed or interrupted window contributes zero rows. [Underlying journal qualification](../../for-of/live/evidence.mjs)

The upload command creates an immutable ruleset before the first signed window and reads back its exact source. It checks the deny-all release version and lease before and after the upload. The archive records the create intent before transmission to prevent a second POST after an ambiguous response. A receipt records the Google HTTP status independently of any later activation or signed observation. [Google Rules creation API](https://firebase.google.com/docs/reference/rules/rest/v1/projects.rulesets/create)

For a read-only official source check, run `node live/diagnostic.mjs "$RULES_SHA" /path/to/complete.rules "$PRIVATE_ARCHIVE"`. The Google Rules Test API receives the entire byte-bound source and one synthetic signed-out read. Its response and request hashes go under the release digest in `live/diagnostics`. Lookup returns these in `compileDiagnostics` separately from signed game outcomes. Archive-backed replay authenticates the complete request and response.

Append `--source-only` to omit the synthetic test and submit only the source to the same endpoint. The corresponding receipt carries `mode: "source-only"`. A `service-error` records an unsuccessful API request and leaves compiler acceptance unresolved. [Google Rules Test API](https://firebase.google.com/docs/reference/rules/rest/v1/projects/test)

## Source diagnostic controls

These were separate Google static tests for the complete v11 dense source `2e5c799f…`. Run `node live/isolate.mjs COMPLETE_FILE BASE_SHA FUNCTION_NAME OUTPUT_FILE` to retain the original function body under an unused name and substitute a predicate returning false. All four resulting sources are larger than the original. Each distinct source has an archived request and response in the digest-indexed diagnostics directory.

| Function disabled | Source prefix | HTTP response |
| --- | --- | --- |
| Original source | `2e5c799f` | 503 |
| `chessMove` | `802bb612` | 503 |
| `boardTransition` | `0f0f339b` | 503 |
| `orderedSliderTransition` | `d20c29cd` | 503 |
| `sliderStatus` | `69a421df` | 200, compiled |
| `slideTypedw,slideTypedb` | `81320490` | 503 |
| `slideKingw,slideKingb` | `23f5c895` | 503 |
| `slideChooseq,slideChooseb` (rook route) | `6cd302dc` | 503 |
| `slideChooser,slideChooseq` (bishop route) | `b9d87e5b` | 503 |
| `slideChooser,slideChooseb` (queen route) | `70f678b3` | 503 |

The earlier v2 control `30694279…` passed the same source test again. Inserting `// Current compile-control observation for the sliding replies trial.` after its first source line produced the previously unseen digest `40a78a9b…`, which also compiled. The observations point to a dependence on the solver's structure. Google reported only UNAVAILABLE for the failed calls, so the service's internal limit is unknown.

The v12 source `5ba5838e…` shares four ray projection bodies across all three piece families. It returned HTTP 200 on the same Google source test. Its complete request and response are pinned by `1401e370…`. The signed game outcome count at this diagnostic stage was zero.
