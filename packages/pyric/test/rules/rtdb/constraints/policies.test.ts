import { describe, test, expect } from 'bun:test';
import { POLICY_SPECS } from '../../../../src/rules/rtdb/constraints/policies.spec.js';
import {
  pathOwnerOnly, fieldOwnerOnly, ownerOrNew,
  hasRole, isMember, required, transition,
} from '../../../../src/rules/rtdb/constraints/policies.js';

describe('Policies', () => {
  test('pathOwnerOnly($uid)', () => {
    expect(pathOwnerOnly('$uid')).toBe(POLICY_SPECS.pathOwnerOnly.output);
  });

  test('fieldOwnerOnly(author)', () => {
    expect(fieldOwnerOnly('author')).toBe(POLICY_SPECS.fieldOwnerOnly.output);
  });

  test('ownerOrNew(author)', () => {
    expect(ownerOrNew('author')).toBe(POLICY_SPECS.ownerOrNew.output);
  });

  test('hasRole(admin)', () => {
    expect(hasRole(['users', { $: 'auth.uid' }, 'role'], 'admin')).toBe(POLICY_SPECS.hasRole.output);
  });

  test('isMember(team-members, teamId)', () => {
    expect(isMember('team-members', 'teamId')).toBe(POLICY_SPECS.isMember.output);
  });

  test('required(name, email)', () => {
    expect(required('name', 'email')).toBe(POLICY_SPECS.required.output);
  });

  test('transition(status, open→playing, open→cancelled)', () => {
    expect(transition('status', [['open', 'playing'], ['open', 'cancelled']])).toBe(POLICY_SPECS.transition.output);
  });

  // Reusability
  test('pathOwnerOnly with different var', () => {
    expect(pathOwnerOnly('$memberId')).toBe('auth != null && auth.uid == $memberId');
  });

  test('required with single field', () => {
    expect(required('title')).toBe("newData.hasChildren(['title'])");
  });

  test('required groups single keys in hasChildren and checks each nested path with hasChild', () => {
    expect(required('puck/x', 'puck/y', 'score')).toBe(
      "newData.hasChildren(['score']) && newData.hasChild('puck/x') && newData.hasChild('puck/y')",
    );
    expect(required('puck/x')).toBe("newData.hasChild('puck/x')");
  });

  test('required refuses a key segment RTDB cannot hold', () => {
    expect(() => required('a.b')).toThrow(/required: 'a.b' is not a field name/);
    expect(() => required('puck/$x')).toThrow(/required: '\$x' is not a field name/);
    expect(() => required('puck//x')).toThrow(/required: '' is not a field name/);
    expect(() => required('')).toThrow(/required: '' is not a field name/);
  });

  test('transition with single allowed transition', () => {
    expect(transition('phase', [['draft', 'published']])).toBe(
      "data.child('phase').val() == 'draft' && newData.child('phase').val() == 'published'",
    );
  });
});
