import { JSDOM } from 'jsdom';
import 'fake-indexeddb/auto';

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/auth',
});
const g = globalThis as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
g.navigator = dom.window.navigator;
g.HTMLElement = dom.window.HTMLElement;
g.HTMLInputElement = dom.window.HTMLInputElement;
g.HTMLSelectElement = dom.window.HTMLSelectElement;
g.HTMLButtonElement = dom.window.HTMLButtonElement;
g.SVGElement = dom.window.SVGElement;
g.Element = dom.window.Element;
g.Node = dom.window.Node;
g.EventTarget = dom.window.EventTarget;
g.Event = dom.window.Event;
g.MouseEvent = dom.window.MouseEvent;
g.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
(dom.window.HTMLElement.prototype as unknown as Record<string, unknown>).attachEvent = () => {};
(dom.window.HTMLElement.prototype as unknown as Record<string, unknown>).detachEvent = () => {};
g.IS_REACT_ACT_ENVIRONMENT = true;

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, render, waitFor } from '@testing-library/react';
import { initializeSandbox } from 'pyric/sandbox';
import { getAuth, sandbox as authSandbox } from 'pyric/auth';
import { getStorageSandbox, ref, uploadBytes } from 'pyric/storage';
import { AuthSurface } from '../../../src/features/auth/AuthSurface.js';
import { LiveStoragePane } from '../../../src/features/data/StoragePane.js';
import { EnvironmentProvider } from '../../../src/shell/environment.js';

const STUDIO_ROOT = join(import.meta.dir, '../../..');

const OPEN_STORAGE_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{path=**} { allow read, write: if true; }
  }
}`;

afterEach(() => {
  cleanup();
});

describe('Studio 768 px Auth and Storage responsive layout contract (#2501)', () => {
  it('ships container-query rules and minmax(0, 1fr) track bounds in both src and dist CSS', () => {
    const cssRelPaths = [
      'features/auth/auth.css',
      'features/auth/auth-editor.css',
      'features/data/storage.css',
      'features/data/storage-inspector.css',
      'features/data/data-feature.css',
    ];
    for (const rel of cssRelPaths) {
      const srcPath = join(STUDIO_ROOT, 'src', rel);
      const distPath = join(STUDIO_ROOT, 'dist', rel);
      expect(existsSync(srcPath)).toBe(true);
      if (existsSync(join(STUDIO_ROOT, 'dist'))) {
        expect(existsSync(distPath)).toBe(true);
      }
    }

    const authCss = readFileSync(join(STUDIO_ROOT, 'src/features/auth/auth.css'), 'utf8');
    expect(authCss).toContain('container-type: inline-size;');
    expect(authCss).toContain('@container (max-width: 980px)');
    expect(authCss).toContain('@container (max-width: 640px)');
    expect(authCss).toContain('grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr);');

    const storageCss = readFileSync(join(STUDIO_ROOT, 'src/features/data/storage.css'), 'utf8');
    expect(storageCss).toContain('container-type: inline-size;');
    expect(storageCss).toContain('@container (max-width: 960px)');
    expect(storageCss).toContain('@container (max-width: 640px)');
    expect(storageCss).toContain('.storage__lhead span:nth-of-type(n + 3)');
  });

  it('renders AuthSurface user list and LiveStoragePane header spans aligned to the 2-column compact rule', async () => {
    const sb = initializeSandbox();
    const auth = getAuth(sb);
    authSandbox.createUser(auth, {
      uid: 'alice-768',
      email: 'alice.long.address@example.com',
      providerUserInfo: [{ providerId: 'google.com' }],
    });
    authSandbox.createUser(auth, {
      uid: 'bob-768',
      email: 'bob@example.com',
    });

    const authView = render(
      <EnvironmentProvider mode="local">
        <AuthSurface auth={auth} />
      </EnvironmentProvider>,
    );
    await waitFor(() => {
      expect(authView.container.querySelectorAll('[data-pyric-user-entry]').length).toBe(2);
    });
    expect(authView.container.querySelector('.auth-surface')).not.toBeNull();
    expect(authView.container.querySelector('.auth-list')).not.toBeNull();

    const storage = getStorageSandbox(sb, {
      dbName: `pyric-studio-768-${Math.random().toString(36).slice(2, 10)}`,
      rules: OPEN_STORAGE_RULES,
    });
    await uploadBytes(ref(storage, 'avatars/alice.png'), new Uint8Array([1, 2, 3]), {
      contentType: 'image/png',
    });

    window.history.replaceState(null, '', '/storage/avatars?kind=prefix');
    const storageView = render(
      <LiveStoragePane storage={storage} focusTarget={{ kind: 'prefix', path: 'avatars' }} />,
    );
    await waitFor(() => {
      expect(
        storageView.container.querySelector('[data-pyric-entry-path="avatars/alice.png"]'),
      ).not.toBeNull();
    });

    // Ensure .storage__lhead has <label> followed by 4 <span> column headers so
    // `span:nth-of-type(n + 3)` hides only `size` and `updated`, keeping `name` and `type`.
    const headerSpans = Array.from(
      storageView.container.querySelectorAll('.storage__lhead > span'),
    ).map((el) => el.textContent);
    expect(headerSpans).toEqual(['name', 'type', 'size', 'updated']);
  });
});
