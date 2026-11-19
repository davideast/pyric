import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ["ref","parent","root"],
  behavior: "`ref(db, path)` returns a tagged `DatabaseReference` carrying `key`, `parent`, `root`, and `toString()`, and synchronously rejects paths containing `.`, `#`, `$`, `[`, or `]` with Firebase's captured error shape",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-reference-shape-url`; sandbox row assertion `rtdb-modular#100` replays navigation and every forbidden path character.",
  risk: ["specific-value","validation-timing"],
  riskScore: 3,
  riskReasons: ["asserts 1 specific value(s)","asserts synchronous validation phase"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-reference-shape-url"],
  conformanceTests: ["packages/pyric/test/database/modular/oracle-conformance-reference-writes.test.ts"],
  conformanceChecks: [{
    finding: "RTDB-100",
    observation: "rtdb-modular-reference-shape-url",
    expect: { repeatCount: 2, terminal: { parent: { child: { ok: true } } } },
    probe: "packages/pyric/test/database/modular/oracle-conformance-reference-writes.test.ts",
    guards: "Nested references retain Firebase key, parent, root, and URL shapes.",
  }],
  aliases: ["rtdb#100"],
});
