/**
 * `/__pyric/sdk/init.js` — the script tag `pyric dev` injects into every
 * served HTML page. Pulls the shared runtime chunk (sandbox + init payload +
 * rules deploy) and mounts the sign-in helper, so the page backend AND the
 * popup/redirect experience exist even before — or without — the app
 * importing any `firebase/*` module. Also the P3 hot-reload anchor.
 */
import { sandbox } from './runtime.js';
import { ServeAuthHelper } from './auth-helper-core.js';
import { mountAuthHelperDialog } from './auth-helper-dom.js';

const helper = new ServeAuthHelper(sandbox);
helper.install();
mountAuthHelperDialog(helper);

export {};
