import { deleteApp, initializeApp } from 'firebase/app';
import { getStorage, ref, type FirebaseStorage, type StorageReference } from 'firebase/storage';
import { captureThrow } from '../../src/captured-throw.ts';
import type { Probe } from '../../rigs/types.ts';

/** The default bucket the probe's app is configured with. */
const BUCKET = 'b';

const ROWS = [110, 111, 112, 113, 114, 115, 116].map((row) => `storage#${row}`);

/**
 * Each case is one `ref()` call: `input` is the string passed as its second
 * argument, and `parent`, when present, is the path of the reference passed as
 * its first argument in place of the Storage instance.
 */
const CASES: Record<string, { input: string; parent?: string }> = {
  plainPath: { input: 'media/take.wav' },
  gsDefaultBucket: { input: `gs://${BUCKET}/media/take.wav` },
  gsOtherBucket: { input: 'gs://other-bucket/media/take.wav' },
  gsBucketRoot: { input: `gs://${BUCKET}` },
  gsPathNotDecoded: { input: `gs://${BUCKET}/media/take%20one.wav` },
  gsNoBucket: { input: 'gs://' },
  firebaseDownloadUrl: {
    input: `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/media%2Ftake.wav?alt=media&token=t`,
  },
  firebaseDownloadUrlEncoded: {
    input: `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/my%20media%2Ftake%201.wav?alt=media&token=t`,
  },
  firebaseDownloadUrlOtherBucket: {
    input: 'https://firebasestorage.googleapis.com/v0/b/other-bucket/o/media%2Ftake.wav?alt=media&token=t',
  },
  firebaseUrlNoObject: { input: `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o?alt=media` },
  cloudStorageUrl: { input: `https://storage.googleapis.com/${BUCKET}/media/take.wav` },
  pyricHostUrl: {
    input: `http://localhost:3473/__pyric/storage/v0/b/${BUCKET}/o/media%2Ftake.wav?alt=media&token=x`,
  },
  otherHostUrl: { input: 'https://example.com/media/take.wav' },
  dataUri: { input: 'data:audio/wav;base64,UklGRg==' },
  childRefWithUrl: { input: `gs://${BUCKET}/media/take.wav`, parent: 'media' },
};

function observeCase(storage: FirebaseStorage, input: string, parent?: string): Record<string, unknown> {
  let made: StorageReference | undefined;
  const outcome = captureThrow(() => {
    made = parent === undefined ? ref(storage, input) : ref(ref(storage, parent), input);
  });
  const recorded: Record<string, unknown> = { input, ...(parent === undefined ? {} : { parent }) };
  if (outcome.threw) return { ...recorded, ...outcome };
  return { ...recorded, threw: false, bucket: made!.bucket, fullPath: made!.fullPath, name: made!.name };
}

export const probe: Probe = {
  description:
    "firebase/storage ref(storage, url) parses a URL client-side, with no request: gs://<bucket>/<path>, the https://firebasestorage.googleapis.com/v0/b/<bucket>/o/<path> download URL, and the https://storage.googleapis.com/<bucket>/<path> URL give a reference on the URL's bucket, the download URL's path percent-decoded and the gs:// path not; a URL on any other host, or with no bucket or object, throws storage/invalid-url; a string without '://', such as a data: URI, is an object path; and ref(reference, url) throws storage/invalid-argument. The app is initialized with storageBucket 'b'.",
  matrixRow: 'storage #110-#116',
  rowIds: ROWS,
  async observe() {
    const app = initializeApp({ projectId: 'demo-x', storageBucket: BUCKET }, `client-storage-ref-urls-${Date.now()}`);
    try {
      const storage = getStorage(app);
      const behavior: Record<string, unknown> = {};
      for (const [key, { input, parent }] of Object.entries(CASES)) behavior[key] = observeCase(storage, input, parent);
      return behavior;
    } finally {
      await deleteApp(app);
    }
  },
};
