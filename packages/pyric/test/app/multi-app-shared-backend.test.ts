import { beforeEach, describe, expect, it } from 'bun:test';
import 'fake-indexeddb/auto';
import { initializeApp } from 'pyric/app';
import { doc, getDoc, getFirestore, setDoc } from 'pyric/firestore';
import { getBytes, getStorage, ref as storageRef, uploadBytes } from 'pyric/storage';
import { resetAppRegistryForTests } from '../../dist/app/registry.js';

beforeEach(() => resetAppRegistryForTests());

describe('equal-config apps share one logical backend', () => {
  it('routes Firestore and Storage operations across distinct app handles', async () => {
    const options = { projectId: 'multi-app-shared-backend' };
    const a = initializeApp(options);
    const b = initializeApp({ ...options }, 'secondary');

    await setDoc(doc(getFirestore(a), 'shared/doc'), { source: 'app-a' });
    expect((await getDoc(doc(getFirestore(b), 'shared/doc'))).data()).toEqual({ source: 'app-a' });

    await uploadBytes(storageRef(getStorage(a), 'shared/file.bin'), new Uint8Array([1, 2, 3]));
    expect(new Uint8Array(await getBytes(storageRef(getStorage(b), 'shared/file.bin')))).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });
});
