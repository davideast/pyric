// A page whose Firebase config differs from the one server rendering uses.
// `?variant=measurement` adds measurementId, as an app with Analytics in the
// browser does: it picks no backend data, so the host accepts the page.
// `?variant=bucket` names another storage bucket: SSR sent its config first,
// so this page is the one refused, and server rendering keeps working.
import { initializeApp } from "firebase/app";
import { getDatabase, ref, set } from "firebase/database";
import { config } from "./config.js";

const variant = new URLSearchParams(location.search).get("variant");
const variants = {
  measurement: { ...config, measurementId: "G-TEST123" },
  bucket: { ...config, storageBucket: "other-bucket.appspot.com" },
};
const app = initializeApp(variants[variant]);

window.measured = {
  async write() {
    try {
      await set(ref(getDatabase(app), `ssr/${variant}`), { from: `${variant} page` });
      return { ok: true };
    } catch (error) {
      return { ok: false, code: error?.code ?? null, message: String(error?.message ?? error) };
    }
  },
};
