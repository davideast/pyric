/**
 * Browser shim — `firebase-admin` and `firebase-admin/database` are
 * Node-only modules pulled in transitively by `@pyric/rtdb`'s top-
 * level re-export of `DataHandler` (which imports
 * `firebase-admin/database` for the user-auth code path it serves on
 * the agent / server side).
 *
 * The playground never invokes `DataHandler` from the browser — only
 * the modular surface (`getDatabase`, `ref`, `set`, `get`, …) is
 * consumed at preview time, and that surface lives under
 * `./modular.js` inside `@pyric/rtdb` (no `firebase-admin` chain).
 * The transitive import still has to *resolve* for Vite to build the
 * client bundle though, so this stub returns empty values that
 * satisfy module load. Any actual call from the client is a bug;
 * the throwing accessors below surface that loudly instead of
 * silently returning undefined.
 *
 * Wired via the `clientOnlyNodeShims` Vite plugin in
 * `astro.config.mjs` — applies on client code only. SSR builds keep
 * the real `firebase-admin` so any server-side route that needs it
 * can still resolve it.
 */
const ADMIN_BROWSER_MSG =
  'firebase-admin is not available in the browser. The playground only consumes @pyric/rtdb\'s modular surface (getDatabase, ref, set, get, …) at preview time. If you hit this, an admin code path leaked into the client bundle.';

function throwInBrowser(): never {
  throw new Error(ADMIN_BROWSER_MSG);
}

// `firebase-admin/database` — `getDatabaseWithUrl` and `getDatabase` are
// the two callable entry points `@pyric/rtdb`'s `DataHandler` references.
export function getDatabaseWithUrl(): never {
  throwInBrowser();
}
export function getDatabase(): never {
  throwInBrowser();
}

// `firebase-admin` root — `initializeApp`, `app`, `apps`, `credential`
// are common access patterns. Stubs satisfy module-load only.
export function initializeApp(): never {
  throwInBrowser();
}
export function app(): never {
  throwInBrowser();
}
export const apps: unknown[] = [];
export const credential = {
  cert: throwInBrowser,
  applicationDefault: throwInBrowser,
};

const fallback = new Proxy(
  {},
  {
    get(_t, prop) {
      if (prop === 'then') return undefined; // not a thenable
      throw new Error(`${ADMIN_BROWSER_MSG} Attempted access: ${String(prop)}`);
    },
  },
);
export default fallback;
