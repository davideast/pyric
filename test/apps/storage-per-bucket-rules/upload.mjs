// Uploads one object, signed in to nothing, to the app's default bucket, to
// media-bucket, and to a bucket firebase.json deploys no rules to, as a
// server script of the app would under `node --import @pyric/cli/register`.
import { initializeApp, deleteApp } from "firebase/app";
import { getStorage, ref, uploadString } from "firebase/storage";

const app = initializeApp({
  apiKey: "demo",
  appId: "demo",
  projectId: "demo-app",
  storageBucket: "demo-app.appspot.com",
});

async function outcome(label, storage) {
  try {
    await uploadString(ref(storage, "uploads/a.txt"), "from a server script");
    console.log(`${label} ok`);
  } catch (error) {
    console.log(`${label} ${error.code}`);
  }
}

await outcome("default", getStorage(app));
await outcome("media", getStorage(app, "gs://media-bucket"));
await outcome("undeployed", getStorage(app, "gs://other-bucket"));
await deleteApp(app);
