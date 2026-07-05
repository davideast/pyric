// Install JSDOM globals before importing React or RTL.
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { pretendToBeVisual: true });
const g = globalThis as any;
g.window = dom.window;
g.document = dom.window.document;
g.HTMLElement = dom.window.HTMLElement;
g.Element = dom.window.Element;
g.Node = dom.window.Node;
g.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
g.IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, describe, it, expect, mock } from 'bun:test';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { AuthUserRecord } from 'pyric/auth';
import { ConfirmProvider } from '../../../src/primitives/index.js';
import { DeleteUserWithConfirm, ClearUsersWithConfirm } from '../../../src/auth/index.js';

afterEach(() => cleanup());

function user(partial: Partial<AuthUserRecord> = {}): AuthUserRecord {
  return {
    uid: 'u1',
    email: 'a@example.com',
    displayName: null,
    phoneNumber: null,
    photoUrl: null,
    customClaims: {},
    providerUserInfo: [{ providerId: 'password' }],
    isAnonymous: false,
    disabled: false,
    emailVerified: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastLoginAt: null,
    ...partial,
  };
}

// The ConfirmDialog portals into document.body — query there.
const dialog = () => document.body.querySelector('[data-pyric-ui="confirm-dialog"]');

describe('<DeleteUserWithConfirm>', () => {
  it('confirming deletes; the dialog names the identifier', async () => {
    const onDelete = mock(() => {});
    const { container } = render(
      <ConfirmProvider>
        <DeleteUserWithConfirm user={user()} onDelete={onDelete} />
      </ConfirmProvider>,
    );
    fireEvent.click(container.querySelector('[data-pyric-ui="delete-user"]')!);
    await waitFor(() => expect(dialog()).not.toBeNull());
    expect(dialog()!.textContent).toContain('a@example.com');
    fireEvent.click(document.body.querySelector('[data-pyric-confirm-confirm]')!);
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith('u1'));
  });

  it('cancelling does not delete', async () => {
    const onDelete = mock(() => {});
    const { container } = render(
      <ConfirmProvider>
        <DeleteUserWithConfirm user={user()} onDelete={onDelete} />
      </ConfirmProvider>,
    );
    fireEvent.click(container.querySelector('[data-pyric-ui="delete-user"]')!);
    await waitFor(() => expect(dialog()).not.toBeNull());
    fireEvent.click(document.body.querySelector('[data-pyric-confirm-cancel]')!);
    await waitFor(() => expect(dialog()).toBeNull());
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('renderTrigger overrides the default button', () => {
    const { container } = render(
      <ConfirmProvider>
        <DeleteUserWithConfirm
          user={user()}
          onDelete={() => {}}
          renderTrigger={({ onClick }) => (
            <a data-custom-trigger onClick={onClick}>
              zap
            </a>
          )}
        />
      </ConfirmProvider>,
    );
    expect(container.querySelector('[data-pyric-ui="delete-user"]')).toBeNull();
    expect(container.querySelector('[data-custom-trigger]')).not.toBeNull();
  });
});

describe('<ClearUsersWithConfirm>', () => {
  it('confirming clears; default body interpolates the count', async () => {
    const onClear = mock(() => {});
    const { container } = render(
      <ConfirmProvider>
        <ClearUsersWithConfirm onClear={onClear} count={7} />
      </ConfirmProvider>,
    );
    fireEvent.click(container.querySelector('[data-pyric-ui="clear-users"]')!);
    await waitFor(() => expect(dialog()).not.toBeNull());
    expect(dialog()!.textContent).toContain('all 7 users');
    fireEvent.click(document.body.querySelector('[data-pyric-confirm-confirm]')!);
    await waitFor(() => expect(onClear).toHaveBeenCalledTimes(1));
  });
});
