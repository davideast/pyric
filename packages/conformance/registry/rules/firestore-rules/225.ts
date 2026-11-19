import { row } from './section.ts';

export default row({
  order: 470,
  featureKeys: ["int", "float", "math", "toSet", "diff"],
  behavior: "int64 conversions and limits (`int()` of strings and floats, `math.abs`, `math.round`, `math.floor`, `math.ceil`, overflow, float division and modulo, durations at int64), and an int and a float past 2^53 compared under `==`, in a List, a Map, a Set and a map diff",
  status: "conforms",
  evidence: "`oracle:rules-firestore-int64-conversions-and-mixed-equality` (captured 2026-11-04 by the rules engine defect hunt as `c2-numbers`, 56 cases) records production failing `int()` of a string past int64, with a space, a fraction, hex or an exponent as a type conversion error, saturating `int(float('1e19'))` and mapping `int(float('NaN'))` to 0, returning MIN from `math.abs(MIN)`, failing `MIN * -1` and `-MIN` as out of range, and ALLOWING `9007199254740993 == 9007199254740992.0` while DENYING the same pair in a List, a Map, `in`, `hasAll()`, a Set (`eq7`) and a map diff (`eq8`). The simulator compared an int and a float past 2^53 through a double in a Set and a map diff, so `eq7` and `eq8` allowed (#1893); `setElementsEqual` in `rules/simulator/value-equality.ts` now compares an int against a float's exact value, and `unit:rules/oracle-conformance.test.ts` replays all 56 verdicts with no pin (`unit:sandbox/rules-int-float-sets.test.ts` through `setDoc` and `uploadBytes`).",
  risk: ["rules-denial"],
  riskScore: 3,
  riskReasons: ["asserts that Set membership and affectedKeys() keep an int and a float past 2^53 apart"],
  oracleObservations: ["rules-firestore-int64-conversions-and-mixed-equality"],
  constructs: ["firestore.method.list.toSet", "firestore.method.map.diff"],
});
