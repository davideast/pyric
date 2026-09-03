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
    expect(pathOwnerOnly('$memberId')).toBe('(auth != null) && (auth.uid == $memberId)');
  });

  test('required with single field', () => {
    expect(required('title')).toBe('(newData.hasChild("title"))');
  });

  test('transition with single allowed transition', () => {
    expect(transition('phase', [['draft', 'published']])).toBe(
      '((data.child("phase").val() == "draft") && (newData.child("phase").val() == "published"))',
    );
  });
});
