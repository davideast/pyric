// A notes app's Firebase init module: one file that sets up every service the
// app uses, as many apps write it. Cloud Storage holds note attachments and a
// callable Cloud Function drafts notes. Nothing here reads, writes or calls a
// function: getting each service makes no request.
import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getStorage } from "firebase/storage";
import { getFunctions } from "firebase/functions";

const app = initializeApp({
  apiKey: "demo-api-key",
  authDomain: "demo-live-pass-through.firebaseapp.com",
  storageBucket: "demo-live-pass-through.firebasestorage.app",
  projectId: "demo-live-pass-through",
  appId: "1:123456789012:web:0a1b2c3d4e5f6071",
});
const auth = getAuth(app);
const storage = getStorage(app);
const functions = getFunctions(app);

const services = [
  ["auth", auth.app === app],
  ["storage", storage.app === app],
  ["functions", functions.app === app],
];
document.querySelector("#services").innerHTML = services
  .map(([name, sameApp]) => `<li data-service="${name}">${name}: ${sameApp ? "ready" : "another app"}</li>`)
  .join("");
document.querySelector("#status").textContent = "Ready";
