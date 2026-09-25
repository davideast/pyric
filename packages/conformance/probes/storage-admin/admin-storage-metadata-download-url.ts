import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { cert, deleteApp, initializeApp, type ServiceAccount } from 'firebase-admin/app';
import { getDownloadURL, getStorage } from 'firebase-admin/storage';
import type { Probe } from '../../rigs/types.ts';

const ROWS = [...[1, 2, 3, 4, 5, 6].map((ref) => `storage-admin#${ref}`), 'storage#51'];

function thrown(error: unknown): Record<string, unknown> {
  const value = error as { code?: unknown; message?: unknown };
  return {
    threw: true,
    code: typeof value.code === 'string' ? value.code : null,
    message: typeof value.message === 'string' ? value.message : String(error),
  };
}

async function attempt(work: () => Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await work();
    return { threw: false };
  } catch (error) {
    return thrown(error);
  }
}

/** The URL's parts, with the token replaced by how it relates to the stored one. */
function urlShape(url: string, storedToken: string): Record<string, unknown> {
  const parsed = new URL(url);
  return {
    origin: parsed.origin,
    pathForm: parsed.pathname.replace(/\/b\/[^/]+\/o\/[^/]+$/, '/b/<bucket>/o/<encoded path>'),
    alt: parsed.searchParams.get('alt'),
    tokenEqualsStored: parsed.searchParams.get('token') === storedToken,
    queryKeys: [...parsed.searchParams.keys()].sort(),
  };
}

export const probe: Probe = {
  description:
    'firebase-admin File.setMetadata/getMetadata custom metadata, including null removal, and getDownloadURL(file): minting a token for a file without one, its URL form once firebaseStorageDownloadTokens is set, the unauthenticated GET and Range GET it serves, the downloadTokens field the Firebase metadata endpoint reports, and revocation by removing the token.',
  matrixRow: 'storage-admin #1',
  rowIds: ROWS,
  async observe() {
    const serviceAccountPath = process.env.PYRIC_ORACLE_SA_PATH;
    const bucketName = process.env.PYRIC_ORACLE_STORAGE_BUCKET;
    if (!serviceAccountPath || !bucketName) {
      throw new Error('PYRIC_ORACLE_SA_PATH and PYRIC_ORACLE_STORAGE_BUCKET are required for the admin Storage oracle probe');
    }
    const serviceAccount = JSON.parse(readFileSync(serviceAccountPath, 'utf8')) as ServiceAccount;
    const app = initializeApp(
      { credential: cert(serviceAccount), storageBucket: bucketName },
      `admin-storage-metadata-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const bucket = getStorage(app).bucket();
    const file = bucket.file(`pyric_oracle/admin_storage_${Date.now()}/take one.wav`);
    const bytes = Buffer.from(Array.from({ length: 64 }, (_, index) => index));
    const token = randomUUID();

    try {
      await file.save(bytes, { contentType: 'audio/wav', resumable: false });
      const [afterSave] = await file.getMetadata();
      let mintedUrl: string | undefined;
      const noToken = await attempt(async () => { mintedUrl = await getDownloadURL(file); });
      const [afterMint] = await file.getMetadata();
      const minted = (afterMint.metadata as Record<string, unknown> | undefined)?.firebaseStorageDownloadTokens;

      const [setResult] = await file.setMetadata({ metadata: { firebaseStorageDownloadTokens: token, note: 'first' } });
      const [afterSet] = await file.getMetadata();
      const url = await getDownloadURL(file);

      const whole = await fetch(url);
      const wholeBytes = Buffer.from(await whole.arrayBuffer());
      const ranged = await fetch(url, { headers: { range: 'bytes=2-5' } });
      const rangedBytes = Buffer.from(await ranged.arrayBuffer());

      // What a client SDK reads: the Firebase metadata endpoint, as the service account.
      const accessToken = (await app.options.credential!.getAccessToken()).access_token;
      const firebaseMetadata = await (await fetch(
        `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(file.name)}`,
        { headers: { authorization: `Bearer ${accessToken}` } },
      )).json() as Record<string, unknown>;

      await file.setMetadata({ metadata: { note: null } });
      const [afterNullNote] = await file.getMetadata();

      await file.setMetadata({ metadata: { firebaseStorageDownloadTokens: null } });
      const [afterRevoke] = await file.getMetadata();
      const revoked = await fetch(url);
      let remintedUrl: string | undefined;
      const afterRevokeGetDownloadURL = await attempt(async () => { remintedUrl = await getDownloadURL(file); });
      const reminted = remintedUrl === undefined ? undefined : new URL(remintedUrl).searchParams.get('token');
      const remintedGet = remintedUrl === undefined ? undefined : await fetch(remintedUrl);

      return {
        afterSave: {
          customMetadata: afterSave.metadata ?? null,
          hasDownloadTokens: Boolean((afterSave.metadata as Record<string, unknown> | undefined)?.firebaseStorageDownloadTokens),
        },
        getDownloadURLWithoutToken: {
          ...noToken,
          mintsTokenIntoMetadata: typeof minted === 'string' && minted.length > 0,
          urlCarriesMintedToken: mintedUrl !== undefined && new URL(mintedUrl).searchParams.get('token') === minted,
          mintedTokenIsUuid: typeof minted === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(minted),
        },
        setMetadataResolvesWithMetadata: (setResult as { metadata?: unknown }).metadata !== undefined,
        afterSet: {
          customMetadata: {
            note: (afterSet.metadata as Record<string, unknown>).note,
            firebaseStorageDownloadTokensEqualsSet: (afterSet.metadata as Record<string, unknown>).firebaseStorageDownloadTokens === token,
          },
          metagenerationAdvanced: Number(afterSet.metageneration) > Number(afterSave.metageneration),
        },
        downloadURL: urlShape(url, token),
        unauthenticatedGet: {
          status: whole.status,
          contentType: whole.headers.get('content-type'),
          bytesMatch: wholeBytes.equals(bytes),
        },
        rangeGet: {
          status: ranged.status,
          contentRange: ranged.headers.get('content-range'),
          bytesMatch: rangedBytes.equals(bytes.subarray(2, 6)),
        },
        firebaseMetadataEndpoint: {
          downloadTokensEqualsSet: firebaseMetadata.downloadTokens === token,
          metadataHasTokenKey: Object.prototype.hasOwnProperty.call(firebaseMetadata.metadata ?? {}, 'firebaseStorageDownloadTokens'),
          customMetadataKeys: Object.keys((firebaseMetadata.metadata ?? {}) as Record<string, unknown>).sort(),
        },
        nullRemovesKey: {
          noteRemoved: !Object.prototype.hasOwnProperty.call(afterNullNote.metadata ?? {}, 'note'),
          tokenKept: (afterNullNote.metadata as Record<string, unknown> | undefined)?.firebaseStorageDownloadTokens === token,
        },
        revocation: {
          tokenRemoved: !Object.prototype.hasOwnProperty.call(afterRevoke.metadata ?? {}, 'firebaseStorageDownloadTokens'),
          revokedUrlStatus: revoked.status,
          getDownloadURLAfterRevoke: {
            ...afterRevokeGetDownloadURL,
            mintsNewToken: typeof reminted === 'string' && reminted !== token,
            newUrlStatus: remintedGet?.status ?? null,
          },
        },
      };
    } finally {
      await file.delete().catch(() => undefined);
      await deleteApp(app);
    }
  },
};
