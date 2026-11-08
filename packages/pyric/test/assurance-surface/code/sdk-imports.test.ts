import { describe, expect, test } from 'bun:test';
import { Evaluator } from '../../../src/assurance-surface/code/evaluator.js';
import { buildPrograms } from '../../../src/assurance-surface/code/program.js';
import { ReferenceIndex } from '../../../src/assurance-surface/code/references.js';
import { sdkBinding, SdkTable, AUTH_USER_FUNCTION } from '../../../src/assurance-surface/code/sdk-imports.js';
import type { SdkServiceModel } from '../../../src/assurance-surface/code/service-models/types.js';
import { SiteCollector } from '../../../src/assurance-surface/code/sites.js';
import { mergeResults } from '../../../src/assurance-surface/code/specialization.js';
import { harness, ROOT } from './harness.js';

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

  test('supports registering an additional SdkServiceModel without evaluator changes', () => {
    const storageModel: SdkServiceModel = {
      service: 'storage',
      modules: ['firebase/storage', 'pyric/storage'],
      handleFactories: {
        getStorage: { resourceArgIndex: 1, singleStringArgIsResource: true },
      },
      refConstructors: {
        ref: { refKind: 'object' },
      },
      constraints: {},
      operations: {
        uploadBytes: { op: 'uploadBytes', data: 1, write: true },
        getDownloadURL: { op: 'get', readKind: true },
      },
    };
    const [prog] = buildPrograms(ROOT, {
      'upload.ts': `
        import { getStorage, ref, uploadBytes } from 'pyric/storage';
        import { getAuth } from 'pyric/auth';
        declare const app: unknown;
        const storage = getStorage(app, 'gs://media-bucket');
        export async function uploadAvatar(bytes: Uint8Array) {
          const uid = getAuth().currentUser!.uid;
          await uploadBytes(ref(storage, 'avatars/' + uid + '/photo.png'), bytes);
        }
      `,
    }, []);
    const table = new SdkTable([], [storageModel]);
    const ev = new Evaluator(prog.checker, new ReferenceIndex(prog.checker, prog.files), table);
    const collector = new SiteCollector(ev, ROOT, true);
    for (const sf of prog.files) collector.scanFile(sf, true);
    const sites = mergeResults([collector.finish()]);
    expect(sites).toHaveLength(1);
    expect(sites[0]).toMatchObject({
      service: 'storage',
      op: 'uploadBytes',
      path: 'avatars/{uid}/photo.png',
      resolution: 'resolved',
    });
  });
});
