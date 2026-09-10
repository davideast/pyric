import type { EvalTask } from '../types.js';

const ARCHIVE_BYTES = 'UEsDBAo=';

const task: EvalTask = {
  id: 'tag-the-archive-with-its-owner',
  prompt:
    'Our retention job reads an owner tag off each object and archives/q3.zip has none. Tag it with owner dana_acme. Do not re-upload it, the bytes are what they should be.',
  seed: {
    storage: [
      { path: 'archives/q3.zip', contentBase64: ARCHIVE_BYTES, contentType: 'application/zip' },
    ],
  },
  acceptedFirstOperations: ['update_storage_metadata'],
  assert: (state) => {
    const stored = state.storage.get('archives/q3.zip');
    if (!stored) return 'archives/q3.zip is no longer stored';
    if (stored.metadata.owner !== 'dana_acme') return 'the owner tag is not dana_acme';
    if (stored.size !== Buffer.from(ARCHIVE_BYTES, 'base64').byteLength) {
      return 'the object was re-uploaded rather than tagged';
    }
    if (stored.contentType !== 'application/zip') return 'the content type was lost';
    return true;
  },
  tags: ['storage', 'write'],
};

export default task;
