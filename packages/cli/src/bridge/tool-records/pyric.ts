import type { ToolRecord } from '../tool-records.js';
export default {
  name: 'pyric',
  order: 90,
  description:
    'Pyric conformance queries: whether a Firebase feature is available, how faithfully it behaves, and whether it is eligible for assurance.',
  ops: {
    can_i_use: { transport: 'in-process', factory: 'conformance', handler: 'pyric_can_i_use' },
  },
} as const satisfies ToolRecord;
