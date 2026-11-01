// A server-rendered module that attests with a CustomProvider, the provider a
// server process can use: it calls the token server and gets that token back.
import { initializeApp } from "firebase/app";
import { CustomProvider, getToken, initializeAppCheck } from "firebase/app-check";

export async function customToken(tokenUrl) {
  const issued = [];
  const app = initializeApp(
    {
      apiKey: "AIzaSyDemoKeyForReproOnly000000000000",
      projectId: "my-real-project",
      appId: "1:123456789012:web:abcdef0123456789",
    },
    `ssr-custom-${Date.now()}`,
  );
  const provider = new CustomProvider({
    getToken: async () => {
      const token = await (await fetch(tokenUrl)).json();
      issued.push(token.token);
      return token;
    },
  });
  const appCheck = initializeAppCheck(app, { provider, isTokenAutoRefreshEnabled: false });
  const { token } = await getToken(appCheck);
  return { providerCalls: issued.length, sameToken: token === issued[0] };
}
