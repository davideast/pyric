# Arcade counter v1 results

Production evidence covers **2/2 claims**. The pinned compiler conformed on **2/2 evidenced claims** and the offline replay matched all **21/21** live decisions. The constant-counter mutation matched **9/9** original writes. At count four it matched the four wrong-turn refusals and made four false allows and four false denials.

## All scored writes

Each submission used its own document. The guest fetched the whole match from the server afterwards. The original production SDK was Firebase 12.19.0. Accepted documents matched the complete proposals and advanced their server versions. Refused documents and their update times matched their baselines. The reusable fixtures contain full pre-state, proposal, post-state and server versions. [Nine count-zero readbacks](v1/observations/zero.json) · [Twelve count-four readbacks](v1/observations/four.json)

| Before | Complete ruleset | Actor | Proposed | Production | Stored | Packed replay | Constant mutant |
|---:|---|---|---:|---|---:|---|---|
| 0 | Arcade stock | host | 1 | ALLOW | 1 | ALLOW | ALLOW |
| 0 | Arcade stock | host | 2 | DENY | 0 | DENY | DENY |
| 0 | Arcade stock | guest | 1 | DENY | 0 | DENY | DENY |
| 0 | Generated +1 | host | 1 | ALLOW | 1 | ALLOW | ALLOW |
| 0 | Generated +1 | host | 2 | DENY | 0 | DENY | DENY |
| 0 | Generated +1 | guest | 1 | DENY | 0 | DENY | DENY |
| 0 | Generated +2 | host | 1 | DENY | 0 | DENY | DENY |
| 0 | Generated +2 | host | 2 | ALLOW | 2 | ALLOW | ALLOW |
| 0 | Generated +2 | guest | 2 | DENY | 0 | DENY | DENY |
| 4 | Arcade stock | host | 5 | ALLOW | 5 | ALLOW | DENY |
| 4 | Arcade stock | host | 1 | DENY | 4 | DENY | ALLOW |
| 4 | Arcade stock | guest | 5 | DENY | 4 | DENY | DENY |
| 4 | Generated +1 | host | 5 | ALLOW | 5 | ALLOW | DENY |
| 4 | Generated +1 | host | 1 | DENY | 4 | DENY | ALLOW |
| 4 | Generated +1 | guest | 5 | DENY | 4 | DENY | DENY |
| 4 | Handwritten +2 | host | 6 | ALLOW | 6 | ALLOW | DENY |
| 4 | Handwritten +2 | host | 2 | DENY | 4 | DENY | ALLOW |
| 4 | Handwritten +2 | guest | 6 | DENY | 4 | DENY | DENY |
| 4 | Generated +2 | host | 6 | ALLOW | 6 | ALLOW | DENY |
| 4 | Generated +2 | host | 2 | DENY | 4 | DENY | ALLOW |
| 4 | Generated +2 | guest | 6 | DENY | 4 | DENY | DENY |

## Smallest contrasting pair in the frozen run

Both proposals below use the same legal board and actor. The packed mutant keeps the wrong-turn guard but replaces the counter predicate with a constant. The only difference between the two host proposals is the proposed counter. The role aliases identify the distinct Firebase Auth users in the committed portable corpus.

### First false allow

Case `four/stock/constant`. Production returned **DENY**. The constant-counter candidate returned **ALLOW**.

```json
{
  "role": "host",
  "before": {
    "moveCount": 4,
    "board": {
      "c0r2": "",
      "c1r1": "guest",
      "c2r2": "",
      "c1r0": "guest",
      "c0r0": "host",
      "c0r1": "",
      "c2r0": "",
      "c2r1": "host",
      "c1r2": ""
    },
    "host": "HOST",
    "createdAt": {
      "type": "firestore/timestamp/1.0",
      "seconds": 1735689600,
      "nanoseconds": 0
    },
    "winner": "",
    "status": "playing",
    "guest": "GUEST",
    "currentTurn": "host",
    "lastMove": "c1r0"
  },
  "proposal": {
    "host": "HOST",
    "guest": "GUEST",
    "currentTurn": "guest",
    "status": "playing",
    "winner": "",
    "moveCount": 1,
    "lastMove": "c0r2",
    "board": {
      "c0r0": "host",
      "c1r0": "guest",
      "c2r0": "",
      "c0r1": "",
      "c1r1": "guest",
      "c2r1": "host",
      "c0r2": "host",
      "c1r2": "",
      "c2r2": ""
    },
    "createdAt": {
      "type": "firestore/timestamp/1.0",
      "seconds": 1735689600,
      "nanoseconds": 0
    }
  }
}
```

### First false denial

Case `four/stock/relative`. Production returned **ALLOW**. The constant-counter candidate returned **DENY**.

```json
{
  "role": "host",
  "before": {
    "moveCount": 4,
    "host": "HOST",
    "createdAt": {
      "type": "firestore/timestamp/1.0",
      "seconds": 1735689600,
      "nanoseconds": 0
    },
    "board": {
      "c1r1": "guest",
      "c0r2": "",
      "c1r0": "guest",
      "c2r2": "",
      "c0r0": "host",
      "c2r1": "host",
      "c0r1": "",
      "c2r0": "",
      "c1r2": ""
    },
    "guest": "GUEST",
    "currentTurn": "host",
    "lastMove": "c1r0",
    "winner": "",
    "status": "playing"
  },
  "proposal": {
    "host": "HOST",
    "guest": "GUEST",
    "currentTurn": "guest",
    "status": "playing",
    "winner": "",
    "moveCount": 5,
    "lastMove": "c0r2",
    "board": {
      "c0r0": "host",
      "c1r0": "guest",
      "c2r0": "",
      "c0r1": "",
      "c1r1": "guest",
      "c2r1": "host",
      "c0r2": "host",
      "c1r2": "",
      "c2r2": ""
    },
    "createdAt": {
      "type": "firestore/timestamp/1.0",
      "seconds": 1735689600,
      "nanoseconds": 0
    }
  }
}
```

## An incomplete capture exposed propagation uncertainty

An earlier pass collected ten scored writes with full readbacks. Immediately after their releases, both +2 rules refused the host’s 4 → 6. A subsequent server read failed before the eleventh submission. The controller restored the original deny-all ruleset, verified a signed-in read was refused, released its lock and removed both temporary users. [Ten original outcomes](v1/observations/first-attempt.json)

A successful read alone could not identify which counter the write endpoint enforced. In the completed run, each variant got 65 seconds to propagate, followed by two consecutive independent control pairs starting at zero. One write in each pair had to succeed and the other fail in the order specific to that variant, with full readbacks. All 16 propagation writes were recorded separately. Both +2 variants subsequently accepted 4 → 6. The evidence establishes the two outcomes across runs. The exact rules evaluated by each backend on the earlier refusals are unknown.

## Receipt and bundle hashes

The predictions were frozen at commit `1afc29689`. Normalization verifies role identity before replacing temporary UIDs with stable aliases; raw receipts remain in the local ignored evidence directory. The index holds both normalized and raw hashes. [Integrity index](v1/ledger.json) · [Frozen case and artifact manifest](v1/manifest.json)

| Artifact | SHA-256 |
|---|---|
| zero raw receipt | `60eb41bf431943c938ae14d466ae77b5d08ee8b7406d09b05988b486161d1a83` |
| four raw receipt | `56489a7812ccef8be337004ce959b910db740c5922123f7ae19b856c7fcb6db8` |
| Arcade stock deployed rules | `59b6e23b4727912311ffd45dcba50d4bcb69fe9ed79c6627584e385c338e422b` |
| Generated +1 deployed rules | `b46da6fde674e109b525c1545ae40ebdcddd2ada44be7f621cd44d5c1478b17b` |
| Handwritten +2 deployed rules | `a16252aff8ed6d8685b027f537250cd0019cef1d0125384f636e29d317421277` |
| Generated +2 deployed rules | `4d97b0c7be76b1c840cf590a7bca5ef136e5a04e0d7a419a0f03aa05fb7b61c5` |

The final production read with the original deny-all release returned permission-denied. The two temporary users were deleted. Synthetic documents are retained on the dedicated trial database.
