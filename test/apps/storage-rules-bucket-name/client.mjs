// Uploads one object and reads its metadata back with the Firebase client SDK,
// as a server script of the app would under `node --import @pyric/cli/register`.
import { initializeApp, deleteApp } from "firebase/app";
import { getMetadata, getStorage, ref, uploadString } from "firebase/storage";

const app = initializeApp({
  apiKey: "demo",
  appId: "demo",
  projectId: "demo-app",
  storageBucket: "demo-app.appspot.com",
});
const target = ref(getStorage(app), process.argv[2]);
try {
  await uploadString(target, "from a server script");
  console.log(`bucket ${(await getMetadata(target)).bucket}`);
} catch (error) {
  console.log(`bucket ${error.code}`);
}
await deleteApp(app);
