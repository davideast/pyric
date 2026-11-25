# From pilot coverage to a compiler repair

The archived pilot had 50 decisions and six pending Arcade cases. The complete stock Arcade rules ran on the isolated production database `digame-mas/arcade-counter-261125-5cbab1e4`. The three new claims each produced a positive and a negative signed Firebase JS SDK 12.19.0 write. Every allowed write advanced the server version. Every refused write preserved the whole document and its version.

| Stock game | Accepted | Refused |
|---|---|---|
| Yacht | Five equal dice scored at 50 | Same dice scored at 49 |
| Sokoban | 40 moves and 9 pushes over 40/10 | 40 moves and 10 pushes over 40/10 |
| Checkers | g3 to e5 names f4 as the captured square | The same jump names d4 |

The accepted stock receipts now score 56 cases across 10 claims when the independent controller archive is available. The total combines authenticated production decisions, archived service observations and native game contracts. The six new production decisions are the increase from 50 to 56. The old pilot report records the earlier run. [New receipt pins](../baselines/arcade-stock-89219c79.json) · [Package scorer](../CANDIDATES.md)

## The blind repair

The supervisor seeded an off-by-one error in the compiler's lowering of strict less-than. The starting tarball passed 56/56 on the broad corpus. Its emitted Sokoban helper failed one of two public Firebase cases and one of 19 held-out cases. That gap matters for future work. Comparing a package's simulator against stock rules measures a different capability from compiling a policy into correct rules.

A fresh author received the compiler, public policy and failing case at 6:16:08 p.m. ET on November 25. Their first submitted revision locked at 6:17:27 p.m., 79 seconds later. It passed 2/2 public cases and 19/19 sealed cases with zero regressions on either suite. Its general package score was 56/56. The 19 sealed answers came from the native game and its complete stock rules. Production also checked the two public writes against the exact repaired bundle. The 56, 2 and 19 exercise different paths and overlap.

The generated bundle accepted the 40/9 write and stored 9 pushes. It refused the 40/10 tie and left 10 pushes stored. One earlier activation received HTTP 503. A second run returned a successful write followed by a refused signed read. Both runs restored the original release. Their journals are retained as incomplete attempts. The completed run sent each scored write once, and independent signed server reads agreed with the Firestore REST documents. [Public policy and repair trial](sokoban-repair/v1/README.md) · [Per-case held-out results](sokoban-repair/v1/held-out-report.json) · [Production receipt](sokoban-repair/v1/firestore-receipt.json)

## Mixed execution on Floor is Lava

The native game and independent TypeScript replay both ran from the recorded controls. On step 304 of seed 7, the replay supplied a sweep and 16 candidate platforms. Standalone Pyric selected boost pad 2 and calculated 44 ms. The trusted document contained that contact and the previous timer. On two identically seeded documents, authenticated Firestore accepted 44 ms and stored it. It refused 60 ms and left the previous 0 ms and server version unchanged. The locked Sokoban compiler package also regenerated the deployed timer rules byte for byte.

The cloud placement enforces the reported timer, writer identity and allowed update field. Landing selection, support and boost-event validation remain standalone. The production capture covers this contact and these two proposals. [Native fixture and generated placement](floor-boost/v1/README.md) · [Production timer receipt](floor-boost/v1/firestore-receipt.json)

## Reproduce offline

The separate controller archive retains all successful and interrupted journals, authenticated readbacks and restoration controls. Each completed run observed the original deny-all release again before releasing its lease. The local state directory holds the two exact submitted packages and a self-contained archive for replaying the held-out native routes.

```sh
state="$HOME/.local/state/pyric/oracle/2026-11-25-89219c79"
oracle=experiments/policy-oracle
python3 "$oracle/core/oracle.py" --candidate-package "$state/packages/locked.tgz" --trusted-captures "$state/captures"
python3 "$oracle/trials/sokoban-repair/v1/score.py" --candidate-package "$state/packages/locked.tgz" --trusted-captures "$state/captures" --compare-rules "$oracle/trials/sokoban-repair/v1/repaired.rules"
node "$oracle/trials/verify-live.mjs" "$state/captures"
```

Swap in `starting.tgz` and omit `--compare-rules` to see the two named false denials in the Sokoban trial. The established broad cases still pass on that same tarball. [Starting broad score](sokoban-repair/v1/broad-starting.json) · [Locked broad score](sokoban-repair/v1/broad-locked.json) · [Deployment and receipt pins](release-evidence.json)
