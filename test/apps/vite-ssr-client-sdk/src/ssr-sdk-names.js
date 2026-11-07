// A server entry the scenario builds with `vite build --ssr` and
// `ssr.noExternal: true`, then runs under `pyric sandbox` (#1756). The dev
// server also loads it as a server-rendered module and answers with its
// `outcomes` (#2345). It imports
// Firebase SDKs by names other than `firebase` and `firebase-admin`: two
// `@firebase/*` packages directly, and firebase-admin under an npm alias.
// Each import is its own `import()`, so each one's outcome shows.
const loads = {
  "@firebase/app": () => import("@firebase/app"),
  "@firebase/firestore": () => import("@firebase/firestore"),
  "admin-alias/app": () => import("admin-alias/app"),
};

export const outcomes = {};
for (const [name, load] of Object.entries(loads)) {
  try {
    const loaded = await load();
    outcomes[name] = { ok: true, value: Object.keys(loaded).length > 0 };
  } catch (error) {
    outcomes[name] = { ok: false, code: error?.code ?? null, message: String(error?.message ?? error) };
  }
}
console.log(`sdk-names ${JSON.stringify(outcomes)}`);
