import { expect, it } from 'bun:test';
import { sdkMethodCoverage, sdkUntrackedMethods } from '../../src/sandbox/internal/sdk-coverage.js';

it('describes service-owned public operations separately from internal retries and control APIs', () => {
  expect(sdkMethodCoverage('firestore')).toContainEqual({ method: 'writeBatch.commit', category: 'write' });
  expect(sdkMethodCoverage('firestore')).toContainEqual({ method: 'getCountFromServer', category: 'read' });
  expect(sdkMethodCoverage('rtdb')).toContainEqual({ method: 'runTransaction', category: 'write' });
  expect(sdkMethodCoverage('rtdb')).toContainEqual({ method: 'onChildMoved', category: 'listener' });
  expect(sdkMethodCoverage('rtdb').map(row => row.method)).not.toContain('transactionCommit');
  expect(sdkUntrackedMethods('rtdb')).toEqual(['onDisconnect']);
  expect(sdkMethodCoverage('storage')).toContainEqual({ method: 'getBytes', category: 'read' });
  expect(sdkMethodCoverage('storage')).toContainEqual({ method: 'uploadBytesResumable', category: 'write' });
  expect(sdkMethodCoverage('storage').map(row => row.method)).not.toContain('pause');
  expect(Object.isFrozen(sdkMethodCoverage('firestore'))).toBe(true);
});
