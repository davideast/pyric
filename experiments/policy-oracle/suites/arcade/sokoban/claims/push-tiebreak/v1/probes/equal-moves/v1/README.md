# Sokoban scores with equal move counts

[Fixture](fixture.json) fixes level 1 and an existing best of 40 moves and 10 pushes. Both proposals keep 40 moves, use the same new 20-character solve ID and construct its object name from the matching owner, level and counts. The only comparison that changes is the proposed push count, with its matching object suffix. Level 1 requires at least 33 moves and 8 pushes, so both proposals meet the shape and minima.

The local runner evaluates Arcade's complete stock Firestore bundle from `66e14d4f4b0aeab22c05db8d748704dde053d2e5`. It models the SDK timestamp transform at the fixture's pinned request time. The stock bundle allows 40/9 and denies 40/10. The control relaxes strict decrease to non-increase for pushes and allows both.

For an SDK capture, allocate separate anonymous writers and seed each one's `sokoban/1/scores/<uid>` document at 40/10. The owner calls Firestore `setDoc` itself with `serverTimestamp()`, the same write that the game uses after its client-side best-score check. Calling the SDK directly lets the unchanged score reach Firestore despite the game's client-side early return. A second signed-in client reads the complete document from the server. For `pushes-9` the hypothesized readback is the proposed 40/9 with a resolved server timestamp and an advanced server version. For `pushes-10` the hypothesized readback is the full old 40/10 with its original timestamp and version. See the [SDK capture hook](../../../../../../../../../adapters/arcade-sdk/v1/README.md).

The payload includes a Storage object name so Firestore can validate its form. This obligation concerns the Firestore score update and is still awaiting live SDK capture.
