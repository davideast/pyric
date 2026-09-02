import type { ToolRecord } from '../tool-records.js';
export default {
  name: 'sandbox',
  order: 30,
  description:
    'Connected sandbox diagnostics: rules source, lint summary, document census, and recent requests and denials in one call.',
  ops: {
    inspect: { transport: 'forwarded', factory: 'firestore-inspect', handler: 'sandbox_inspect' },
  },
} as const satisfies ToolRecord;
