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
import type { AuthUserRecord } from 'pyric/auth';
import { AuthUserForm, ClaimsField } from '../../../src/auth/index.js';

afterEach(() => cleanup());

// NOTE: typed text-input coverage lives in the useAuthUserEditor hook
// tests (typing doesn't reach React 19 onChange under bun:test + JSDOM —
// see DocumentEditor.test.tsx). These DOM tests drive checkboxes (which
// DO fire), record hydration, submit and cancel.
function record(partial: Partial<AuthUserRecord> = {}): AuthUserRecord {
  return {
    uid: 'u1',
    email: 'a@example.com',
    displayName: 'Alice',
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

describe('<AuthUserForm>', () => {
  it('every field is wrapped in a label with addressable visible text (styling hook)', () => {
    const { container } = render(<AuthUserForm initial={record()} onSubmit={() => {}} />);
    // The PR-#598 gap: labeled grid layouts must be reachable by CSS alone.
    // Each field lives inside label[data-pyric-field-label="<name>"] with a
    // span[data-pyric-label-text]; field errors render inside the wrapper.
    for (const name of [
      'email', 'password', 'display-name', 'phone-number', 'photo-url',
      'email-verified', 'disabled',
    ]) {
      const wrapper = container.querySelector(`label[data-pyric-field-label="${name}"]`);
      expect(wrapper).not.toBeNull();
      expect(wrapper!.querySelector(`[data-pyric-field="${name}"]`)).not.toBeNull();
      expect(wrapper!.querySelector('[data-pyric-label-text]')!.textContent!.length)
        .toBeGreaterThan(0);
    }
    // Wrapping <label> associates the control — the visible text is the
    // accessible name (no aria-label duplication).
    const email = container.querySelector('[data-pyric-field="email"]') as HTMLInputElement;
    expect(email.closest('label')!.textContent).toContain('Email');
  });

  it('renderField slot overrides layout per field while inputs stay wired', () => {
    const onSubmit = mock(() => {});
    const { container } = render(
      <AuthUserForm
        initial={record({ email: 'not-an-email' })}
        onSubmit={onSubmit}
        renderField={(f) =>
          f.name === 'email' ? (
            // Full custom layout for one field: own wrapper, label placement,
            // error threaded through the slot context.
            <div data-testid="custom-email" data-kind={f.kind}>
              <h4>{f.label}</h4>
              {f.input}
              {f.error != null && <em data-testid="custom-error">{f.error}</em>}
            </div>
          ) : (
            // Stock layout for everything else.
            f.defaultRender()
          )
        }
      />,
    );
    // The custom wrapper replaced the default one for email only.
    const custom = container.querySelector('[data-testid="custom-email"]') as HTMLElement;
    expect(custom).not.toBeNull();
    expect(custom.getAttribute('data-kind')).toBe('text');
    expect(container.querySelector('label[data-pyric-field-label="email"]')).toBeNull();
    expect(container.querySelector('label[data-pyric-field-label="password"]')).not.toBeNull();
    // Slot input is the controlled one (hydrated from editor state), and the
    // validation error threads through f.error into the custom markup.
    const email = custom.querySelector('[data-pyric-field="email"]') as HTMLInputElement;
    expect(email.value).toBe('not-an-email');
    expect(
      (custom.querySelector('[data-testid="custom-error"]') as HTMLElement).textContent,
    ).toBe('Invalid email');
    // Interaction through a slot-rendered checkbox still drives the editor:
    // dirty flips on, but the form stays invalid (bad email) and won't submit.
    fireEvent.click(container.querySelector('[data-pyric-field="email-verified"]')!);
    const form = container.querySelector('[data-pyric-ui="auth-user-form"]') as HTMLElement;
    expect(form.hasAttribute('data-pyric-is-dirty')).toBe(true);
    expect(form.hasAttribute('data-pyric-is-valid')).toBe(false);
    fireEvent.submit(form);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('create mode: pristine empty form is submittable and emits defaults', () => {
    const onSubmit = mock(() => {});
    const { container } = render(<AuthUserForm onSubmit={onSubmit} />);
    const form = container.querySelector('[data-pyric-ui="auth-user-form"]') as HTMLElement;
    expect(form.getAttribute('data-pyric-mode')).toBe('create');
    expect(form.hasAttribute('data-pyric-is-valid')).toBe(true);
    expect(
      (container.querySelector('[data-pyric-submit]') as HTMLButtonElement).disabled,
    ).toBe(false);
    fireEvent.submit(form);
    expect(onSubmit).toHaveBeenCalledWith({
      mode: 'create',
      request: { emailVerified: false, disabled: false },
    });
  });

  it('create mode: provider checklist enumerates the sandbox federated set', () => {
    const { container } = render(<AuthUserForm onSubmit={() => {}} />);
    const group = container.querySelector('fieldset[data-pyric-field-label="providers"]');
    expect(group).not.toBeNull();
    const options = Array.from(
      group!.querySelectorAll('[data-pyric-provider-option]'),
    ).map((el) => el.getAttribute('data-pyric-provider-option'));
    // Mechanically derived from pyric/auth's FEDERATED_PROVIDER_IDS.
    expect(options).toEqual([
      'google.com',
      'apple.com',
      'facebook.com',
      'github.com',
      'twitter.com',
      'microsoft.com',
      'yahoo.com',
    ]);
  });

  it('create mode: checked providers land on the create payload as providerUserInfo', () => {
    const onSubmit = mock(() => {});
    const { container } = render(<AuthUserForm onSubmit={onSubmit} />);
    const check = (id: string) =>
      fireEvent.click(
        container.querySelector(
          `[data-pyric-provider-option="${id}"] input`,
        ) as HTMLInputElement,
      );
    check('google.com');
    check('github.com');
    const form = container.querySelector('[data-pyric-ui="auth-user-form"]') as HTMLElement;
    fireEvent.submit(form);
    expect(onSubmit).toHaveBeenCalledWith({
      mode: 'create',
      request: {
        emailVerified: false,
        disabled: false,
        providerUserInfo: [{ providerId: 'google.com' }, { providerId: 'github.com' }],
      },
    });
    // Unchecking removes the entry (and an empty selection omits the field).
    check('google.com');
    check('github.com');
    fireEvent.submit(form);
    expect(onSubmit).toHaveBeenLastCalledWith({
      mode: 'create',
      request: { emailVerified: false, disabled: false },
    });
  });

  it('edit mode: no provider checklist (linked providers are a consumer affordance)', () => {
    const { container } = render(<AuthUserForm initial={record()} onSubmit={() => {}} />);
    expect(container.querySelector('[data-pyric-field-label="providers"]')).toBeNull();
    expect(container.querySelector('[data-pyric-provider-checklist]')).toBeNull();
  });

  it('edit mode: hydrates fields, submit disabled while pristine', () => {
    const { container } = render(<AuthUserForm initial={record()} onSubmit={() => {}} />);
    const form = container.querySelector('[data-pyric-ui="auth-user-form"]') as HTMLElement;
    expect(form.getAttribute('data-pyric-mode')).toBe('edit');
    expect(
      (container.querySelector('[data-pyric-field="email"]') as HTMLInputElement).value,
    ).toBe('a@example.com');
    expect(
      (container.querySelector('[data-pyric-submit]') as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('edit mode: checkbox toggle marks dirty and emits a delta payload', () => {
    const onSubmit = mock(() => {});
    const { container } = render(<AuthUserForm initial={record()} onSubmit={onSubmit} />);
    const disabled = container.querySelector('[data-pyric-field="disabled"]') as HTMLInputElement;
    fireEvent.click(disabled);
    const form = container.querySelector('[data-pyric-ui="auth-user-form"]') as HTMLElement;
    expect(form.hasAttribute('data-pyric-is-dirty')).toBe(true);
    const submit = container.querySelector('[data-pyric-submit]') as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    fireEvent.submit(form);
    expect(onSubmit).toHaveBeenCalledWith({
      mode: 'edit',
      uid: 'u1',
      request: { disabled: true },
    });
  });

  it('invalid hydrated email surfaces the emulator message and blocks submit', () => {
    const onSubmit = mock(() => {});
    const { container } = render(
      <AuthUserForm initial={record({ email: 'not-an-email' })} onSubmit={onSubmit} />,
    );
    expect(
      (container.querySelector('[data-pyric-field-error="email"]') as HTMLElement).textContent,
    ).toBe('Invalid email');
    // make it dirty via a checkbox; still not submittable because invalid
    fireEvent.click(container.querySelector('[data-pyric-field="email-verified"]')!);
    const form = container.querySelector('[data-pyric-ui="auth-user-form"]') as HTMLElement;
    expect(form.hasAttribute('data-pyric-is-valid')).toBe(false);
    fireEvent.submit(form);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('renders the claims field and the cancel button fires onCancel', () => {
    const onCancel = mock(() => {});
    const { container } = render(
      <AuthUserForm onSubmit={() => {}} onCancel={onCancel} />,
    );
    expect(container.querySelector('[data-pyric-ui="claims-field"]')).not.toBeNull();
    fireEvent.click(container.querySelector('[data-pyric-cancel]')!);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('<ClaimsField>', () => {
  it('renders value, error alert and invalid markers', () => {
    const { container } = render(
      <ClaimsField
        value='{"sub":1}'
        onChange={() => {}}
        error="Custom claims must not have forbidden key: sub"
        hint="usable in rules"
      />,
    );
    const textarea = container.querySelector('[data-pyric-field="claims"]') as HTMLTextAreaElement;
    expect(textarea.value).toBe('{"sub":1}');
    expect(textarea.hasAttribute('data-pyric-claims-invalid')).toBe(true);
    expect(
      (container.querySelector('[data-pyric-claims-error]') as HTMLElement).textContent,
    ).toBe('Custom claims must not have forbidden key: sub');
    expect(
      (container.querySelector('[data-pyric-claims-hint]') as HTMLElement).textContent,
    ).toBe('usable in rules');
  });
});
