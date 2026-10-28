import { initializeApp } from "firebase/app";
import { getStorage, ref, uploadBytes } from "firebase/storage";

const app = initializeApp({
  apiKey: "demo",
  appId: "demo",
  projectId: "demo-app",
  storageBucket: "demo-app.appspot.com",
});
const storage = getStorage(app);

/** Upload one byte to `path` with `customMetadata`, and return "ok" or the error code. */
window.upload = (path, customMetadata) =>
  uploadBytes(ref(storage, path), new Uint8Array([1]), { customMetadata }).then(
    () => "ok",
    (error) => error.code,
  );
