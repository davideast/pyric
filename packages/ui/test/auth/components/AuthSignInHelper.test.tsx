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
import { render, cleanup, fireEvent } from '@testing-library/react';
import { AuthSignInHelper } from '../../../src/auth/index.js';
import type { HelperState, SandboxIdentity } from '../../../src/auth/index.js';

afterEach(() => cleanup());

// NOTE on text-input events under bun:test + JSDOM: typing into a
// controlled input does not fire React 19's onChange in this environment
// (documented in test/firestore/components/DocumentEditor.test.tsx; the
// native-value-setter workaround was re-verified and also doesn't reach
// React). Clicks and form submits DO work, so these tests drive the form
// through the `initialValues` prefill prop + submit/click, and the
// validation matrix is covered exhaustively in test/auth/claims.

// The component is a pure function of `state` + callbacks, so DOM tests
// use a fake state (no sandbox under JSDOM — keeps the OHM realm clean,
// same pattern as the firestore component tests). Real-controller
// integration is covered DOM-free in test/auth/hooks.
function identity(partial: Partial<SandboxIdentity> & { uid: string }): SandboxIdentity {
  return {
    email: null,
    displayName: null,
    providerId: 'password',
    isAnonymous: false,
    customClaims: {},
    ...partial,
  };
}

function openState(identities: SandboxIdentity[] = []): HelperState {
  return {
    request: { providerId: 'google.com', authType: 'signIn' },
    identities,
  };
}

const noop = () => {};

describe('<AuthSignInHelper>', () => {
  it('renders nothing while no request is in flight', () => {
    const { container } = render(
      <AuthSignInHelper
        state={{ request: null, identities: [] }}
        onPick={noop}
        onAdd={noop}
        onCancel={noop}
      />,
    );
    expect(container.querySelector('[data-pyric-ui="auth-signin-helper"]')).toBeNull();
  });

  it('opens with provider mapping in the default title + data attrs', () => {
    const { container } = render(
      <AuthSignInHelper state={openState()} onPick={noop} onAdd={noop} onCancel={noop} />,
    );
    const root = container.querySelector('[data-pyric-ui="auth-signin-helper"]') as HTMLElement;
    expect(root).not.toBeNull();
    expect(root.getAttribute('data-pyric-provider-id')).toBe('google.com');
    expect(root.getAttribute('data-pyric-auth-type')).toBe('signIn');
    expect(
      (container.querySelector('[data-pyric-helper-title]') as HTMLElement).textContent,
    ).toBe('Sign in with Google');
  });

  it('lists identities and picks by uid', () => {
    const onPick = mock(noop);
    const ids = [
      identity({ uid: 'u1', email: 'a@example.com', displayName: 'Alice' }),
      identity({ uid: 'u2', email: 'b@example.com' }),
    ];
    const { container } = render(
      <AuthSignInHelper state={openState(ids)} onPick={onPick} onAdd={noop} onCancel={noop} />,
    );
    const entries = Array.from(container.querySelectorAll('[data-pyric-account-entry]'));
    expect(entries.length).toBe(2);
    expect(entries[0]!.getAttribute('data-pyric-account-uid')).toBe('u1');
    fireEvent.click(entries[1]!.querySelector('[data-pyric-account-pick]')!);
    expect(onPick).toHaveBeenCalledWith('u2');
  });

  it('hides the account list when there are no identities', () => {
    const { container } = render(
      <AuthSignInHelper state={openState()} onPick={noop} onAdd={noop} onCancel={noop} />,
    );
    expect(container.querySelector('[data-pyric-account-list]')).toBeNull();
  });

  it('renderAccount slot replaces the default row content', () => {
    const ids = [identity({ uid: 'u1', email: 'a@example.com' })];
    const { container } = render(
      <AuthSignInHelper
        state={openState(ids)}
        onPick={noop}
        onAdd={noop}
        onCancel={noop}
        renderAccount={(id) => <em data-custom-row>{id.uid.toUpperCase()}</em>}
      />,
    );
    const row = container.querySelector('[data-custom-row]') as HTMLElement;
    expect(row.textContent).toBe('U1');
    expect(container.querySelector('[data-pyric-account-name]')).toBeNull();
  });

  it('submits the add-account form with parsed claims and resets fields', () => {
    const onAdd = mock(noop);
    const { container } = render(
      <AuthSignInHelper
        state={openState()}
        onPick={noop}
        onAdd={onAdd}
        onCancel={noop}
        initialValues={{
          email: ' new@example.com ',
          displayName: 'New User',
          claims: '{"role":"admin"}',
        }}
      />,
    );
    const email = container.querySelector('[data-pyric-field="email"]') as HTMLInputElement;
    const claims = container.querySelector('[data-pyric-field="claims"]') as HTMLTextAreaElement;
    // JSDOM sanitizes type=email values (strips whitespace); the component
    // also trims before calling onAdd.
    expect(email.value).toBe('new@example.com');
    fireEvent.submit(container.querySelector('[data-pyric-add-account-form]')!);
    expect(onAdd).toHaveBeenCalledWith({
      email: 'new@example.com',
      displayName: 'New User',
      customClaims: { role: 'admin' },
    });
    expect(email.value).toBe('');
    expect(claims.value).toBe('');
  });

  it('submit button is disabled while the email is empty', () => {
    const { container } = render(
      <AuthSignInHelper state={openState()} onPick={noop} onAdd={noop} onCancel={noop} />,
    );
    expect(
      (container.querySelector('[data-pyric-submit]') as HTMLButtonElement).disabled,
    ).toBe(true);
    cleanup();
    const { container: withEmail } = render(
      <AuthSignInHelper
        state={openState()}
        onPick={noop}
        onAdd={noop}
        onCancel={noop}
        initialValues={{ email: 'x@example.com' }}
      />,
    );
    expect(
      (withEmail.querySelector('[data-pyric-submit]') as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('invalid claims JSON blocks submit and shows the emulator message', () => {
    const onAdd = mock(noop);
    const { container } = render(
      <AuthSignInHelper
        state={openState()}
        onPick={noop}
        onAdd={onAdd}
        onCancel={noop}
        initialValues={{ email: 'x@example.com', claims: '{not json' }}
      />,
    );
    const claims = container.querySelector('[data-pyric-field="claims"]') as HTMLTextAreaElement;
    fireEvent.submit(container.querySelector('[data-pyric-add-account-form]')!);
    expect(onAdd).not.toHaveBeenCalled();
    const error = container.querySelector('[data-pyric-claims-error]') as HTMLElement;
    expect(error.textContent).toBe('Custom claims must be a valid JSON object');
    expect(claims.hasAttribute('data-pyric-claims-invalid')).toBe(true);
    expect(claims.getAttribute('aria-invalid')).toBe('true');
  });

  it('forbidden claim key surfaces its message', () => {
    const { container } = render(
      <AuthSignInHelper
        state={openState()}
        onPick={noop}
        onAdd={noop}
        onCancel={noop}
        initialValues={{ email: 'x@example.com', claims: '{"sub":"123"}' }}
      />,
    );
    fireEvent.submit(container.querySelector('[data-pyric-add-account-form]')!);
    expect(
      (container.querySelector('[data-pyric-claims-error]') as HTMLElement).textContent,
    ).toBe('Custom claims must not have forbidden key: sub');
  });

  it('cancel fires onCancel and resets the form', () => {
    const onCancel = mock(noop);
    const { container } = render(
      <AuthSignInHelper
        state={openState()}
        onPick={noop}
        onAdd={noop}
        onCancel={onCancel}
        initialValues={{ email: 'x@example.com' }}
      />,
    );
    const email = container.querySelector('[data-pyric-field="email"]') as HTMLInputElement;
    expect(email.value).toBe('x@example.com');
    fireEvent.click(container.querySelector('[data-pyric-cancel]')!);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(email.value).toBe('');
  });

  it('unknown provider id falls back to the raw id', () => {
    const state: HelperState = {
      request: { providerId: 'custom.example.com', authType: 'signIn' },
      identities: [],
    };
    const { container } = render(
      <AuthSignInHelper state={state} onPick={noop} onAdd={noop} onCancel={noop} />,
    );
    expect(
      (container.querySelector('[data-pyric-helper-title]') as HTMLElement).textContent,
    ).toBe('Sign in with custom.example.com');
  });
});
