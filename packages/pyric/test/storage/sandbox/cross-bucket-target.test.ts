import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { deleteApp } from '../../../src/app/index.js';
import { createAppForSandbox } from '../../../src/app/internal.js';
import { signInWithEmailAndPassword, createUserWithEmailAndPassword, getAuth, signOut } from '../../../src/auth/index.js';
import { createSdkRateMonitor, sdkActivity } from '../../../src/sandbox/internal/index.js';
import { initializeSandbox } from 'pyric/sandbox';
import {
  deleteObject,
  getBytes,
  getMetadata,
  getStorage,
  listAll,
  ref,
  updateMetadata,
  uploadBytes,
  uploadBytesResumable,
} from '../../../src/storage/index.js';
import {
  deployStorageBucketRules,
  lockUndeployedStorageBuckets,
} from '../../../src/storage/internal.js';

const DEFAULT_AUTH_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /shared/{allPaths=**} {
      allow read, write: if true;
    }
    match /private/{uid}/{file} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
  }
}`;

const MEDIA_OPEN_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if bucket == 'media-bucket';
    }
  }
}`;

const VAULT_AUTH_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /members/{uid}/{file} {
      allow read, write: if bucket == 'vault-bucket' && request.auth != null && request.auth.uid == uid;
    }
  }
}`;

let seq = 0;

function createPerBucketApp() {
  seq += 1;
  const projectId = `demo-cross-bucket-${seq}-${Math.random().toString(36).slice(2, 8)}`;
  const sandbox = initializeSandbox({ projectId });
  lockUndeployedStorageBuckets(sandbox, 'deny');
  deployStorageBucketRules(sandbox, 'demo-app.appspot.com', DEFAULT_AUTH_RULES);
  deployStorageBucketRules(sandbox, 'media-bucket', MEDIA_OPEN_RULES);
  deployStorageBucketRules(sandbox, 'vault-bucket', VAULT_AUTH_RULES);
  const app = createAppForSandbox(
    sandbox,
    {
      apiKey: 'demo-key',
      projectId,
      storageBucket: 'demo-app.appspot.com',
    },
    `cross-bucket-app-${seq}`,
  );
  return { app, sandbox };
}

describe('cross-bucket ref(storage, url) routing in sandbox storage', () => {
  it('routes cross-bucket gs:// and download URLs to the target bucket store and rules while preserving ref.storage', async () => {
    const { app, sandbox } = createPerBucketApp();
    try {
      const defaultStorage = getStorage(app);
      const mediaStorage = getStorage(app, 'gs://media-bucket');

      const crossGsRef = ref(defaultStorage, 'gs://media-bucket/shared/intro.bin');
      const crossDownloadRef = ref(
        defaultStorage,
        'https://firebasestorage.googleapis.com/v0/b/media-bucket/o/shared%2Fintro.bin?alt=media&token=tok-1',
      );
      expect(crossGsRef.storage).toBe(defaultStorage);
      expect(crossGsRef.bucket).toBe('media-bucket');
      expect(crossGsRef.toString()).toBe('gs://media-bucket/shared/intro.bin');
      expect(crossGsRef.parent?.bucket).toBe('media-bucket');
      expect(crossGsRef.parent?.storage).toBe(defaultStorage);
      expect(crossGsRef.root.bucket).toBe('media-bucket');
      expect(crossGsRef.root.storage).toBe(defaultStorage);

      const childFromCross = ref(crossGsRef.root, 'shared/outro.bin');
      expect(childFromCross.bucket).toBe('media-bucket');
      expect(childFromCross.storage).toBe(defaultStorage);

      const monitor = createSdkRateMonitor();
      const observedTargets: string[] = [];
      const stopActivity = sdkActivity.subscribe((event) => {
        if (event.phase === 'start' && event.record.service === 'storage') {
          observedTargets.push(event.record.target);
        }
      });
      let uploadedBucket = '';
      try {
        const uploaded = await uploadBytes(crossGsRef, new Uint8Array([9, 8, 7]), {
          contentType: 'application/octet-stream',
          customMetadata: { clip: 'intro' },
        });
        uploadedBucket = uploaded.metadata.bucket;
        await uploadBytes(childFromCross, new Uint8Array([1, 2]));
      } finally {
        stopActivity();
        monitor.dispose();
      }
      expect(uploadedBucket).toBe('media-bucket');
      expect(observedTargets).toContain('gs://media-bucket/shared/intro.bin');
      expect(observedTargets).toContain('gs://media-bucket/shared/outro.bin');

      // Invisible in the default bucket at the same allowed object path.
      await expect(getMetadata(ref(defaultStorage, 'shared/intro.bin'))).rejects.toMatchObject({
        code: 'storage/object-not-found',
      });

      // A path denied on the default bucket succeeds when addressed on media-bucket by URL.
      await expect(uploadBytes(ref(defaultStorage, 'clips/only-media.bin'), new Uint8Array([3]))).rejects.toMatchObject({
        code: 'storage/unauthorized',
      });
      const mediaOnlyUpload = await uploadBytes(
        ref(defaultStorage, 'gs://media-bucket/clips/only-media.bin'),
        new Uint8Array([3]),
      );
      expect(mediaOnlyUpload.metadata.bucket).toBe('media-bucket');
      await deleteObject(ref(defaultStorage, 'gs://media-bucket/clips/only-media.bin'));

      // Visible through both the cross-bucket download URL ref and getStorage(app, 'gs://media-bucket').
      const metaViaUrl = await getMetadata(crossDownloadRef);
      expect(metaViaUrl.bucket).toBe('media-bucket');
      expect(metaViaUrl.customMetadata).toEqual({ clip: 'intro' });

      const updatedMeta = await updateMetadata(crossDownloadRef, {
        customMetadata: { clip: 'intro-v2' },
      });
      expect(updatedMeta.bucket).toBe('media-bucket');
      expect(updatedMeta.customMetadata).toEqual({ clip: 'intro-v2' });

      const bytesViaNamedHandle = new Uint8Array(
        await getBytes(ref(mediaStorage, 'shared/intro.bin')),
      );
      expect([...bytesViaNamedHandle]).toEqual([9, 8, 7]);

      const listed = await listAll(crossGsRef.root);
      expect(listed.prefixes.map((p) => ({ path: p.fullPath, bucket: p.bucket, sameStorage: p.storage === defaultStorage }))).toEqual([
        { path: 'shared', bucket: 'media-bucket', sameStorage: true },
      ]);
      const sharedPrefix = listed.prefixes[0];
      expect(sharedPrefix).toBeDefined();
      if (sharedPrefix !== undefined) {
        const sharedItems = await listAll(sharedPrefix);
        expect(sharedItems.items.map((item) => ({ path: item.fullPath, bucket: item.bucket, sameStorage: item.storage === defaultStorage }))).toEqual([
          { path: 'shared/intro.bin', bucket: 'media-bucket', sameStorage: true },
          { path: 'shared/outro.bin', bucket: 'media-bucket', sameStorage: true },
        ]);
      }

      await deleteObject(crossDownloadRef);
      await expect(getMetadata(ref(mediaStorage, 'shared/intro.bin'))).rejects.toMatchObject({
        code: 'storage/object-not-found',
      });
    } finally {
      await deleteApp(app);
      sandbox.dispose();
    }
  });

  it('routes a URL naming the default bucket from a named-bucket handle back to the default store and fails closed on undeployed buckets', async () => {
    const { app, sandbox } = createPerBucketApp();
    try {
      const defaultStorage = getStorage(app);
      const mediaStorage = getStorage(app, 'gs://media-bucket');

      const backToDefaultRef = ref(mediaStorage, 'gs://demo-app.appspot.com/shared/readme.txt');
      expect(backToDefaultRef.storage).toBe(mediaStorage);
      expect(backToDefaultRef.bucket).toBe('demo-app.appspot.com');

      const uploaded = await uploadBytes(
        backToDefaultRef,
        new TextEncoder().encode('from-media-handle'),
      );
      expect(uploaded.metadata.bucket).toBe('demo-app.appspot.com');

      const readFromDefault = new TextDecoder().decode(
        new Uint8Array(await getBytes(ref(defaultStorage, 'shared/readme.txt'))),
      );
      expect(readFromDefault).toBe('from-media-handle');

      const undeployedRef = ref(defaultStorage, 'gs://undeployed-bucket/shared/locked.txt');
      expect(undeployedRef.bucket).toBe('undeployed-bucket');
      await expect(
        uploadBytes(undeployedRef, new Uint8Array([1])),
      ).rejects.toMatchObject({ code: 'storage/unauthorized' });
    } finally {
      await deleteApp(app);
      sandbox.dispose();
    }
  });

  it('tracks live app Auth session changes and resumable upload cancel rollback on cross-bucket URL references', async () => {
    const { app, sandbox } = createPerBucketApp();
    try {
      const auth = getAuth(app);
      const defaultStorage = getStorage(app);
      const cred = await createUserWithEmailAndPassword(auth, 'lara@acme.test', 'password123');
      const uid = cred.user.uid;

      // Construct the cross-bucket reference BEFORE signing out and signing back in.
      const vaultRef = ref(defaultStorage, `gs://vault-bucket/members/${uid}/secret.bin`);
      await signOut(auth);

      await expect(uploadBytes(vaultRef, new Uint8Array([1, 2, 3]))).rejects.toMatchObject({
        code: 'storage/unauthorized',
      });

      await signInWithEmailAndPassword(auth, 'lara@acme.test', 'password123');
      await uploadBytes(vaultRef, new Uint8Array([1, 2, 3]));

      const replaceTask = uploadBytesResumable(vaultRef, new Uint8Array([4, 5, 6, 7]));
      replaceTask.cancel();
      await expect(Promise.resolve(replaceTask)).rejects.toMatchObject({ code: 'storage/canceled' });

      const retained = new Uint8Array(await getBytes(vaultRef));
      expect([...retained]).toEqual([1, 2, 3]);
    } finally {
      await deleteApp(app);
      sandbox.dispose();
    }
  });
});
