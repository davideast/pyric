// An assistant app's client code, the same module on the page and in its
// server job. It makes two apps, both signed in with a custom token: one with
// no App Check, and one with a token (a CustomProvider on the page, a server
// app's `appCheckToken` in Node). The app without App Check asks for content
// once; the app with a token generates content, streams it, counts tokens,
// sends a chat message and streams one, and asks a model no one serves. Last
// it opens a Live API model. Its backend is production, or the local one a
// `?backend=<origin>` query (the page) or APP_BACKEND (the server job) names:
// Auth through the SDK's emulator connector, AI Logic through the model's
// `baseUrl`, the SDK's own request option.
import { deleteApp, initializeApp, initializeServerApp } from "firebase/app";
import { connectAuthEmulator, getAuth, signInWithCustomToken, signOut } from "firebase/auth";
import { CustomProvider, initializeAppCheck } from "firebase/app-check";
import { getAI, getGenerativeModel, getLiveGenerativeModel, GoogleAIBackend } from "firebase/ai";

const PROJECT = "demo-live-ai";
const config = {
  projectId: PROJECT,
  apiKey: "demo-live-ai-key",
  appId: "1:1:web:live-ai",
  authDomain: `${PROJECT}.firebaseapp.com`,
};
const MODEL = "gemini-flash-lite-latest";
const UNSERVED_MODEL = "gemini-not-served";
/** The prompts the app sends. Live mode records none of them. */
const PROMPTS = {
  generate: "Name one lighthouse keeper's chore.",
  stream: "Count the lighthouse steps from 1 to 10.",
  chat: "Which lighthouse is the tallest?",
};
const isPage = typeof window === "object";
const backend = isPage ? new URLSearchParams(location.search).get("backend") : process.env.APP_BACKEND;
const url = backend ? new URL(backend) : null;

/** Signs `auth` in as `client-1`, through the local backend when there is one. */
async function signIn(auth) {
  if (url) connectAuthEmulator(auth, url.origin, { disableWarnings: true });
  const credential = await signInWithCustomToken(auth, "client-1");
  return credential.user;
}

/** The app with no App Check, signed in, and the apps that signed in for it. */
async function appWithoutAppCheck() {
  const app = initializeApp(config, "no-app-check");
  await signIn(getAuth(app));
  return { app, signedIn: [app] };
}

/**
 * The app with an App Check token, signed in, and the apps that signed in
 * for it. On the page, a CustomProvider hands out the token. A server app
 * takes it as `appCheckToken`, and its user as `authIdToken` from an app that
 * signed in, since a server app cannot sign in itself.
 */
async function appWithAppCheck() {
  if (isPage) {
    const app = initializeApp(config, "with-app-check");
    initializeAppCheck(app, {
      provider: new CustomProvider({ getToken: async () => ({ token: "page-app-check-token", expireTimeMillis: Date.now() + 3_600_000 }) }),
      isTokenAutoRefreshEnabled: false,
    });
    await signIn(getAuth(app));
    return { app, signedIn: [app] };
  }
  const signer = initializeApp(config, "server-signer");
  const user = await signIn(getAuth(signer));
  const app = initializeServerApp(config, { appCheckToken: "server-app-check-token", authIdToken: await user.getIdToken() });
  const auth = getAuth(app);
  if (url) connectAuthEmulator(auth, url.origin, { disableWarnings: true });
  await auth.authStateReady();
  return { app, signedIn: [signer] };
}

function modelOf(app, model = MODEL) {
  const ai = getAI(app, { backend: new GoogleAIBackend() });
  return getGenerativeModel(ai, { model }, url ? { baseUrl: url.origin } : undefined);
}

/** A failed call as the HTTP status production answered, or the error's code. */
const failure = (error) => (error.customErrorData?.status ? `http ${error.customErrorData.status}` : error.code ?? String(error));

async function streamed(result) {
  const chunks = [];
  for await (const chunk of result.stream) chunks.push(chunk.text());
  await result.response;
  return chunks.join("");
}

/** The app's calls, each one's outcome: production's text, token counts or failure. */
async function runApp() {
  const withoutAppCheck = await appWithoutAppCheck();
  const withAppCheck = await appWithAppCheck();
  const plain = withoutAppCheck.app;
  const checked = withAppCheck.app;
  const result = {};
  const step = async (name, run) => {
    try {
      result[name] = await run();
    } catch (error) {
      result[name] = failure(error);
    }
  };
  await step("noAppCheck", async () => (await modelOf(plain).generateContent(PROMPTS.generate)).response.text());
  const model = modelOf(checked);
  await step("generateContent", async () => {
    const { response } = await model.generateContent(PROMPTS.generate);
    return { text: response.text(), totalTokenCount: response.usageMetadata?.totalTokenCount };
  });
  await step("generateContentStream", async () => streamed(await model.generateContentStream(PROMPTS.stream)));
  await step("countTokens", async () => (await model.countTokens(PROMPTS.generate)).totalTokens);
  const chat = model.startChat();
  await step("sendMessage", async () => (await chat.sendMessage(PROMPTS.chat)).response.text());
  await step("sendMessageStream", async () => streamed(await chat.sendMessageStream(PROMPTS.stream)));
  await step("unknownModel", async () => (await modelOf(checked, UNSERVED_MODEL).generateContent(PROMPTS.generate)).response.text());
  const signedIn = [...withoutAppCheck.signedIn, ...withAppCheck.signedIn];
  return { result, checked, signedIn, apps: [...new Set([...signedIn, checked])] };
}

/** Opens a Live API model on the app with a token: live mode refuses it before anything leaves. */
function openLive(app) {
  try {
    getLiveGenerativeModel(getAI(app, { backend: new GoogleAIBackend() }), { model: MODEL });
    return "opened";
  } catch (error) {
    return error.code ?? String(error);
  }
}

if (isPage) {
  let checked = null;
  window.runApp = () => runApp().then((run) => {
    checked = run.checked;
    return run.result;
  }, (error) => `failed: ${error.code ?? ""} ${error.message}`);
  window.openLive = () => openLive(checked);
  document.querySelector("#status").textContent = "Ready";
} else {
  const { result, checked, signedIn, apps } = await runApp();
  result.getLiveGenerativeModel = openLive(checked);
  // Signing out stops each user's token refresh timer, which would keep the process running.
  for (const app of signedIn) await signOut(getAuth(app));
  for (const app of apps) await deleteApp(app);
  console.log(`RESULT ${JSON.stringify(result)}`);
}
