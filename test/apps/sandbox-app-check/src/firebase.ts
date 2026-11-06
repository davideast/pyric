// The app's Firebase setup, imported by the page (main.js) and by a
// server-rendered module (ssr-render.js), as an app's shared firebase.ts is.
// It follows the browser recipe: App Check with reCAPTCHA v3.
import { initializeApp } from "firebase/app";
import { initializeAppCheck, ReCaptchaV3Provider } from "firebase/app-check";

export const app = initializeApp(
  {
    apiKey: "AIzaSyDemoKeyForReproOnly000000000000",
    projectId: "my-real-project",
    appId: "1:123456789012:web:abcdef0123456789",
  },
  "shared",
);

export const appCheck = initializeAppCheck(app, {
  provider: new ReCaptchaV3Provider("6Lc-site-key-from-the-console"),
  isTokenAutoRefreshEnabled: true,
});
