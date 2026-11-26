import { row } from './section.ts';

export default row({
  order: 25,
  featureKeys: ['maximum', 'minimum'],
  status: 'unverified',
  automation: 'unverified',
  behavior:
    '`maximum(n)` and `minimum(n)` (and `FieldValue.maximum` / `FieldValue.minimum`) atomically clamp a numeric field to the larger or smaller of the existing numeric value and `n`; missing or non-numeric priors overwrite with `n`, `NaN` operand or prior yields `NaN`, equal numeric values preserve the prior representation (`-0` vs `+0`, int64 vs float), and array/query/`arrayUnion` placement rejects with `invalid-argument`',
  evidence:
    '`unit:maximum-minimum-sentinels.test.ts`, `unit:firestore-fieldvalue-and-plumbing.test.ts`, `unit:firestore-maximum-minimum.test.ts` -- verified against upstream `@firebase/firestore@4.20.0` (`NumericMaximumFieldValueImpl` / `NumericMinimumFieldValueImpl` and `transform_operation.ts`) across in-page, SharedWorker, and registered Node planes; awaiting live production capture (`firestore-real` / `oracle-run`) to flip to `conforms`',
  risk: ['specific-field', 'sentinel', 'atomicity', 'error-code'],
  riskScore: 8,
  riskReasons: [
    'asserts a specific field/property value',
    'asserts sentinel or atomic transform semantics',
    'asserts transaction/batch atomicity',
    'asserts Firebase error code(s): `invalid-argument`',
  ],
  conformanceTests: [
    'packages/pyric/test/firestore/maximum-minimum-sentinels.test.ts',
    'packages/cli/test/serve/worker/client/firestore-fieldvalue-and-plumbing.test.ts',
    'packages/cli/test/register/firestore-maximum-minimum.test.ts',
  ],
});
