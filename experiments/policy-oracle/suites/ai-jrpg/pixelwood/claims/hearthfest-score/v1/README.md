# Hearthfest contribution scoring

For each fixture the standalone Pyric policy receives the cycle’s call lines, the saved count for each requested item (zero when absent), all raw counts, and the cycle’s benefit menu. Including off-call counts preserves the game's distinction between an empty contribution and a positive donation that earns zero points. The adapter joins item keys. Pyric computes the base, coverage, number of distinct requested items supplied, overshoot, total, tier and selected benefit.

Cycle 7 requests four pumpkins, two iron, two corn seeds and two pumpkin seeds. Four pumpkins and a mix of two pumpkins and two iron both fill four units. They earn 7 and 10 points. Six, eight and ten pumpkins earn 8, 9 and 9 points. Supplying fourteen pumpkins and twelve iron earns two overshoot points on *each* line. The ordinary deposit UI limits over-offers. These cases exercise the scorer directly on stored contribution maps.

The input domain exercised here is integer inventory counts. The policy bounds a call at 32 lines and a contribution at 128 counts. The benefit menu comes from the pinned cycle configuration. Attendance gold, award persistence and inventory delivery have their own inputs.

## Repeat the comparison

Under `probes/contributions/v1`, run `node capture.mjs /path/to/ai-jrpg` to reproduce the committed catalogs and native answers from the pinned Git objects. The replay passes only the fixture inputs and catalogs to the packed Pyric policy. The primary mutation removes the three-point variety bonus. A second mutation raises the overshoot cap to three for six or more extra units.

The sibling `hearthfest-award-write` claim records the live permissions for one award using the same cycle and contributions as `four-on-two`.
