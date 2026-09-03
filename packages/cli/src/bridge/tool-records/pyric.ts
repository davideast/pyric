import type { ToolRecord } from '../tool-records.js';
export default {
  name: 'pyric',
  order: 90,
  description:
    'Pyric conformance queries and session verification: whether a Firebase feature is available, how faithfully it behaves, whether it is eligible for assurance, and whether a captured session still passes under candidate rules.',
  ops: {
    can_i_use: { transport: 'in-process', factory: 'conformance', handler: 'pyric_can_i_use' },
    verify: { transport: 'in-process', factory: 'verify', handler: 'pyric_verify_fixture' },
    verify_cases: {
      transport: 'in-process',
      factory: 'verify',
      handler: 'pyric_derive_rules_test_cases',
    },
  },
} as const satisfies ToolRecord;
