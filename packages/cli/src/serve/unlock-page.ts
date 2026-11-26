/**
 * HTML renderer for `/__pyric/unlock`.
 *
 * Reuses Pyric's runtime panel design tokens, base component stylesheet,
 * markup primitives, and embedded Geist fonts so the pairing page matches the
 * runtime inspector while staying completely self-contained under strict CSP
 * (`default-src 'none'`).
 */
import { CHIP_FONT_DATA } from './runtime/chip-font-data.js';
import {
  barHtml,
  buttonHtml,
  escapeAttribute,
  iconHtml,
  introHtml,
  sectionHtml,
  verdictHtml,
} from './runtime/chip-markup.js';
import { PYRIC_PANEL_BASE_STYLES, PYRIC_PANEL_TOKENS } from './runtime/panel-styles.js';

function escapeInlineJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

const FONT_DATA_JSON = escapeInlineJson(CHIP_FONT_DATA);
const ICON_MARKUP_JSON = escapeInlineJson({
  eye: iconHtml('eye'),
  eyeOff: iconHtml('eye-off'),
  locked: iconHtml('password'),
  ok: iconHtml('check'),
  warning: iconHtml('warning'),
});

const UNLOCK_PAGE_STYLES = `
  :root {
${PYRIC_PANEL_TOKENS}
  }
${PYRIC_PANEL_BASE_STYLES}
  [hidden] { display: none !important; }
  body {
    margin: 0;
    min-height: 100dvh;
    display: grid;
    place-items: center;
    padding: var(--space-4);
    background: #0f1116;
    color: var(--pyric-text);
  }
  .unlock-panel {
    width: min(440px, 100%);
    max-width: 100%;
    grid-template-rows: 64px auto;
  }
  .unlock-header,
  .unlock-view,
  .unlock-panel .bar {
    scrollbar-gutter: auto;
  }
  .unlock-header {
    height: 64px;
    border-bottom: 1px solid var(--pyric-border-soft);
  }
  .unlock-header .verdict {
    width: auto;
    min-width: 84px;
    grid-template-columns: 24px minmax(0, 1fr);
  }
  .unlock-header .verdict-label {
    padding-inline: var(--space-2);
    text-align: center;
  }
  .unlock-form {
    display: grid;
    grid-template-rows: auto auto;
    min-width: 0;
  }
  .unlock-view {
    overflow: visible;
  }
  .unlock-warning {
    border-color: #695b45;
    background: #26221b;
  }
  .unlock-warning-body {
    grid-column: 2;
    grid-row: 2;
    display: grid;
    grid-template-columns: 16px minmax(0, 1fr);
    align-items: start;
    gap: var(--space-2);
    color: var(--pyric-warning);
    font-size: 12px;
    line-height: 1.45;
  }
  .unlock-warning-body > .icon {
    margin-top: 2px;
  }
  .unlock-warning-body p {
    margin: 0;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .unlock-facts > div {
    grid-template-columns: 68px minmax(0, 1fr);
  }
  .unlock-facts dd,
  .unlock-facts code {
    min-width: 0;
    overflow-wrap: anywhere;
    word-break: break-word;
    font-family: "Pyric Geist Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12px;
  }
  .unlock-field {
    grid-template-columns: 16px minmax(0, 1fr) 28px;
    gap: var(--space-2);
    padding-inline: var(--space-3) var(--space-1);
    height: 38px;
  }
  .unlock-field > .icon {
    grid-column: 1;
  }
  .unlock-field input {
    grid-column: 2;
    font-size: 12px;
  }
  .unlock-field-toggle {
    grid-column: 3;
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    border-radius: 4px;
    color: var(--pyric-muted);
    cursor: pointer;
  }
  .unlock-field-toggle:hover {
    background: #282d37;
    color: var(--pyric-text);
  }
  .unlock-field-toggle .icon {
    width: 14px;
    height: 14px;
  }
  .unlock-status {
    margin: 0 var(--record-inset);
    font-size: 12px;
    line-height: 1.45;
    color: var(--pyric-muted);
    overflow-wrap: anywhere;
  }
  .unlock-status[data-tone="error"] {
    color: var(--pyric-error);
  }
  .unlock-status[data-tone="ok"] {
    color: #a4c7b5;
  }
  .unlock-submit {
    width: auto;
    flex: 0 0 auto;
    padding-inline: var(--space-4);
    font-size: 12px;
  }
  @media (max-width: 400px) {
    :root {
      --space-3: 10px;
      --space-4: 12px;
    }
    .unlock-facts > div {
      grid-template-columns: minmax(0, 1fr);
      gap: var(--space-1);
    }
    .unlock-panel .bar {
      grid-template-columns: 0 minmax(0, 1fr) 0;
      column-gap: var(--space-4);
      row-gap: var(--space-2);
      padding-block: var(--space-3);
    }
    .unlock-panel .bar .bar-hint {
      padding-inline: var(--record-inset);
    }
    .unlock-panel .bar > .actions {
      grid-column: 2;
      justify-content: stretch;
    }
    .unlock-submit {
      width: 100%;
    }
  }
`;

function renderUnlockScript(safeNextJson: string): string {
  return `(() => {
  const nextPath = ${safeNextJson};
  const fontData = ${FONT_DATA_JSON};
  const icons = ${ICON_MARKUP_JSON};
  const hostEl = document.getElementById('host');
  const destEl = document.getElementById('dest');
  const statusEl = document.getElementById('status');
  const warnEl = document.getElementById('http-warn');
  const verdictEl = document.getElementById('session-verdict');
  const form = document.getElementById('unlock-form');
  const input = document.getElementById('token');
  const toggleBtn = document.getElementById('toggle-token');
  const submitBtn = document.getElementById('submit');

  if (typeof FontFace === 'function' && document.fonts) {
    for (const entry of fontData) {
      try {
        const raw = atob(entry.base64);
        const bytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
        const face = new FontFace(entry.family, bytes, { weight: '100 900', style: 'normal', display: 'swap' });
        document.fonts.add(face);
        void face.load().catch(() => { document.fonts.delete(face); });
      } catch {
        // System fallbacks cover environments without FontFace binary loading.
      }
    }
  }

  if (hostEl) hostEl.textContent = location.host;
  if (destEl) destEl.textContent = nextPath;
  if (warnEl && window.isSecureContext === false) warnEl.hidden = false;

  function setVerdict(state) {
    if (!verdictEl) return;
    const iconSlot = verdictEl.querySelector('.verdict-icon');
    const labelSlot = verdictEl.querySelector('.verdict-label');
    let className = 'verdict bypassed';
    let iconSvg = icons.locked;
    let label = 'Locked';
    let title = 'Session is locked';
    if (state === 'pending') {
      className = 'verdict warning';
      iconSvg = icons.locked;
      label = 'Unlocking';
      title = 'Verifying session token';
    } else if (state === 'ok') {
      className = 'verdict ok';
      iconSvg = icons.ok;
      label = 'Unlocked';
      title = 'Session unlocked';
    } else if (state === 'error') {
      className = 'verdict';
      iconSvg = icons.warning;
      label = 'Failed';
      title = 'Unlock failed';
    }
    verdictEl.className = className;
    verdictEl.title = title;
    verdictEl.setAttribute('aria-label', title);
    if (iconSlot) iconSlot.innerHTML = iconSvg;
    if (labelSlot) labelSlot.textContent = label;
  }

  function setStatus(text, tone) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.hidden = text.length === 0;
    if (tone) {
      statusEl.setAttribute('data-tone', tone);
    } else {
      statusEl.removeAttribute('data-tone');
    }
    if (input) {
      if (tone === 'error') {
        input.setAttribute('aria-invalid', 'true');
      } else {
        input.removeAttribute('aria-invalid');
      }
    }
  }

  if (input) {
    input.addEventListener('input', () => {
      if (input.getAttribute('aria-invalid') === 'true') {
        input.removeAttribute('aria-invalid');
      }
    });
  }

  if (toggleBtn && input) {
    toggleBtn.addEventListener('click', () => {
      const revealing = input.type === 'password';
      input.type = revealing ? 'text' : 'password';
      toggleBtn.setAttribute('aria-pressed', revealing ? 'true' : 'false');
      const nextLabel = revealing ? 'Hide token' : 'Show token';
      toggleBtn.setAttribute('aria-label', nextLabel);
      toggleBtn.title = nextLabel;
      toggleBtn.innerHTML = revealing ? icons.eyeOff : icons.eye;
    });
  }

  async function submitToken(token) {
    if (!token) {
      setVerdict('error');
      setStatus('Enter the session token printed in the terminal.', 'error');
      return;
    }
    if (submitBtn) submitBtn.disabled = true;
    setVerdict('pending');
    setStatus('Unlocking...', 'pending');
    try {
      const response = await fetch('/__pyric/unlock', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, next: nextPath }),
      });
      const payload = await response.json().catch(() => ({}));
      if (response.ok && payload && payload.ok === true) {
        const target = typeof payload.next === 'string' && payload.next.startsWith('/') ? payload.next : '/';
        setVerdict('ok');
        setStatus('Unlocked. Redirecting...', 'ok');
        location.replace(target);
        return;
      }
      setVerdict('error');
      if (response.status === 429) {
        const retryAfter = response.headers.get('retry-after') || '60';
        setStatus('Too many attempts. Wait ' + retryAfter + 's and retry.', 'error');
      } else if (payload && payload.message) {
        setStatus(String(payload.message), 'error');
      } else {
        setStatus('Unlock failed (' + response.status + ').', 'error');
      }
    } catch {
      setVerdict('error');
      setStatus('Network error contacting /__pyric/unlock.', 'error');
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  }

  if (form) {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void submitToken(input ? input.value.trim() : '');
    });
  }

  const rawHash = location.hash;
  if (rawHash && rawHash.length > 1) {
    const hashParams = new URLSearchParams(rawHash.slice(1));
    const fragmentCode = hashParams.get('code');
    history.replaceState(null, '', location.pathname + location.search);
    if (fragmentCode && fragmentCode.trim().length > 0) {
      void submitToken(fragmentCode.trim());
    }
  }
})();`;
}

/** Render the self-contained `/__pyric/unlock` HTML document. */
export function renderUnlockHtml(nextPath: string): string {
  const safeNextJson = escapeInlineJson(nextPath);
  const escapedNext = escapeAttribute(nextPath);
  const statusVerdict = verdictHtml({
    label: 'Locked',
    icon: 'password',
    tone: 'bypassed',
    title: 'Session is locked',
    attributes: 'id="session-verdict"',
  });
  const intro = introHtml(
    'Unlock Pyric session',
    'Paste the per-boot token printed in the server terminal to set the HttpOnly cookie for this browser.',
    '',
    'h1',
  );
  const httpWarning =
    `<div id="http-warn" class="rows unlock-warning" role="alert" hidden>` +
    `<div class="row"><div class="unlock-warning-body">${iconHtml('warning')}` +
    `<p>This origin is plain HTTP (not a secure browser context). Cookies travel in cleartext and ServiceWorker APIs are disabled; prefer HTTPS or an SSH tunnel.</p>` +
    `</div></div></div>`;
  const sessionSection = sectionHtml(
    'Session',
    `<div class="rows"><div class="row"><dl class="sandbox-ai-facts unlock-facts">` +
      `<div><dt>Host</dt><dd><code id="host"></code></dd></div>` +
      `<div><dt>Redirect</dt><dd><code id="dest">${escapedNext}</code></dd></div>` +
      `</dl></div></div>`,
  );
  const tokenField =
    `<div class="field unlock-field">` +
    `${iconHtml('password')}` +
    `<input id="token" name="token" class="mono" type="password" autocomplete="off" spellcheck="false" required autofocus placeholder="Paste token from terminal">` +
    `<button id="toggle-token" class="unlock-field-toggle" type="button" aria-label="Show token" aria-pressed="false" title="Show token">${iconHtml('eye')}</button>` +
    `</div>`;
  const tokenSection =
    `<section class="section">` +
    `<div class="section-heading"><div class="section-line">` +
    `<label class="section-title" for="token">Session token</label>` +
    `<span class="actions"><span class="section-meta">Per-boot</span></span>` +
    `</div></div>` +
    `${tokenField}` +
    `<div id="status" class="unlock-status" role="status" aria-live="polite" hidden></div>` +
    `</section>`;
  const submitButton = buttonHtml(
    'id="submit"',
    'Unlock session',
    undefined,
    { type: 'submit', className: 'btn-primary unlock-submit' },
  );
  const footerBar = barHtml([submitButton], 'HttpOnly, SameSite=Strict');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Unlock Pyric session</title>
<style>${UNLOCK_PAGE_STYLES}</style>
</head>
<body>
<main class="panel unlock-panel">
  <header class="panel-header unlock-header">
    <span class="brand"><span class="panel-name">pyric</span><span class="live-label">Remote session</span></span>
    <span class="actions">${statusVerdict}</span>
  </header>
  <form id="unlock-form" class="unlock-form" autocomplete="off">
    <div class="view unlock-view">
      <div class="view-content">
        ${intro}
        ${httpWarning}
        ${sessionSection}
        ${tokenSection}
      </div>
    </div>
    ${footerBar}
  </form>
</main>
<script>
${renderUnlockScript(safeNextJson)}
</script>
</body>
</html>
`;
}
