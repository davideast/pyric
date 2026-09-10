import type { EvalTask } from '../types.js';

const CSV_BYTES = 'bmFtZSx0b3RhbAphbGljZSwxMAo=';

const task: EvalTask = {
  id: 'fix-the-content-type-on-the-export',
  prompt:
    'exports/2026-09/summary.csv went up as application/octet-stream and the browser downloads it instead of showing it. Set it to text/csv without touching the file itself.',
  seed: {
    storage: [
      {
        path: 'exports/2026-09/summary.csv',
        contentBase64: CSV_BYTES,
        contentType: 'application/octet-stream',
      },
    ],
  },
  acceptedFirstOperations: ['update_storage_metadata'],
  assert: (state) => {
    const stored = state.storage.get('exports/2026-09/summary.csv');
    if (!stored) return 'exports/2026-09/summary.csv is no longer stored';
    if (stored.contentType !== 'text/csv') {
      return `the content type is ${String(stored.contentType)}, not text/csv`;
    }
    // Reuploading would have reached the same content type through different
    // bytes, which is the outcome the task asked against.
    if (stored.size !== Buffer.from(CSV_BYTES, 'base64').byteLength) {
      return 'the object was rewritten rather than retagged';
    }
    return true;
  },
  tags: ['storage', 'write'],
};

export default task;
