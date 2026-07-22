import { describe, expect, it } from 'bun:test';
import { virtualModuleExportNames } from '../../../src/lib/preview/virtual-imports-plugin';

describe('firebase/database preview exports', () => {
  it('declares every newly supported database binding', () => {
    const names = [
      'onChildAdded',
      'onChildChanged',
      'onDisconnect',
      'OnDisconnect',
      'goOffline',
      'goOnline',
    ] as const;
    expect(virtualModuleExportNames('firebase/database')).toEqual(
      expect.arrayContaining(names),
    );
  });
});
