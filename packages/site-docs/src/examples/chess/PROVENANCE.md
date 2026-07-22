# Chess showcase provenance

- Source: `firebase-agent-sdk/examples/chess/chess-v2.rules`, adapted to import Pyric's `auth`, `geometry`, `state`, and `turns` Standard Library modules
- Source config: `firebase-agent-sdk/examples/chess/chess-v2-config.json`
- Production observation: chess v1 passed all 17 scenarios after the unique `moveType` gates were introduced. The rebuilt v2 artifact was then deployed and its knight-move and pin-detection cases passed against Firestore on the first attempt.
- Original Rules SHA-256: `45aea8a5ef6548dbfc56392214c4d86867543c840f52f281b92359fc5956937f`
- Config SHA-256: `d142ae08855591a539899bc6c649f83d22cb7f20cd58d25ef61f1b92fd82f5bf`

The committed site test replays the move and resignation scenarios through the resolved modular Rules. The original checkmate branch accepted any check as checkmate, so this adaptation removes that branch. The example now detects checkmate from the committed board by proving that the checked player has no legal reply. This does not turn the broader v1 run or the two v2 production checks into a new conformance claim; it records exactly which evidence belongs to each artifact.
