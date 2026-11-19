import { row } from './section.ts';

export default row({
  order: 40,
  featureKeys: ["validatePassword"],
  api: "validatePassword(auth, password)",
  behavior: "Returns a `PasswordValidationStatus` against the project's password policy, WITHOUT attempting a sign-up (so a UI can show live strength feedback). The sandbox's policy is `minPasswordLength: 6`, `maxPasswordLength: 4096`, `enforcementState: 'ENFORCE'`, with every character-class requirement UNSET — so a password this function calls valid is exactly one `createUserWithEmailAndPassword` will accept. The character-class fields are `undefined`, not `false`: upstream distinguishes 'not required' from 'required and unmet', and reporting `false` would claim the password failed a rule the project never had.",
  status: "conforms",
  evidence: "ORACLE-BACKED: `auth-validatepassword-status-shape` captured prod's live policy (minPasswordLength 6, maxPasswordLength 4096, ENFORCE, character classes unset) and the status shape for a weak and a strong password. Replayed in `unit:oracle-conformance.test.ts`. The 6-char minimum agrees with the separately oracle-pinned `auth/weak-password` threshold on the create path, so the two surfaces draw the same line here exactly as they do in prod.",
  risk: ["specific-value","specific-field"],
  riskScore: 5,
  riskReasons: ["asserts the policy's min/max length","asserts character-class requirements are UNSET rather than false"],
  automation: "oracle-backed",
  oracleObservations: ["auth-validatepassword-status-shape"],
  conformanceTests: ["packages/pyric/test/auth/oracle-conformance.test.ts"],
});
