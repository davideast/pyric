import { initializeApp } from "firebase/app";
import { getBytes, getStorage, ref, uploadBytes } from "firebase/storage";

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

/** Read `path` through `getBytes`, returning `ok:<byteLength>` or the error code. */
window.readBytes = (path) =>
  getBytes(ref(storage, path)).then(
    (buf) => `ok:${buf.byteLength}`,
    (error) => error.code,
  );
