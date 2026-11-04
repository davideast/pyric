/**
 * The import map a page gets from the Node host the `pyric-live` command
 * starts. The host serves the project's Hosting pages so the chip and Studio
 * can show live traffic, but it serves those pages no Firebase SDK: live
 * mode gives a page the app's own installed SDK only through Vite
 * (`@pyric/live/vite`). Each served `firebase/*` specifier resolves to a
 * module that throws, so a page there never reaches the sandbox under a
 * "Live" line.
 */
import { importMapFirebaseEntries } from './firebase-module-swap.js';

/** The `code` of the error a page on the live host gets for a Firebase import. */
const LIVE_HOST_PAGE_REFUSED = 'PYRIC_LIVE_REFUSED';

/** The message a page on the live host gets for importing `specifier`. */
function liveHostPageRefusalMessage(specifier: string): string {
  return (
    `${specifier} is not served to pages of the pyric-live host. Live mode gives a page your installed ` +
    'Firebase SDK through Vite: add pyricLive() from @pyric/live/vite to your Vite config and open the page Vite serves.'
  );
}

function refusalModule(specifier: string): string {
  const message = JSON.stringify(liveHostPageRefusalMessage(specifier));
  const source = `const e=new Error(${message});e.code=${JSON.stringify(LIVE_HOST_PAGE_REFUSED)};throw e;`;
  return `data:text/javascript,${encodeURIComponent(source)}`;
}

/** Every served Firebase specifier, mapped to a module that throws its refusal. */
export function liveHostPageImportMap(): Record<string, string> {
  const imports: Record<string, string> = {};
  for (const specifier of importMapFirebaseEntries('sandbox').keys()) imports[specifier] = refusalModule(specifier);
  return imports;
}
