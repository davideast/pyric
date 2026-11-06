// A notes app's Firebase init module: one file that sets up every service the
// app uses, as many apps write it. A callable Cloud Function drafts notes and
// Remote Config holds the editor's feature flags. Nothing here calls a function
// or fetches a config: getting each service makes no request.
import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFunctions } from "firebase/functions";
import { getRemoteConfig } from "firebase/remote-config";

const app = initializeApp({
  apiKey: "demo-api-key",
  authDomain: "demo-live-pass-through.firebaseapp.com",
  projectId: "demo-live-pass-through",
  appId: "1:123456789012:web:0a1b2c3d4e5f6071",
});
const auth = getAuth(app);
const functions = getFunctions(app);
const remoteConfig = getRemoteConfig(app);

const services = [
  ["auth", auth.app === app],
  ["functions", functions.app === app],
  ["remote-config", remoteConfig.app === app],
];
document.querySelector("#services").innerHTML = services
  .map(([name, sameApp]) => `<li data-service="${name}">${name}: ${sameApp ? "ready" : "another app"}</li>`)
  .join("");
document.querySelector("#status").textContent = "Ready";
