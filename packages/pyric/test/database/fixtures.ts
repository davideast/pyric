import type { RtdbDataTransport } from '../../src/database/data/transport.js';

const unsupported = async (): Promise<never> => {
  throw new Error('This test host does not perform RTDB data operations');
};

export const UNSUPPORTED_DATA_TRANSPORT: RtdbDataTransport = {
  get: unsupported,
  set: unsupported,
  update: unsupported,
  push: unsupported,
  remove: unsupported,
};
