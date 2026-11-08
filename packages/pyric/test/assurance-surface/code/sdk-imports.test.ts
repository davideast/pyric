import { describe, expect, test } from 'bun:test';
import { sdkBinding, SdkTable, AUTH_USER_FUNCTION } from '../../../src/assurance-surface/code/sdk-imports.js';
import { harness } from './harness.js';

describe('sdkBinding', () => {
  test('named, renamed, namespace and re-exported SDK imports', () => {
    const h = harness({
      'fb.ts': `export * from 'firebase/firestore'; export { ref as dbRef } from 'firebase/database';`,
      'use.ts': `
        import { setDoc, doc as d } from 'pyric/firestore';
        import * as rt from 'firebase/database';
        import { collection, dbRef } from './fb';
        import { useState } from 'react';
        import { helper } from 'lodash';
        setDoc; d; rt; collection; dbRef; useState; helper;
      `,
    });
    const table = new SdkTable([]);
    const at = (name: string) => sdkBinding(h.checker, h.checker.getSymbolAtLocation(h.ident('use.ts', name, 1))!, table);
    expect(at('setDoc')).toEqual({ k: 'api', module: 'firestore', name: 'setDoc' });
    expect(at('d')).toEqual({ k: 'api', module: 'firestore', name: 'doc' });
    expect(at('rt')).toEqual({ k: 'ns', module: 'rtdb' });
    expect(at('collection')).toEqual({ k: 'api', module: 'firestore', name: 'collection' });
    expect(at('dbRef')).toEqual({ k: 'api', module: 'rtdb', name: 'ref' });
    expect(at('useState')).toEqual({ k: 'api', module: 'react', name: 'useState' });
    expect(at('helper')).toBeUndefined();
  });

  test('presets add SDK module names and functions that return the signed-in user', () => {
    const h = harness({
      'use.ts': `import { setDoc } from '@acme/fire'; import { useMe } from '@acme/session'; setDoc; useMe;`,
    });
    const table = new SdkTable([{ name: 'acme', firestoreModules: ['@acme/fire'], authUserFunctions: ['@acme/session#useMe'] }]);
    const at = (name: string) => sdkBinding(h.checker, h.checker.getSymbolAtLocation(h.ident('use.ts', name, 1))!, table);
    expect(at('setDoc')).toEqual({ k: 'api', module: 'firestore', name: 'setDoc' });
    expect(at('useMe')).toEqual({ k: 'api', module: 'auth-hooks', name: AUTH_USER_FUNCTION });
  });
});
