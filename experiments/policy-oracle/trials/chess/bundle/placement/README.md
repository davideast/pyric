# Checking enforcement placement

The capture controller uses this gate before activating a ruleset. It resolves each named chess requirement against the selected profile, authenticates the linked rules bytes against the bundle manifest and, for the referee, verifies the board and match module digests against an independently retained release lock. The referee build also loads both locked modules in Node and checks their callable interfaces.

```sh
python3 check.py referee ../artifacts/referee.rules /path/to/chess.mjs /path/to/chess-match.mjs /path/to/release-lock.json
python3 check.py stronger ../artifacts/stronger.rules - - -
python3 test_check.py
```

The lock is a JSON object with lowercase SHA-256 strings under `board` and `match`. A referee build always requires complete placement. Use `--require-complete` to apply the same requirement to another profile. The error names the obligations still needing standalone enforcement.

`firestore-rules` identifies a predicate in the linked rules. A qualified module export such as `board.outcome` identifies the game logic the referee invokes. `referee-auth` and `referee-persistence` identify the trusted request identity check and the stored-state projection or version-conditioned commit. The table names each obligation's principal enforcing boundary. For example, `board.outcome` derives checkmate and `match.metadata` encodes the winning seat. Stock and compatibility use the same storage protocol. Stronger adds board checks. Referee keeps the database lobby and rematch protocol, restricts direct player moves, and derives each accepted move through the locked policies.

This gate establishes artifact identity and placement. The separate hosted receipts, independent chess reference, and browser replay establish observed behavior. A sampled rule verdict covers its named case.
