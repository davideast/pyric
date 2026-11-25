# Yacht scoring after five equal dice

[Fixture](fixture.json) fixes a two-seat game on seat 0's turn after one reveal. Its five fours are consistent with the recorded salt, nonce and keep mask. Seat 0 has 12 points from choice, seat 1 has 4 from ones, and Yacht is unused. Both submissions advance the turn, reset the roll count, and score the same category with the complete update mask used by the game. Score 50 proposes a new total of 62. Score 49 proposes 61. The unchanged seat and all other state agree across the two submissions.

The local runner evaluates Arcade's complete stock Firestore bundle from `66e14d4f4b0aeab22c05db8d748704dde053d2e5`. It replaces only the Yacht value of 50 with 49 for the control. The stock bundle allows 50 and denies 49. The control reverses both results.

For an SDK capture, seed each proposal's own `yacht/oracle-<runId>-<caseId>` document, substituting the two anonymous UIDs for the players. In the authenticated transaction, read that exact seed and update the game with the proposed score. The observing client is seat 1. It reads the complete document from the server after each attempt. For `score-50` the hypothesized readback has seat 0's Yacht score 50, total 62, turn 1, rolls 0 and move count 3. For `score-49` the hypothesized readback is the full seed with the original server version. See the [SDK capture hook](../../../../../../../../../adapters/arcade-sdk/v1/README.md).

The fixture starts after the reveal. The obligation is still awaiting a live stock-rules SDK capture.
