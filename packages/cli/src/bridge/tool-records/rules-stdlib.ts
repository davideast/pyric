import type { ToolRecord } from '../tool-records.js';
export default {
  name: 'rules_stdlib',
  order: 70,
  description:
    'Firebase Security Rules standard library for Firestore and Cloud Storage: list the modules a service can import and get one module with its signatures, examples, and import line.',
  ops: {
    list: { transport: 'in-process', factory: 'firestore-rules', handler: 'rules_stdlib_list' },
    get: { transport: 'in-process', factory: 'firestore-rules', handler: 'rules_stdlib_get' },
  },
} as const satisfies ToolRecord;
