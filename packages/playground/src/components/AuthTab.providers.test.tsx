/**
 * Sign-in providers section of the Auth tab's add/edit form (owner ask:
 * "the playground's Firebase → Auth tab must support configuring a
 * user's OAuth providers", same capability Studio's `ProvidersEditor`
 * has). Two things worth pinning down:
 *
 *   - LIST DERIVATION: the checklist is `FEDERATED_PROVIDER_IDS` from
 *     `pyric/auth`, not a hardcoded copy — so it stays correct if the
 *     canonical set ever changes.
 *   - PAYLOAD CONSTRUCTION: `toggleProviderId` is the pure add/remove
 *     step behind every checkbox; `useAuthUserEditor`'s
 *     `toCreateRequest` / `toUpdateRequest` (tested in `@pyric/ui`)
 *     take it from there onto `providerUserInfo`.
 *
 * Same idiom as `AutosaveStatus.render.test.tsx`: `renderToString`,
 * no DOM runner — this repo's test setup has no jsdom/happy-dom, so
 * render assertions check markup, not simulated clicks.
 */
import { describe, test, expect } from 'bun:test';
import { renderToString } from 'react-dom/server';
import { FEDERATED_PROVIDER_IDS } from 'pyric/auth';
import { ProvidersField, toggleProviderId } from './AuthTab';

describe('toggleProviderId', () => {
  test('checking a provider adds its id', () => {
    expect(toggleProviderId([], 'google.com', true)).toEqual(['google.com']);
    expect(toggleProviderId(['google.com'], 'github.com', true)).toEqual([
      'google.com',
      'github.com',
    ]);
  });

  test('unchecking a provider removes its id', () => {
    expect(toggleProviderId(['google.com', 'github.com'], 'google.com', false)).toEqual([
      'github.com',
    ]);
  });

  test('checking an already-selected id is a no-op (no duplicate)', () => {
    expect(toggleProviderId(['google.com'], 'google.com', true)).toEqual(['google.com']);
  });

  test('unchecking an id that is not selected is a no-op', () => {
    expect(toggleProviderId(['google.com'], 'github.com', false)).toEqual(['google.com']);
  });
});

describe('ProvidersField list derivation', () => {
  test('renders one checkbox per FEDERATED_PROVIDER_IDS entry, with the raw id visible', () => {
    const html = renderToString(
      <ProvidersField
        selected={[]}
        onChange={() => {}}
        hasPassword={false}
        isAnonymous={false}
      />,
    );
    expect(FEDERATED_PROVIDER_IDS.length).toBeGreaterThan(0);
    for (const id of FEDERATED_PROVIDER_IDS) {
      expect(html).toContain(id);
    }
    // 'anonymous' and 'password' are credential-derived, never in the
    // canonical federated set — the checklist must not offer them.
    expect(FEDERATED_PROVIDER_IDS).not.toContain('password');
    expect(FEDERATED_PROVIDER_IDS).not.toContain('anonymous');
  });

  test('pre-checks providers already linked on the record (edit mode)', () => {
    const html = renderToString(
      <ProvidersField
        selected={['google.com', 'github.com']}
        onChange={() => {}}
        hasPassword={false}
        isAnonymous={false}
      />,
    );
    // Grab the google.com row and confirm its checkbox is checked, the
    // yahoo.com row's is not — a plain "checked" substring count would
    // pass even if the wrong box were checked.
    const googleRow = html.slice(html.indexOf('google.com') - 200, html.indexOf('google.com'));
    expect(googleRow).toContain('checked=""');
    const yahooRow = html.slice(html.indexOf('yahoo.com') - 200, html.indexOf('yahoo.com'));
    expect(yahooRow).not.toContain('checked=""');
  });

  test('password-linked note appears only when hasPassword is set', () => {
    const withPassword = renderToString(
      <ProvidersField selected={[]} onChange={() => {}} hasPassword isAnonymous={false} />,
    );
    expect(withPassword).toContain('Password is linked');

    const withoutPassword = renderToString(
      <ProvidersField selected={[]} onChange={() => {}} hasPassword={false} isAnonymous={false} />,
    );
    expect(withoutPassword).not.toContain('Password is linked');
  });

  test('anonymous note appears only when isAnonymous is set', () => {
    const anon = renderToString(
      <ProvidersField selected={[]} onChange={() => {}} hasPassword={false} isAnonymous />,
    );
    expect(anon).toContain('Anonymous');

    const notAnon = renderToString(
      <ProvidersField selected={[]} onChange={() => {}} hasPassword={false} isAnonymous={false} />,
    );
    expect(notAnon).not.toContain('Anonymous');
  });
});
