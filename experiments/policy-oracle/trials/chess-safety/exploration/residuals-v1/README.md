# What the remaining mismatches require

On the selected release, 223 of 15,905 SDK-shaped local writes incorrectly passed. Four more were legal promotions refused at the local expression budget. A second run reproduced the ordered decision and cost digest of every cohort, then computed the complete native reply list for each premature terminal declaration. All 227 failed requests were distinct after comparing the path, actor, old document and submitted document. [Release-specific census](selected.json)

| Unmet requirement | Distinct writes |
| --- | ---: |
| Reject continued play after checkmate | 76 |
| Reject continued play after stalemate | 38 |
| Reject a win when a legal reply exists | 100 |
| Reject a draw when a legal reply exists | 9 |
| Admit a legal move within the evaluation budget | 4 |

A sliding piece has a legal reply in 105 of the 109 premature wins or draws. On 47 boards every reply is a bishop move, on 38 every reply is a rook move, and on 18 every reply is a queen move. Two more admit a slider and another family. The other four require a knight. This measures the frozen corpus. The 114 incorrect claims of continued play pose the converse question of proving that *no* legal reply exists. [Frozen four-piece experiment](../rook-interposition-v1/controls/native.json)

Run `bun exploration/residuals-v1/measure.mjs INSTALLED_REFERENCE COMPLETE_RULES DISCOVERY_SUMMARY` to reproduce this classification for a given release. The main replay runs it automatically. The reference summary contains the original independent decision digests and outcomes. A mismatch in either stops the analysis.
