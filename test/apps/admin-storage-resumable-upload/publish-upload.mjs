// Step 3 of a server-issued upload: the server validates the staged object,
// copies it into the default bucket with a Firebase download token, deletes
// the staged copy, and prints the download URL the app stores.
import { randomUUID } from "node:crypto";
import { initializeApp } from "firebase-admin/app";
import { getStorage } from "firebase-admin/storage";

const host = process.argv[2];
if (!host) throw new Error("usage: node publish-upload.mjs <host url>");

const storage = getStorage(initializeApp({ projectId: "demo-app", storageBucket: "demo-app.appspot.com" }));
const bucket = storage.bucket();
const staged = storage.bucket("demo-app-upload-staging").file("staging/u1/upload-1");
const out = {};
try {
  const [[exists], [metadata], [bytes]] = await Promise.all([staged.exists(), staged.getMetadata(), staged.download()]);
  out.staged = {
    exists,
    bucket: metadata.bucket,
    contentType: metadata.contentType,
    size: metadata.size,
    metadata: metadata.metadata,
    isPng: bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  };
  // The staging bucket's object is not in the default bucket.
  out.stagedPathInDefaultBucket = (await bucket.file("staging/u1/upload-1").exists())[0];

  const token = randomUUID();
  const path = "uploads/u1/a.png";
  const [published, publishedMetadata] = await staged.copy(bucket.file(path), {
    metadata: { firebaseStorageDownloadTokens: token },
  });
  await staged.delete();
  out.published = {
    bucket: published.bucket.name,
    contentType: publishedMetadata.contentType,
    metadata: publishedMetadata.metadata,
  };
  out.stagedAfterDelete = (await staged.exists())[0];
  out.downloadUrl = `${host}/__pyric/storage/v0/b/${bucket.name}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
  out.token = token;
} catch (error) {
  out.error = String(error?.message ?? error);
}
console.log(JSON.stringify(out));
process.exit(0);
