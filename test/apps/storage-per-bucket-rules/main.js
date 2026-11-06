// Uploads one object, signed in to nothing, to the app's default bucket, to
// media-bucket, and to a bucket firebase.json deploys no rules to, and
// returns one line per upload: the bucket's label and "ok" or the error code.
import { initializeApp } from "firebase/app";
import { getStorage, ref, uploadString } from "firebase/storage";

const app = initializeApp({
  apiKey: "demo",
  appId: "demo",
  projectId: "demo-app",
  storageBucket: "demo-app.appspot.com",
});

async function outcome(label, storage, path) {
  try {
    await uploadString(ref(storage, path), "from the page");
    return `${label} ok`;
  } catch (error) {
    return `${label} ${error.code}`;
  }
}

window.uploadToEachBucket = async (path) => [
  await outcome("default", getStorage(app), path),
  await outcome("media", getStorage(app, "gs://media-bucket"), path),
  await outcome("undeployed", getStorage(app, "gs://other-bucket"), path),
];
