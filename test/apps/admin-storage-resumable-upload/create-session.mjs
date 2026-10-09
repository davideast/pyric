// Step 1 of a server-issued upload: the server opens a resumable upload
// session for one object in a private staging bucket and hands its URL to the
// browser, which sends the bytes from the app's own origin.
import { initializeApp } from "firebase-admin/app";
import { getStorage } from "firebase-admin/storage";

const origin = process.argv[2];
if (!origin) throw new Error("usage: node create-session.mjs <page origin>");

const storage = getStorage(initializeApp({ projectId: "demo-app", storageBucket: "demo-app.appspot.com" }));
const out = { defaultBucket: storage.bucket().name };
try {
  const staging = storage.bucket("demo-app-upload-staging");
  out.stagingBucket = staging.name;
  const [sessionUrl] = await staging.file("staging/u1/upload-1").createResumableUpload({
    metadata: { contentType: "image/png", metadata: { uid: "u1" } },
    origin,
  });
  out.sessionUrl = sessionUrl;
} catch (error) {
  out.error = String(error?.message ?? error);
}
console.log(JSON.stringify(out));
process.exit(0);
