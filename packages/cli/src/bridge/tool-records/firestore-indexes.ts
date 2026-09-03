import type { ToolRecord } from '../tool-records.js';
export default {
  name: 'firestore_indexes',
  order: 65,
  description:
    'Firestore composite-index generation that runs in the MCP process without a sandbox: statically extract index requirements from query source.',
  ops: {
    generate: {
      transport: 'in-process',
      factory: 'firestore-indexes',
      handler: 'firestore_extract_indexes',
    },
  },
} as const satisfies ToolRecord;
