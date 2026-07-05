/**
 * The `<dialog>` shell over {@link ServeAuthHelper} — pyric serve's analog
 * of the Auth emulator's sign-in widget. Pure-DOM (no framework): renders an
 * account picker + an add-account form (email, display name, custom-claims
 * JSON — emulator parity, `customAttributes`), opens when a popup/redirect
 * request parks in the helper, closes on settle. Backdrop/Escape cancel →
 * `auth/popup-closed-by-user` via the core.
 *
 * Verified through the scripted browser gate (the bun suite covers the core;
 * this file is intentionally view-only).
 */
import type { ServeAuthHelper } from './auth-helper-core.js';

const PROVIDER_LABEL: Record<string, string> = {
  'google.com': 'Google',
  'facebook.com': 'Facebook',
  'github.com': 'GitHub',
  'apple.com': 'Apple',
};

const STYLE = `
  dialog[data-pyric-auth] { border: 1px solid #2a2a35; border-radius: 12px; background: #16161d;
    color: #e8e8ee; font: 14px/1.45 system-ui, sans-serif; padding: 20px; width: min(420px, 92vw); }
  dialog[data-pyric-auth]::backdrop { background: rgb(0 0 0 / 0.6); }
  dialog[data-pyric-auth] h2 { margin: 0 0 4px; font-size: 16px; }
  dialog[data-pyric-auth] p { margin: 0 0 14px; font-size: 12px; color: #9a9aa8; }
  dialog[data-pyric-auth] .ids { display: grid; gap: 8px; margin-bottom: 14px; }
  dialog[data-pyric-auth] .ids button { display: flex; gap: 10px; align-items: center; text-align: left;
    padding: 8px 10px; border: 1px solid #2a2a35; border-radius: 8px; background: none; color: inherit; cursor: pointer; }
  dialog[data-pyric-auth] .ids button:hover { border-color: #4a4a5a; background: rgb(255 255 255 / 0.05); }
  dialog[data-pyric-auth] form { display: grid; gap: 8px; border-top: 1px solid #2a2a35; padding-top: 14px; }
  dialog[data-pyric-auth] input, dialog[data-pyric-auth] textarea { background: none; color: inherit;
    border: 1px solid #2a2a35; border-radius: 8px; padding: 8px 10px; font: inherit; }
  dialog[data-pyric-auth] textarea { font-family: ui-monospace, monospace; font-size: 12px; }
  dialog[data-pyric-auth] .row { display: flex; justify-content: flex-end; gap: 8px; margin-top: 6px; }
  dialog[data-pyric-auth] .row button { padding: 8px 14px; border-radius: 8px; border: none; cursor: pointer; font: inherit; }
  dialog[data-pyric-auth] .cancel { background: none; color: #9a9aa8; }
  dialog[data-pyric-auth] .submit { background: #5b5bd6; color: white; }
  dialog[data-pyric-auth] .err { color: #ff6b6b; font-size: 12px; }
`;

export function mountAuthHelperDialog(helper: ServeAuthHelper): void {
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);

  const dialog = document.createElement('dialog');
  dialog.setAttribute('data-pyric-auth', '');
  document.body.appendChild(dialog);

  // <dialog> cancel (Escape) + backdrop click → cancel the flow.
  dialog.addEventListener('cancel', () => helper.cancel());
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) helper.cancel(); // backdrop only
  });

  const render = (): void => {
    const snap = helper.snapshot();
    if (!snap.request) {
      if (dialog.open) dialog.close();
      return;
    }
    const provider = PROVIDER_LABEL[snap.request.providerId] ?? snap.request.providerId;
    dialog.replaceChildren();

    const h2 = document.createElement('h2');
    h2.textContent = `Sign in with ${provider}`;
    const p = document.createElement('p');
    p.textContent =
      'pyric serve sign-in helper — pick a test account or add one. Custom claims let rules using request.auth.token.* run against this identity.';
    dialog.append(h2, p);

    if (snap.identities.length > 0) {
      const ids = document.createElement('div');
      ids.className = 'ids';
      for (const id of snap.identities) {
        const btn = document.createElement('button');
        btn.type = 'button';
        const label = id.displayName || id.email || id.uid;
        btn.textContent = id.email && id.displayName ? `${label} — ${id.email}` : label;
        btn.addEventListener('click', () => helper.pick(id.uid));
        ids.appendChild(btn);
      }
      dialog.appendChild(ids);
    }

    const form = document.createElement('form');
    form.method = 'dialog';
    const email = document.createElement('input');
    email.type = 'email';
    email.placeholder = 'email@example.com';
    email.required = true;
    const name = document.createElement('input');
    name.type = 'text';
    name.placeholder = 'Display name (optional)';
    const claims = document.createElement('textarea');
    claims.rows = 3;
    claims.placeholder = 'Custom claims JSON (optional)\ne.g. { "admin": true }';
    const err = document.createElement('div');
    err.className = 'err';
    const row = document.createElement('div');
    row.className = 'row';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'cancel';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => helper.cancel());
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'submit';
    submit.textContent = 'Sign in';
    row.append(cancel, submit);
    form.append(email, name, claims, err, row);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      let parsed: Record<string, unknown> | undefined;
      if (claims.value.trim()) {
        try {
          parsed = JSON.parse(claims.value) as Record<string, unknown>;
        } catch {
          err.textContent = 'Custom claims must be valid JSON.';
          return;
        }
      }
      helper.add({ email: email.value.trim(), displayName: name.value.trim() || undefined, customClaims: parsed });
    });
    dialog.appendChild(form);

    if (!dialog.open) dialog.showModal();
  };

  helper.subscribe(render);
  render();
}
