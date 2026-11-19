import { row } from './section.ts';

export default row({
  order: 150,
  behavior: "Strict boolean control flow matches production: non-booleans in `&&`, `||`, or a ternary condition error and deny. Firestore double payloads retain float identity in the simulator (fractional JSON numbers are revived directly; `{ __type:'float', value }` preserves an explicitly tagged double). On create, `resource == null` denies while `request.resource` exposes the incoming document.",
  status: "conforms",
  evidence: "Production behavior is recorded by Firestore Rules rows `firestore-rules#188`, `firestore-rules#167`, and `firestore-rules#166`. Direct evaluator/handler tests guard strict operands, fractional-number revival, the explicit float tag, and create-time resource verdicts on the SDK-facing simulator path.",
  risk: ["specific-value","specific-field"],
  riskScore: 3,
  riskReasons: ["asserts 1 specific value(s)","asserts a specific field/property value"],
  automation: "unit-backed",
  conformanceTests: ["packages/rules/test/simulator/evaluator.test.ts","packages/rules/test/simulator/handler.test.ts"],
  rowNumber: 138,
});
