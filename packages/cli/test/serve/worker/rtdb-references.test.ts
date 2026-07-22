/** RTDB worker-client database handles, references, and path validation. */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as client from '../../../src/serve/worker/index.js';
import { connectClient } from './integration-support.js';

describe('RTDB worker references', () => {
  let restoreSW: () => void;

  beforeEach(() => {
    const previous = (globalThis as { SharedWorker?: unknown }).SharedWorker;
    restoreSW = () => { (globalThis as { SharedWorker?: unknown }).SharedWorker = previous; };
  });
  afterEach(() => restoreSW());

  it('validates ref and child paths before crossing the worker boundary', async () => {
    const { db } = await connectClient();
    const rtdb = client.rtdbGetDatabase(db);

    expect(() => client.rtdbRef(rtdb, 'invalid.path')).toThrow('invalid path');
    expect(() => client.rtdbChild(client.rtdbRef(rtdb), '')).toThrow('invalid path');
    expect(() => client.rtdbChild(client.rtdbRef(rtdb), 'invalid#path')).toThrow('invalid path');
  });
});
