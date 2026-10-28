import { initializeApp } from "firebase/app";
import { getMetadata, getStorage, ref, uploadBytes } from "firebase/storage";

const app = initializeApp({
  apiKey: "demo",
  appId: "demo",
  projectId: "demo-app",
  storageBucket: "demo-app.appspot.com",
});
const storage = getStorage(app);

/** Upload one byte to `path`, read its metadata back, and return the bucket it reports or the error code. */
window.uploadAndRead = (path) =>
  uploadBytes(ref(storage, path), new Uint8Array([1]))
    .then(() => getMetadata(ref(storage, path)))
    .then(
      (metadata) => metadata.bucket,
      (error) => error.code,
    );
