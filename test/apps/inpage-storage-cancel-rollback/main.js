import { initializeApp } from "firebase/app";
import { getMetadata, getStorage, ref, uploadBytes, uploadBytesResumable } from "firebase/storage";

const app = initializeApp({ apiKey: "demo", appId: "demo", projectId: "cancel-app", storageBucket: "cancel-app.appspot.com" });
const storage = getStorage(app);

/** The size of the object at `path`, or the error code reading it gave. */
function sizeAt(path) {
  return getMetadata(ref(storage, path)).then((metadata) => metadata.size, (error) => error.code);
}

/**
 * Upload `size` bytes to `path` and cancel after `delayMs`, as a user
 * pressing Cancel would. Returns what the app sees: the code the error
 * observer heard and what it read there, then the rejection's code and
 * what a read after it finds.
 */
async function cancelAfter(path, size, delayMs) {
  const task = uploadBytesResumable(ref(storage, path), new Uint8Array(size).fill(9));
  const observed = new Promise((resolve) => {
    task.on(
      "state_changed",
      null,
      (error) => void sizeAt(path).then((read) => resolve({ code: error.code, read })),
      () => resolve("completed"),
    );
  });
  setTimeout(() => task.cancel(), delayMs);
  const rejection = await task.then(() => "resolved", (error) => error.code);
  const readAfter = await sizeAt(path);
  return { rejection, readAfter, observer: await observed };
}

window.cancelApp = {
  async cancelNew(name, size, delayMs) {
    return cancelAfter(`uploads/${name}`, size, delayMs);
  },
  async cancelOverwrite(name, size, delayMs) {
    await uploadBytes(ref(storage, `uploads/${name}`), new Uint8Array([7, 7, 7]));
    return cancelAfter(`uploads/${name}`, size, delayMs);
  },
};
