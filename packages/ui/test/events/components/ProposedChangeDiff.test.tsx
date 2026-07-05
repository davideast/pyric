// Install JSDOM globals before importing React or RTL.
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  pretendToBeVisual: true,
});
const g = globalThis as any;
g.window = dom.window;
g.document = dom.window.document;
g.HTMLElement = dom.window.HTMLElement;
g.Element = dom.window.Element;
g.Node = dom.window.Node;
g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
g.IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, describe, it, expect } from 'bun:test';
import { render, cleanup } from '@testing-library/react';
import {
  ProposedChangeDiff,
  type FieldChange,
  type CreatedAuthUser,
} from '../../../src/events/components/ProposedChangeDiff.js';

afterEach(cleanup);

const CHANGES: FieldChange[] = [
  {
    docPath: 'users/alice-uid',
    field: '(document)',
    before: undefined,
    after: { email: 'a@x.dev' },
    kind: 'added',
  },
];
const AUTH: CreatedAuthUser[] = [
  { uid: 'alice-uid', email: 'alice@x.dev', displayName: 'Alice', emailVerified: true },
  { uid: 'bob-uid', email: 'bob@x.dev' },
];

describe('ProposedChangeDiff - auth users group', () => {
  it('renders a leading auth-users group with a row + summary per user', () => {
    const { container } = render(<ProposedChangeDiff changes={CHANGES} authUsers={AUTH} />);
    const authGroup = container.querySelector('[data-pyric-change-authgroup]');
    expect(authGroup).not.toBeNull();
    expect(authGroup?.querySelector('[data-pyric-change-count]')?.textContent).toBe('2');
    const rows = authGroup!.querySelectorAll('[data-pyric-change-authuser]');
    expect(rows.length).toBe(2);
    expect(rows[0]!.querySelector('[data-pyric-change-docid]')?.textContent).toBe('alice-uid');
    const meta = rows[0]!.querySelector('[data-pyric-change-authmeta]')?.textContent ?? '';
    expect(meta).toContain('alice@x.dev');
    expect(meta).toContain('Alice');
    expect(meta).toContain('verified');
    // bob is unverified: no "verified" token
    expect(rows[1]!.querySelector('[data-pyric-change-authmeta]')?.textContent).not.toContain(
      'verified',
    );
  });

  it('renders the auth group BEFORE the collection groups', () => {
    const { container } = render(<ProposedChangeDiff changes={CHANGES} authUsers={AUTH} />);
    const groups = [...container.querySelectorAll('[data-pyric-change-group]')];
    expect(groups.length).toBe(2); // auth users + the `users` collection
    expect(groups[0]!.getAttribute('data-pyric-change-collection')).toBe('auth users');
  });

  it('shows the empty state only when BOTH changes and authUsers are empty', () => {
    const empty = render(
      <ProposedChangeDiff changes={[]} authUsers={[]} emptyState={<p>nothing</p>} />,
    );
    expect(empty.container.textContent).toContain('nothing');
    cleanup();
    const authOnly = render(
      <ProposedChangeDiff changes={[]} authUsers={AUTH} emptyState={<p>nothing</p>} />,
    );
    expect(authOnly.container.textContent ?? '').not.toContain('nothing');
    expect(authOnly.container.querySelector('[data-pyric-change-authgroup]')).not.toBeNull();
  });
});
