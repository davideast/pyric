// A page whose Firebase config adds `measurementId` to the one server
// rendering uses, as an app with Analytics in the browser does. The host
// serves one config, and SSR sent its config first, so this page's calls
// are refused and server rendering keeps working.
import { initializeApp } from "firebase/app";
import { getDatabase, ref, set } from "firebase/database";
import { config } from "./config.js";

const app = initializeApp({ ...config, measurementId: "G-TEST123" });

window.measured = {
  async write() {
    try {
      await set(ref(getDatabase(app), "ssr/measured"), { from: "measured page" });
      return { ok: true };
    } catch (error) {
      return { ok: false, code: error?.code ?? null, message: String(error?.message ?? error) };
    }
  },
};
