# Pixelwood chat sends

One authenticated sender exercised the app rules at AI-JRPG revision `b3bed5e36acaa7bfc47a600e86e015fb84b1ac70`. Each send first merged `lastChatAt: serverTimestamp()` into the sender’s ledger. A successful stamp triggered the message creation. The harness reserved a fresh message ID so the independent reader could read the intended document even after a refusal. The three profile comparisons started with an absent ledger. The two timing cases continued from the named sender’s first send. [Pinned rules](../../world-role/v1/probes/app-and-mirror/v1/app.rules)

| Send | Ledger | Message | Readback |
|---|---|---|---|
| No profile, generated guest name | ALLOW | ALLOW | New stamp and a message from `wanderer-lqA3` |
| Mechanics-only profile, same guest name | ALLOW | DENY | New stamp, message absent |
| Named profile, matching name | ALLOW | ALLOW | New stamp and a message from `Oracle player` |
| Immediate repeat | DENY | Not submitted | Previous stamp and document version preserved, new message absent |
| After cooldown | ALLOW | ALLOW | Stamp advanced by 1,716 ms, new named message present |

A mechanics-only profile exists and has no `name` field. The profile lookup therefore selects the named-profile branch. The first write in that send committed before the message was refused. Each send includes signed SDK and independent REST readbacks of ledger, reserved message, and profile before the gate, after the gate, and after the send. [Full production receipt](probes/profile-and-rate/v1/evidence/c6e2df9e-a3c5-4948-925d-f70bcde41fe5.json)

The refused update produced no server timestamp. Firestore’s ledger read times before and after the attempted update bound it to 222.834–330.831 ms after the preceding stamp. The packed-engine replay exercises both outward-rounded endpoints. The accepted later update’s field gives the exact 1,716 ms interval. A separate Pyric SDK check uses a fresh fixed clock for each of 1,499, 1,500 and 1,501 ms. Only the last passes. Exact equality is a standalone check. [Replay time inputs](probes/profile-and-rate/v1/timing.json)

## Reproduce

From the experiment worktree, supply the independent controller archive. Scoring treats each send as one case with two stage outcomes. A message skipped after a refused gate has its own outcome, `NOT_SUBMITTED`. The negative control holds the clock inside the cooldown during the recovery send.

```sh
oracle=experiments/policy-oracle
node "$oracle/arcade/live/controller/pixelwood-chat.mjs" "$archive"
bun "$oracle/adapters/pixelwood-chat/v1/import-reviewed.mjs" "$archive" "$run_id"
python3 "$oracle/core/oracle.py" --candidate-package "$oracle/arcade/vendor/pyric-rules-0.1.0.tgz" --trusted-captures "$archive" --upstream-pyric .
bun "$oracle/adapters/pixelwood-chat/v1/sandbox-replay.mjs" "$project/package.json" "$receipt"
```
