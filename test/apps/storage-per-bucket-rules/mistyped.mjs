// A server script with a mistyped default `storageBucket` that runs before the
// app's real page or server script (#1538). The mistyped bucket has no rules
// deployed in `firebase.json`, so its upload is denied without pinning the
// host's default store against the real `demo-app.appspot.com` bucket.
import { deleteApp, initializeApp } from "firebase/app";
import { getStorage, ref, uploadString } from "firebase/storage";

const app = initializeApp({
  apiKey: "demo",
  appId: "demo",
  projectId: "demo-app",
  storageBucket: "mistyped-app.appspot.com",
});

try {
  await uploadString(ref(getStorage(app), "uploads/a.txt"), "from mistyped script");
  console.log("mistyped ok");
} catch (error) {
  console.log(`mistyped ${error.code}`);
} finally {
  await deleteApp(app);
}
