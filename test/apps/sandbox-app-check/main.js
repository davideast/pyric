import { initializeApp } from "firebase/app";
import {
  ReCaptchaV3Provider,
  getLimitedUseToken,
  getToken,
  initializeAppCheck,
  onTokenChanged,
  setTokenAutoRefreshEnabled,
} from "firebase/app-check";
import { runAiChecks } from "./ai-checks.js";
import { appCheck as sharedAppCheck } from "./src/firebase.ts";

const app = initializeApp({
  apiKey: "AIzaSyDemoKeyForReproOnly000000000000",
  projectId: "my-real-project",
  appId: "1:123456789012:web:abcdef0123456789",
});

const claims = (token) => JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));

window.runAppCheck = async () => {
  const appCheck = initializeAppCheck(app, {
    provider: new ReCaptchaV3Provider("6Lc-site-key-from-the-console"),
    isTokenAutoRefreshEnabled: true,
  });
  const changes = [];
  const unsubscribe = onTokenChanged(appCheck, (result) => changes.push(result.token));
  const first = await getToken(appCheck);
  const again = await getToken(appCheck);
  const limited = await getLimitedUseToken(appCheck);
  await new Promise((resolve) => setTimeout(resolve, 100));
  unsubscribe();
  setTokenAutoRefreshEnabled(appCheck, false);
  let twice = null;
  try {
    initializeAppCheck(app, { provider: new ReCaptchaV3Provider("6Lc-site-key-from-the-console"), isTokenAutoRefreshEnabled: false });
  } catch (e) {
    twice = e.code;
  }
  const c = claims(first.token);
  window.appCheckToken = first.token;
  return {
    segments: first.token.split(".").length,
    cached: again.token === first.token,
    limitedDiffers: limited.token !== first.token,
    sub: c.sub,
    aud: c.aud,
    iss: c.iss,
    ttl: c.exp - c.iat,
    listenerSawFirst: changes.includes(first.token),
    twice,
  };
};

window.runAiChecks = runAiChecks;

/** The shared firebase.ts initialized App Check with reCAPTCHA in the page: its token has three segments. */
window.runSharedAppCheck = async () => ({ tokenSegments: (await getToken(sharedAppCheck)).token.split(".").length });
