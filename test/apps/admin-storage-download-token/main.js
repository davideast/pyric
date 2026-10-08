import { initializeApp } from "firebase/app";
import { getStorage } from "firebase/storage";

const app = initializeApp({
  apiKey: "demo",
  appId: "demo",
  projectId: "demo-app",
  storageBucket: "demo-app.appspot.com",
});
getStorage(app);

// The server stores a Firebase download URL; the page downloads what it names.
window.download = async (url) => {
  const response = await fetch(url);
  return { status: response.status, text: await response.text() };
};
