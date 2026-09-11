import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'bun:test';
import { createListenerMode } from '../../../src/serve/runtime/listener-mode.js';
import {
  createChipThemeDialog,
  themeDialogText,
} from '../../../src/serve/runtime/chip-theme-dialog.js';
import {
  applyOverlayTheme,
  OVERLAY_THEME_DEFAULTS,
  OVERLAY_THEME_KEY,
  OVERLAY_THEME_VARIABLES,
  resolveOverlayTheme,
} from '../../../src/serve/runtime/overlay-theme.js';
import type { SandboxEvent } from 'pyric/sandbox';

function page(): { doc: Document; window: JSDOM['window'] } {
  const dom = new JSDOM('<!doctype html><body><div id="todos"></div></body>', {
    url: 'http://localhost/',
  });
  return { doc: dom.window.document, window: dom.window };
}

/** A storage this test drives, standing in for the page's `localStorage`. */
function memoryStorage(initial: Record<string, string> = {}) {
  const entries = new Map(Object.entries(initial));
  return {
    entries,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
    removeItem: (key: string) => {
      entries.delete(key);
    },
  };
}

const attach: SandboxEvent = {
  kind: 'listener_attach',
  id: 'e1',
  at: 1,
  listenerId: 'l1',
  target: { kind: 'query', collection: 'todos' },
  auth: { uid: null, token: null },
  owners: [{ kind: 'tag', name: 'TodoList', element: '#todos' }],
} as unknown as SandboxEvent;

function mode(options: {
  doc: Document;
  overlayTheme?: Record<string, string> | null;
  themeStorage?: ReturnType<typeof memoryStorage> | null;
}) {
  let push: (events: readonly SandboxEvent[]) => void = () => {};
  const listenerMode = createListenerMode({
    document: options.doc,
    subscribeEvents: (callback) => {
      push = callback;
      return () => {};
    },
    attributionEnabled: () => true,
    incidents: () => [],
    paintStorage: null,
    commits: {
      available: () => false,
      reason: () => 'no React',
      subscribe: () => () => {},
      dispose: () => {},
    },
    themeStorage: options.themeStorage ?? null,
    overlayTheme: options.overlayTheme ?? null,
  });
  listenerMode.setEnabled(true);
  push([attach]);
  const container = options.doc.querySelector<HTMLElement>('[data-pyric-listener-overlay]')!;
  return { listenerMode, container };
}

describe('the theme contract', () => {
  it('names a default for every variable it exports', () => {
    expect(OVERLAY_THEME_VARIABLES.length).toBeGreaterThan(0);
    for (const name of OVERLAY_THEME_VARIABLES) {
      expect(name.startsWith('--pyric-')).toBe(true);
      expect(typeof OVERLAY_THEME_DEFAULTS[name]).toBe('string');
    }
    expect(OVERLAY_THEME_DEFAULTS['--pyric-hue-0']).toBe('hsl(146 72% 52%)');
  });

  it('takes a known override and ignores everything else', () => {
    const resolved = resolveOverlayTheme({
      '--pyric-overlay-radius': '0px',
      '--not-a-pyric-variable': 'red',
    });
    expect(resolved['--pyric-overlay-radius']).toBe('0px');
    expect(resolved['--not-a-pyric-variable']).toBe(undefined);
  });

  it('leaves a property the theme empties unset, so the stylesheet falls back', () => {
    const { doc } = page();
    const container = doc.createElement('div');
    applyOverlayTheme(container, { '--pyric-overlay-badge-fg': '#ffffff' });
    expect(container.style.getPropertyValue('--pyric-overlay-badge-fg')).toBe('#ffffff');
    applyOverlayTheme(container, null);
    expect(container.style.getPropertyValue('--pyric-overlay-badge-fg')).toBe('');
    expect(container.style.getPropertyValue('--pyric-overlay-radius')).toBe('4px');
  });
});

describe('the three ways a theme reaches the container', () => {
  it('puts the contract on the container when nothing overrides it', () => {
    const { doc } = page();
    const painted = mode({ doc });
    expect(painted.container.style.getPropertyValue('--pyric-overlay-radius')).toBe('4px');
    painted.listenerMode.dispose();
  });

  it('takes the option the served page passed', () => {
    const { doc } = page();
    const painted = mode({ doc, overlayTheme: { '--pyric-overlay-radius': '0px' } });
    expect(painted.container.style.getPropertyValue('--pyric-overlay-radius')).toBe('0px');
    painted.listenerMode.dispose();
  });

  it('lets the stored overrides win over the served option', () => {
    const { doc } = page();
    const painted = mode({
      doc,
      overlayTheme: { '--pyric-overlay-radius': '0px', '--pyric-overlay-badge-font-size': '8px' },
      themeStorage: memoryStorage({
        [OVERLAY_THEME_KEY]: JSON.stringify({ '--pyric-overlay-radius': '12px' }),
      }),
    });
    expect(painted.container.style.getPropertyValue('--pyric-overlay-radius')).toBe('12px');
    expect(painted.container.style.getPropertyValue('--pyric-overlay-badge-font-size')).toBe('8px');
    painted.listenerMode.dispose();
  });

  it('ignores a stored name that is not part of the contract', () => {
    const { doc } = page();
    const painted = mode({
      doc,
      themeStorage: memoryStorage({
        [OVERLAY_THEME_KEY]: JSON.stringify({ '--not-a-pyric-variable': 'red' }),
      }),
    });
    expect(painted.container.style.getPropertyValue('--not-a-pyric-variable')).toBe('');
    painted.listenerMode.dispose();
  });

  it('survives storage that throws and unreadable JSON', () => {
    const { doc } = page();
    const painted = mode({
      doc,
      themeStorage: {
        entries: new Map(),
        getItem: () => 'not json',
        setItem: () => {},
        removeItem: () => {},
      } as unknown as ReturnType<typeof memoryStorage>,
    });
    expect(painted.container.style.getPropertyValue('--pyric-overlay-radius')).toBe('4px');
    painted.listenerMode.dispose();
  });

  it('applies a write from another tab when the storage event arrives', () => {
    const { doc, window } = page();
    const storage = memoryStorage();
    const painted = mode({ doc, themeStorage: storage });
    expect(painted.container.style.getPropertyValue('--pyric-overlay-radius')).toBe('4px');

    storage.setItem(OVERLAY_THEME_KEY, JSON.stringify({ '--pyric-overlay-radius': '20px' }));
    const event = new window.Event('storage') as Event & { key: string | null };
    Object.defineProperty(event, 'key', { value: OVERLAY_THEME_KEY });
    window.dispatchEvent(event);

    expect(painted.container.style.getPropertyValue('--pyric-overlay-radius')).toBe('20px');
    painted.listenerMode.dispose();
  });
});

describe('the Theme dialog', () => {
  function dialogPage() {
    const { doc } = page();
    const storage = memoryStorage();
    const painted = mode({ doc, themeStorage: storage });
    const host = doc.createElement('div');
    doc.body.append(host);
    const shadowRoot = host.attachShadow({ mode: 'open' });
    const dialog = createChipThemeDialog({
      shadowRoot,
      storage,
      readTheme: () => painted.listenerMode.overlayTheme(),
      applyTheme: (theme) => painted.listenerMode.setOverlayTheme(theme),
    });
    const input = dialog.element.querySelector<HTMLTextAreaElement>('[data-theme-input]')!;
    const apply = dialog.element.querySelector<HTMLButtonElement>('[data-theme-apply]')!;
    const reset = dialog.element.querySelector<HTMLButtonElement>('[data-theme-reset]')!;
    return { painted, storage, dialog, input, apply, reset };
  }

  it('opens on the whole contract when nothing is overridden', () => {
    const text = themeDialogText({});
    expect(JSON.parse(text)['--pyric-overlay-radius']).toBe('4px');
    expect(JSON.parse(themeDialogText({ '--pyric-overlay-radius': '9px' }))).toEqual({
      '--pyric-overlay-radius': '9px',
    });
  });

  it('keeps what Apply was given and paints with it now', () => {
    const helper = dialogPage();
    helper.dialog.open();
    helper.input.value = JSON.stringify({ '--pyric-overlay-radius': '16px' });
    helper.apply.click();

    expect(helper.painted.container.style.getPropertyValue('--pyric-overlay-radius')).toBe('16px');
    expect(helper.storage.entries.get(OVERLAY_THEME_KEY)).toContain('16px');
    helper.painted.listenerMode.dispose();
  });

  it('says so rather than throwing when the text is not a theme', () => {
    const helper = dialogPage();
    helper.dialog.open();
    helper.input.value = '{ not json';
    helper.apply.click();

    const error = helper.dialog.element.querySelector<HTMLElement>('[data-theme-error]')!;
    expect(error.hidden).toBe(false);
    expect(helper.storage.entries.has(OVERLAY_THEME_KEY)).toBe(false);
    helper.painted.listenerMode.dispose();
  });

  it('takes the overrides away on Reset', () => {
    const helper = dialogPage();
    helper.dialog.open();
    helper.input.value = JSON.stringify({ '--pyric-overlay-radius': '16px' });
    helper.apply.click();
    helper.reset.click();

    expect(helper.painted.container.style.getPropertyValue('--pyric-overlay-radius')).toBe('4px');
    expect(helper.storage.entries.has(OVERLAY_THEME_KEY)).toBe(false);
    helper.painted.listenerMode.dispose();
  });
});
