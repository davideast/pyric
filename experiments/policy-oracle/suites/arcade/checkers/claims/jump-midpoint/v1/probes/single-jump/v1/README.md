# Checkers single-jump midpoint

The [fixture](fixture.json) records six legal plies from the opening position. Light's last move jumps from `h6` to `f4` over `g5`. Dark is now on turn. The dark man on `g3` can jump to empty `e5` over the light man on `f4`. Another light man occupies `d4`. Both proposals use Checkers' native `moveUpdate` payload with the same endpoints, prior board, next turn, move count, status, and winner.

The `capture-f4` update removes `f4` and the `capture-d4` update removes `d4`. Each removes the square it names so the board-diff guard admits both sets of changed squares. Both captures have rank 4, halfway from 3 to 5. Only file `f` is halfway between `g` and `e`. This holds the rank-midpoint predicate fixed and isolates the file-midpoint comparison.

The local runner evaluates the complete stock Firestore bundle from Arcade `66e14d4f4b0aeab22c05db8d748704dde053d2e5`. Stock allows `capture-f4` and denies `capture-d4`. The mutation removes only the file-midpoint comparison and allows both.

For live capture, seed distinct `checkers/oracle-<runId>-<caseId>` documents with the authenticated writer as host and the authenticated reader as guest. The writer reads the seed and attempts the update in a client SDK transaction. For `capture-f4` the expected server snapshot shows dark on `e5`, empty `g3` and `f4`, intact `d4`, light on turn and move count 7. For `capture-d4` it shows the complete seed at its original server version. Use the [SDK capture hook and receipt verifier](../../../../../../../../../adapters/arcade-sdk/v1/README.md).

The claim awaits verified live capture. It covers the midpoint of this single jump.
