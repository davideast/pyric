// Server-rendered App Check + direct SDK stop probe for production AI mode (#1630, #1907, #1735).
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { deleteApp, initializeApp } from "firebase/app";
import { CustomProvider, getToken, initializeAppCheck } from "firebase/app-check";
import { config } from "./config.js";

async function stopOutcome(load) {
  try {
    await load();
    return { ok: true, value: "loaded" };
  } catch (error) {
    return {
      ok: false,
      code: error?.code ?? null,
      message: String(error?.message ?? error),
    };
  }
}

export async function runProductionAppCheck(tag) {
  const app = initializeApp(config, `ssr-ac-${tag}`);
  let tokenValue = null;
  try {
    const appCheck = initializeAppCheck(app, {
      provider: new CustomProvider({
        getToken: async () => ({
          token: `ssr-token-${tag}`,
          expireTimeMillis: Date.now() + 60_000,
        }),
      }),
      isTokenAutoRefreshEnabled: false,
    });
    const tokenResult = await getToken(appCheck);
    tokenValue = tokenResult.token;
  } finally {
    await deleteApp(app);
  }

  const realAppUrl = pathToFileURL(
    resolve(process.cwd(), "node_modules/firebase/app/dist/index.mjs"),
  ).href;
  const realAppCheckUrl = pathToFileURL(
    resolve(process.cwd(), "node_modules/firebase/app-check/dist/index.mjs"),
  ).href;

  const directAtFirebaseAi = await stopOutcome(() => import("@firebase/ai"));
  const absFirebaseApp = await stopOutcome(() => import(/* @vite-ignore */ realAppUrl));
  const absFirebaseAppCheck = await stopOutcome(() => import(/* @vite-ignore */ realAppCheckUrl));

  return {
    outcomes: {
      appCheckToken: { ok: true, value: tokenValue },
      "@firebase/ai": directAtFirebaseAi,
      absFirebaseApp,
      absFirebaseAppCheck,
    },
  };
}
