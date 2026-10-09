import { initializeApp } from "firebase/app";
import { getStorage, ref } from "firebase/storage";

const app = initializeApp({
  apiKey: "demo",
  appId: "demo",
  projectId: "demo-app",
  storageBucket: "demo-app.appspot.com",
});
const storage = getStorage(app);

// The bucket the page's Storage SDK names for this app config.
window.clientBucket = () => ref(storage, "uploads/u1/a.png").bucket;

// The app renders the download URL the server stored, and reads its bytes.
window.render = async (url) => {
  const response = await fetch(url);
  const bytes = [...new Uint8Array(await response.arrayBuffer())];
  const img = document.createElement("img");
  img.src = url;
  document.body.append(img);
  await img.decode();
  return { status: response.status, contentType: response.headers.get("content-type"), bytes, width: img.naturalWidth };
};
