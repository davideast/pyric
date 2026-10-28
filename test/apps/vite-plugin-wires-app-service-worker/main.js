import { initializeApp } from "firebase/app";
import { getDownloadURL, getStorage, ref, uploadBytes } from "firebase/storage";

const BUCKET = "demo-app.appspot.com";
const PATH = "images/dot.png";
const PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="),
  (char) => char.charCodeAt(0),
);

const app = initializeApp({
  apiKey: "demo",
  appId: "demo",
  projectId: "demo-app",
  storageBucket: BUCKET,
});
const storage = getStorage(app);

async function controlledByServiceWorker() {
  await navigator.serviceWorker.register("/dev-sw.js?dev-sw", { type: "module" });
  if (navigator.serviceWorker.controller) return;
  await new Promise((resolve) => navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true }));
}

// A server stored the production download URL; the page renders it as written.
window.uploadAndBuildProductionUrl = async () => {
  await controlledByServiceWorker();
  const object = ref(storage, PATH);
  await uploadBytes(object, PNG, { contentType: "image/png" });
  const token = new URL(await getDownloadURL(object)).searchParams.get("token");
  return `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/${encodeURIComponent(PATH)}?alt=media&token=${token}&generation=1700000000000000`;
};

window.renderImage = (url) =>
  new Promise((resolve) => {
    const img = document.createElement("img");
    img.onload = () => resolve({ loaded: true, width: img.naturalWidth });
    img.onerror = () => resolve({ loaded: false, width: 0 });
    img.src = url;
    document.body.append(img);
  });

window.download = async (url) => {
  const response = await fetch(url);
  return { status: response.status, bytes: (await response.arrayBuffer()).byteLength };
};

window.downloadText = async (url) => {
  const response = await fetch(url);
  return { status: response.status, text: await response.text() };
};
