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
import { AuthUserList } from '../../../src/auth/index.js';

afterEach(() => cleanup());

function user(partial: Partial<AuthUserRecord> & { uid: string }): AuthUserRecord {
  return {
    email: null,
    displayName: null,
    phoneNumber: null,
    photoUrl: null,
    customClaims: {},
    providerUserInfo: [{ providerId: 'password' }],
    isAnonymous: false,
    disabled: false,
    emailVerified: false,
    createdAt: '2026-01-02T03:04:05.000Z',
    lastLoginAt: null,
    ...partial,
  };
}

describe('<AuthUserList>', () => {
  it('renders the emulator column headers', () => {
    const { container } = render(<AuthUserList users={[user({ uid: 'u1' })]} />);
    const headers = Array.from(container.querySelectorAll('[role="columnheader"]')).map(
      (h) => h.textContent,
    );
    expect(headers).toEqual(['Identifier', 'Provider', 'Created', 'Signed In', 'User UID']);
  });

  it('adds the actions column only when renderActions is provided', () => {
    const { container } = render(
      <AuthUserList
        users={[user({ uid: 'u1' })]}
        renderActions={(u) => <button data-row-action>{u.uid}</button>}
      />,
    );
    expect(container.querySelectorAll('[role="columnheader"]').length).toBe(6);
    expect(
      (container.querySelector('[data-row-action]') as HTMLElement).textContent,
    ).toBe('u1');
  });

  it('renders one row per user with identifier fallbacks + provider labels', () => {
    const users = [
      user({ uid: 'u1', email: 'a@example.com', providerUserInfo: [{ providerId: 'google.com' }] }),
      user({ uid: 'u2', phoneNumber: '+15551234567', providerUserInfo: [{ providerId: 'phone' }] }),
      user({ uid: 'u3', isAnonymous: true, providerUserInfo: [] }),
    ];
    const { container } = render(<AuthUserList users={users} />);
    const rows = Array.from(container.querySelectorAll('[data-pyric-user-entry]'));
    expect(rows.length).toBe(3);
    const identifiers = rows.map(
      (r) => r.querySelector('[data-pyric-user-cell="identifier"]')!.textContent,
    );
    expect(identifiers).toEqual(['a@example.com', '+15551234567', 'anonymous']);
    expect(
      rows[0]!.querySelector('[data-pyric-provider-id="google.com"]')!.textContent,
    ).toBe('Google');
    expect(
      rows[2]!.querySelector('[data-pyric-provider-id="anonymous"]')!.textContent,
    ).toBe('Anonymous');
  });

  it('formats created/signed-in; em dash for never-signed-in; uid cell', () => {
    const { container } = render(
      <AuthUserList
        users={[user({ uid: 'u1', lastLoginAt: null })]}
        formatDate={(iso) => (iso ? 'formatted' : 'never')}
      />,
    );
    const entry = container.querySelector('[data-pyric-user-entry]')!;
    expect(entry.querySelector('[data-pyric-user-cell="created"]')!.textContent).toBe('formatted');
    expect(entry.querySelector('[data-pyric-user-cell="signed-in"]')!.textContent).toBe('never');
    expect(entry.querySelector('[data-pyric-user-cell="uid"]')!.textContent).toBe('u1');
  });

  it('marks disabled users for dimmed styling', () => {
    const { container } = render(
      <AuthUserList users={[user({ uid: 'u1', disabled: true }), user({ uid: 'u2' })]} />,
    );
    const rows = Array.from(container.querySelectorAll('[data-pyric-user-entry]'));
    expect(rows[0]!.hasAttribute('data-pyric-user-disabled')).toBe(true);
    expect(rows[1]!.hasAttribute('data-pyric-user-disabled')).toBe(false);
  });

  it('onSelect renders the identifier as a button and fires with the record', () => {
    const onSelect = mock(() => {});
    const u = user({ uid: 'u1', email: 'a@example.com' });
    const { container } = render(<AuthUserList users={[u]} onSelect={onSelect} />);
    fireEvent.click(container.querySelector('[data-pyric-user-select]')!);
    expect(onSelect).toHaveBeenCalledWith(u);
  });

  it('zero state: no users at all', () => {
    const { container } = render(<AuthUserList users={[]} />);
    const root = container.querySelector('[data-pyric-ui="auth-user-list"]') as HTMLElement;
    expect(root.hasAttribute('data-pyric-empty')).toBe(true);
    expect(root.hasAttribute('data-pyric-no-results')).toBe(false);
    expect(root.textContent).toBe('No users for this project yet');
  });

  it('zero state: no results for the active filter', () => {
    const { container } = render(<AuthUserList users={[]} filter="nobody" />);
    const root = container.querySelector('[data-pyric-ui="auth-user-list"]') as HTMLElement;
    expect(root.hasAttribute('data-pyric-no-results')).toBe(true);
    expect(root.textContent).toBe('No results');
  });

  it('custom empty/no-results states render', () => {
    const { container: c1 } = render(<AuthUserList users={[]} emptyState={<p>none yet</p>} />);
    expect(c1.textContent).toBe('none yet');
    cleanup();
    const { container: c2 } = render(
      <AuthUserList users={[]} filter="x" noResultsState={<p>nothing matches</p>} />,
    );
    expect(c2.textContent).toBe('nothing matches');
  });

  it('loading and error states', () => {
    const { container: c1 } = render(<AuthUserList users={[]} isLoading />);
    expect(
      (c1.querySelector('[data-pyric-ui="auth-user-list"]') as HTMLElement).hasAttribute(
        'data-pyric-loading',
      ),
    ).toBe(true);
    cleanup();
    const { container: c2 } = render(<AuthUserList users={[]} error={new Error('boom')} />);
    const root = c2.querySelector('[data-pyric-ui="auth-user-list"]') as HTMLElement;
    expect(root.getAttribute('role')).toBe('alert');
    expect(root.textContent).toBe('boom');
  });

  it('virtualizes above the threshold', () => {
    const many = Array.from({ length: 12 }, (_, i) => user({ uid: `u${i}` }));
    const { container } = render(
      <AuthUserList users={many} virtualizeThreshold={10} virtualizedHeight={400} />,
    );
    const root = container.querySelector('[data-pyric-ui="auth-user-list"]') as HTMLElement;
    expect(root.hasAttribute('data-pyric-virtualized')).toBe(true);
    expect(container.querySelector('[data-pyric-user-rows]')).toBeNull();
  });

  it('stays a plain rowgroup below the threshold', () => {
    const few = Array.from({ length: 5 }, (_, i) => user({ uid: `u${i}` }));
    const { container } = render(<AuthUserList users={few} virtualizeThreshold={10} />);
    const root = container.querySelector('[data-pyric-ui="auth-user-list"]') as HTMLElement;
    expect(root.hasAttribute('data-pyric-virtualized')).toBe(false);
    expect(container.querySelectorAll('[data-pyric-user-rows] [data-pyric-user-entry]').length).toBe(5);
  });
});
