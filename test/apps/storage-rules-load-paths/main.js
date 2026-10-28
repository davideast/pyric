import { initializeApp } from "firebase/app";
import { getStorage, ref, uploadBytes } from "firebase/storage";

const app = initializeApp({
  apiKey: "demo",
  appId: "demo",
  projectId: "demo-storage-load-paths",
  storageBucket: "demo-storage-load-paths.appspot.com",
});
const storage = getStorage(app);

/** Upload one byte to `path`, and return "ok" or the error code. */
window.upload = (path) =>
  uploadBytes(ref(storage, path), new Uint8Array([1])).then(
    () => "ok",
    (error) => error.code,
  );
