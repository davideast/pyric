// Saves an object with a Firebase download token and prints the download URL
// the app would store, plus what the host answers for it.
import { initializeApp } from "firebase-admin/app";
import { getStorage } from "firebase-admin/storage";

const host = process.argv[2];
if (!host) throw new Error("usage: node server.mjs <host url>");

const bucket = getStorage(initializeApp({ projectId: "demo-app", storageBucket: "demo-app.appspot.com" })).bucket();
const file = bucket.file("public/hello.txt");
await file.save(Buffer.from("hello"), {
  resumable: false,
  metadata: { contentType: "text/plain", metadata: { firebaseStorageDownloadTokens: "tok-1" } },
});

const downloadUrl = (token) =>
  `${host}/__pyric/storage/v0/b/${bucket.name}/o/${encodeURIComponent(file.name)}?alt=media` +
  (token ? `&token=${token}` : "");

const out = {
  bucket: bucket.name,
  downloadUrl: downloadUrl("tok-1"),
  wrongTokenUrl: downloadUrl("wrong"),
  typeofCreateResumableUpload: typeof bucket.file("staging/u1/upload-1").createResumableUpload,
  statuses: {},
};
try {
  await bucket.file("staging/u1/upload-1").createResumableUpload({ metadata: { contentType: "image/png" } });
  out.createResumableUpload = "resolved";
} catch (error) {
  out.createResumableUploadError = String(error?.message ?? error);
}
for (const [label, token] of [["token", "tok-1"], ["wrong", "wrong"], ["none", null]]) {
  out.statuses[label] = (await fetch(downloadUrl(token))).status;
}
console.log(JSON.stringify(out));
process.exit(0);
