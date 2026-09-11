/**
 * The chip's Theme dialog: the overlay's custom properties, as text a
 * developer can edit while the page is painting.
 *
 * The dialog is the third of the overlay theme's entry points, next to the
 * served page's option and the page's own stored overrides. It shows the
 * overrides in effect, or the whole contract when there are none, so the
 * developer can see every property there is to set. Apply parses the text,
 * keeps it in the page's storage, and hands it to the painting now. Reset
 * takes the stored overrides away and goes back to what the page was served
 * with.
 *
 * Unknown property names are not an error: the theme keeps them out when it
 * resolves, so a stale name in the text changes nothing.
 */
import {
  clearStoredOverlayTheme,
  OVERLAY_THEME_DEFAULTS,
  parseOverlayTheme,
  writeStoredOverlayTheme,
  type OverlayTheme,
  type OverlayThemeStorage,
} from './overlay-theme.js';

export interface ChipThemeDialogOptions {
  shadowRoot: ShadowRoot;
  /** The overrides in effect, for the text the dialog opens with. */
  readTheme: () => OverlayTheme;
  /** Draw with these overrides now. `null` goes back to the served page's. */
  applyTheme: (theme: OverlayTheme | null) => void;
  /** Where the overrides are kept. */
  storage: OverlayThemeStorage | null;
}

export interface ChipThemeDialogController {
  element: HTMLDialogElement;
  open(triggerElement?: HTMLElement): void;
  close(): void;
  dispose(): void;
}

export const THEME_DIALOG_STYLES = `
  .theme-dialog:not([open]) { display: none !important; }
  .theme-dialog {
    all: initial; position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
    margin: 0; padding: 0; border: 1px solid var(--pyric-border, #33333f); border-radius: 12px;
    background: var(--pyric-content, #16161a); color: var(--pyric-text, #fbfbfe);
    font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 13px; line-height: 1.45; box-shadow: 0 16px 40px rgba(0, 0, 0, 0.6);
    width: min(440px, 92vw); overflow: hidden; z-index: 2147483647;
  }
  .theme-dialog::backdrop { background: rgba(0, 0, 0, 0.65); backdrop-filter: blur(2px); }
  .theme-dialog-panel { display: flex; flex-direction: column; gap: 10px; padding: 20px; box-sizing: border-box; }
  .theme-dialog header { display: flex; align-items: center; justify-content: space-between; }
  .theme-dialog h2 { margin: 0; font-size: 14px; font-weight: 600; letter-spacing: -0.01em; }
  .theme-hint { color: var(--pyric-muted, #89899f); font-size: 11px; margin: 0; }
  .theme-input {
    all: initial; box-sizing: border-box; width: 100%; height: 220px; resize: vertical;
    background: #121215; border: 1px solid var(--pyric-border-soft, #2a2a35); border-radius: 6px;
    color: var(--pyric-text, #fbfbfe); font-family: "JetBrains Mono", ui-monospace, monospace;
    font-size: 11px; line-height: 1.5; padding: 8px 10px; white-space: pre;
  }
  .theme-input:focus { border-color: #4a4a58; }
  .theme-error { color: var(--pyric-error, #f0a0a0); font-family: "JetBrains Mono", ui-monospace, monospace; font-size: 10px; margin: 0; }
  .theme-footer { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
  .theme-footer .button {
    align-items: center; appearance: none; background: #24242c; border: 1px solid #2a2a35;
    border-radius: 6px; color: #fbfbfe; cursor: pointer; display: inline-flex;
    font-family: "JetBrains Mono", ui-monospace, monospace; font-size: 11px; justify-content: center;
    letter-spacing: .04em; min-height: 32px; min-width: 96px; padding: 6px 14px;
    text-transform: uppercase; box-sizing: border-box;
  }
  .theme-footer .button:hover { border-color: #3a3a48; background: #2a2a34; color: #ffffff; }
`;

/** The text the dialog opens with: the overrides, or the whole contract. */
export function themeDialogText(theme: OverlayTheme): string {
  const shown = Object.keys(theme).length > 0 ? theme : OVERLAY_THEME_DEFAULTS;
  return JSON.stringify(shown, null, 2);
}

/** Build the Theme dialog in the chip's shadow root. */
export function createChipThemeDialog(
  options: ChipThemeDialogOptions,
): ChipThemeDialogController {
  const { shadowRoot, readTheme, applyTheme, storage } = options;
  const dialog = shadowRoot.ownerDocument.createElement('dialog');
  dialog.className = 'theme-dialog';
  dialog.setAttribute('data-overlay-theme-dialog', '');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-labelledby', 'dialog-theme-title');
  dialog.innerHTML = `
    <div class="theme-dialog-panel">
      <header>
        <h2 id="dialog-theme-title">Overlay theme</h2>
        <button type="button" class="dialog-close" data-close-theme aria-label="Close dialog">✕</button>
      </header>
      <p class="theme-hint">Custom properties for the painted boxes. Names outside the contract are ignored.</p>
      <textarea class="theme-input" data-theme-input spellcheck="false" aria-label="Overlay theme JSON"></textarea>
      <p class="theme-error" data-theme-error hidden></p>
      <footer class="theme-footer">
        <button type="button" class="button" data-theme-reset>Reset</button>
        <button type="button" class="button" data-theme-apply>Apply</button>
      </footer>
    </div>
  `;
  shadowRoot.appendChild(dialog);

  const input = dialog.querySelector<HTMLTextAreaElement>('[data-theme-input]')!;
  const error = dialog.querySelector<HTMLElement>('[data-theme-error]')!;
  const closeButton = dialog.querySelector<HTMLButtonElement>('[data-close-theme]')!;
  const applyButton = dialog.querySelector<HTMLButtonElement>('[data-theme-apply]')!;
  const resetButton = dialog.querySelector<HTMLButtonElement>('[data-theme-reset]')!;
  let trigger: HTMLElement | null = null;

  const showError = (message: string | null): void => {
    if (message === null) {
      error.textContent = '';
      error.hidden = true;
      return;
    }
    error.textContent = message;
    error.hidden = false;
  };

  const close = (): void => {
    if (dialog.open) {
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
    }
    if (trigger !== null && typeof trigger.focus === 'function' && trigger.isConnected) {
      trigger.focus();
    }
  };

  closeButton.addEventListener('click', () => close());
  dialog.addEventListener('cancel', (event: Event) => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener('click', (event: MouseEvent) => {
    if (event.target === dialog) close();
  });
  dialog.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    close();
  });

  applyButton.addEventListener('click', () => {
    const theme = parseOverlayTheme(input.value);
    if (theme === null) {
      showError('That is not a JSON object of property name to value.');
      return;
    }
    showError(null);
    writeStoredOverlayTheme(storage, theme);
    applyTheme(theme);
    close();
  });

  resetButton.addEventListener('click', () => {
    showError(null);
    clearStoredOverlayTheme(storage);
    applyTheme(null);
    input.value = themeDialogText(readTheme());
  });

  return {
    element: dialog,
    open(triggerElement) {
      if (triggerElement !== undefined) trigger = triggerElement;
      showError(null);
      input.value = themeDialogText(readTheme());
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
      if (typeof input.focus === 'function') input.focus();
    },
    close,
    dispose() {
      dialog.remove();
    },
  };
}
