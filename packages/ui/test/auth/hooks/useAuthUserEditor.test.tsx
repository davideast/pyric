/** `useAuthUserEditor` — reducer-backed add/edit state machine. */
import { describe, test, expect } from 'bun:test';
import { act } from 'react-test-renderer';
import type { AuthUserRecord } from 'pyric/auth';
import { renderHook } from '../../helpers/render-hook.js';
import { useAuthUserEditor } from '../../../src/auth/hooks/index.js';

function record(partial: Partial<AuthUserRecord> = {}): AuthUserRecord {
  return {
    uid: 'u1',
    email: 'a@example.com',
    displayName: 'Alice',
    phoneNumber: null,
    photoUrl: null,
    customClaims: { role: 'admin' },
    providerUserInfo: [{ providerId: 'password' }],
    isAnonymous: false,
    disabled: false,
    emailVerified: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastLoginAt: null,
    ...partial,
  };
}

describe('useAuthUserEditor', () => {
  test('create mode starts pristine, empty and valid', () => {
    const { result, unmount } = renderHook(() => useAuthUserEditor());
    expect(result.current.fields.email).toBe('');
    expect(result.current.isDirty).toBe(false);
    expect(result.current.isValid).toBe(true);
    expect(result.current.errors).toEqual({});
    unmount();
  });

  test('edit mode hydrates fields from the record (claims pretty-printed)', () => {
    const { result, unmount } = renderHook(() => useAuthUserEditor({ initial: record() }));
    expect(result.current.fields.email).toBe('a@example.com');
    expect(result.current.fields.displayName).toBe('Alice');
    expect(result.current.fields.emailVerified).toBe(true);
    expect(JSON.parse(result.current.fields.claimsText)).toEqual({ role: 'admin' });
    expect(result.current.isDirty).toBe(false);
    unmount();
  });

  test('setField marks dirty; reset returns to initial', () => {
    const { result, unmount } = renderHook(() => useAuthUserEditor({ initial: record() }));
    act(() => result.current.setField('displayName', 'Bob'));
    expect(result.current.fields.displayName).toBe('Bob');
    expect(result.current.isDirty).toBe(true);
    act(() => result.current.reset());
    expect(result.current.fields.displayName).toBe('Alice');
    expect(result.current.isDirty).toBe(false);
    unmount();
  });

  test('validation: bad email, short password, password-without-email, bad claims', () => {
    const { result, unmount } = renderHook(() => useAuthUserEditor());
    act(() => result.current.setField('email', 'not-an-email'));
    expect(result.current.errors.email).toBe('Invalid email');
    expect(result.current.isValid).toBe(false);

    act(() => result.current.setField('email', 'ok@example.com'));
    act(() => result.current.setField('password', 'abc'));
    expect(result.current.errors.password).toBe('Password should be at least 6 characters');

    act(() => result.current.setField('email', ''));
    act(() => result.current.setField('password', 'abcdef'));
    expect(result.current.errors.password).toBe('Email is required for password authentication');

    act(() => result.current.setField('email', 'ok@example.com'));
    act(() => result.current.setField('claimsText', '{"sub":1}'));
    expect(result.current.errors.claims).toBe('Custom claims must not have forbidden key: sub');

    act(() => result.current.setField('claimsText', '{"role":"x"}'));
    expect(result.current.errors).toEqual({});
    expect(result.current.isValid).toBe(true);
    unmount();
  });

  test('toCreateRequest emits non-empty fields + parsed claims', () => {
    const { result, unmount } = renderHook(() => useAuthUserEditor());
    act(() => {
      result.current.setField('email', ' new@example.com ');
      result.current.setField('password', 'secret1');
      result.current.setField('displayName', 'New');
      result.current.setField('claimsText', '{"admin":true}');
      result.current.setField('emailVerified', true);
    });
    expect(result.current.toCreateRequest()).toEqual({
      email: 'new@example.com',
      password: 'secret1',
      displayName: 'New',
      customClaims: { admin: true },
      emailVerified: true,
      disabled: false,
    });
    unmount();
  });

  test('toUpdateRequest emits only the changed fields; cleared displayName → null', () => {
    const { result, unmount } = renderHook(() => useAuthUserEditor({ initial: record() }));
    act(() => {
      result.current.setField('displayName', '');
      result.current.setField('disabled', true);
    });
    expect(result.current.toUpdateRequest()).toEqual({
      displayName: null,
      disabled: true,
    });
    unmount();
  });

  test('claims edit surfaces in toUpdateRequest as a full replacement map', () => {
    const { result, unmount } = renderHook(() => useAuthUserEditor({ initial: record() }));
    act(() => result.current.setField('claimsText', '{"role":"viewer"}'));
    expect(result.current.toUpdateRequest()).toEqual({ customClaims: { role: 'viewer' } });
    // clearing the textarea replaces with {} (setCustomUserClaims semantics)
    act(() => result.current.setField('claimsText', ''));
    expect(result.current.toUpdateRequest()).toEqual({ customClaims: {} });
    unmount();
  });
});
