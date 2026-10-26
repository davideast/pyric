import { pyric } from "@pyric/cli/vite";
import { VitePWA } from "vite-plugin-pwa";

export default {
  plugins: [
    pyric({ hosted: true, serviceWorker: "src/sw.js" }),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.js",
      injectRegister: false,
      manifest: false,
      injectManifest: { injectionPoint: undefined },
      devOptions: { enabled: true, type: "module" },
    }),
  ],
};
