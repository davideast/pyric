# Independent slider review

The witness check asks the frozen evaluator to run the emitted integer-producing function on an independently packed, post-move board. A mailbox square uses file + 10 × (rank − 1), with a1 at zero. A move uses origin × 80 + destination. Each nonnegative result must decode to a move in the native list of legal slider replies. The expected result is −1 exactly when that list is empty. Several legal replies may satisfy this check.

From the sliding-replies trial directory, pass a local installation of the reference `@pyric/rules` package and the complete generated ruleset.

```sh
bun --no-install review/witness.mjs "$PINNED_RULES_SDK" "$COMPLETE_RULES" --focused
bun --no-install review/witness.mjs "$PINNED_RULES_SDK" "$COMPLETE_RULES"
python3 -B review/witness-control.py "$PINNED_RULES_SDK" "$COMPLETE_RULES"
```

The focused audit checks all 18 boards across nine paired tests and runs each of their 54 write proposals through the original complete local ruleset. Its diagnostic matches expose the return value of the helper and its actual material guard. They also verify the input encoding against the candidate’s own board packer. The complete-write traces record which integer-producing function ran, its value, the claim verdict, expression count, and whether a status test short-circuited. Source digests identify both the original release and the diagnostic copy. The malformed-encoding control keeps the sign of every witness and changes its destination by one column.

The larger audit includes 2,232 positions reached by a sliding check and 564 positions reached by a quiet move, knight check or pawn check. The stratified sample and geometric transformations cover both players, corners, board edges, pins, captures and double checks. Check `scopes.guard-true` for the advertised helper path. A value returned by a direct diagnostic call on excluded material can be wrong even though a complete write dispatches to a separate fallback.

To reproduce the independent input freezes using the pinned chess-1.11.2 sdist and Arcade’s native chess implementation, run the following commands.

```sh
python3 -B review/panel/generate.py "$CHESS_SOURCE"
python3 -B review/other-turns/generate.py "$CHESS_SOURCE"
bun --no-install review/panel/arcade.mjs
bun --no-install review/panel/arcade.mjs --other-turns
```

To audit the signed Firestore evidence offline, pass the SHA-256 of a complete ruleset, the private controller capture directory and the pinned chess sdist. The check reconstructs each public record from its private journal, verifies restored-deny controls, and re-adjudicates the signed actor, pre-write document and submitted patch. An allowed write must increase the server version and produce exactly the requested document. A refused write must preserve the complete snapshot, including its server version. The 190 old inputs are compared field-for-field with their archived submissions. For every focused claim, the signed board, successor, complete reply list, claimed status and named winner are also checked against the frozen native answers.

```sh
python3 -B review/signed.py "$RULES_SHA256" "$PRIVATE_ARCHIVE" "$CHESS_SOURCE"
```

The output reports unmeasured, partial or measured tied to the full source digest. The old 190-case release is labeled historical. Independent local witness results and live server observations have separate score fields and denominators.

The material audit computes four eligibility profiles independently from the native successor FEN. The rook profile accepts a sole defending rook. The bishop profile includes a sole rook or bishop and permits one friendly pawn when the opponent has no pawn. The queen profile extends that choice to a queen. The two-defender profile also includes a supported slider and knight, or two rooks, against arbitrary opposing material. Each profile reports included, excluded, omitted and overincluded counts, along with any guard error.

For the 36 focused playing and won proposals, the reviewer additionally runs two diagnostic rulesets that retain the entire write path and replace the observed integer producer with a fixed absence or a fixed presence. A verified claim must match its native outcome in the untouched source, return a legal integer or correct absence on its actual trace, and switch verdict as the diagnostic sign switches. A resource error or an unobservable dependency remains inconclusive. The contradictory draw claims can be refused directly from check.

The roster controls include both colors across seven separately named positions. Two originate in the broad panel. They cover a reply from the second rook alone, replies from two distinct rooks, an exclusive knight evasion with and without a friendly slider, a sole-knight stalemate, a quiet knight-only escape and an excluded extra knight. The `including-sole-knight` profile covers the two-defender roster plus a defending king and lone knight. The full panel output’s `rosterControls` keeps these 42 supplemental writes outside the 238 campaign submissions.

```sh
python3 -B review/roster/generate.py "$CHESS_SOURCE"
bun --no-install review/panel/arcade.mjs --roster
bun --no-install review/witness.mjs "$PINNED_RULES_SDK" "$COMPLETE_RULES" --roster
```
