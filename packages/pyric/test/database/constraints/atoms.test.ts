import { describe, test, expect } from 'bun:test';
import { ATOM_SPECS } from '../../../src/database/constraints/atoms.spec.js';
import {
  authenticated, ownPath, ownField, isNew,
  hasChildren, hasChild, fieldIsString, fieldIsNumber, fieldIsBoolean, fieldEnum,
  immutable, immutableSelf,
  rootExists, rootEquals,
} from '../../../src/database/constraints/atoms.js';

describe('Constraint Atoms', () => {
  test('authenticated()', () => {
    expect(authenticated()).toBe(ATOM_SPECS.authenticated.output);
  });

  test('ownPath($uid)', () => {
    expect(ownPath('$uid')).toBe(ATOM_SPECS.ownPath.output);
  });

  test('ownField(author)', () => {
    expect(ownField('author')).toBe(ATOM_SPECS.ownField.output);
  });

  test('isNew()', () => {
    expect(isNew()).toBe(ATOM_SPECS.isNew.output);
  });

  test('hasChildren()', () => {
    expect(hasChildren()).toBe(ATOM_SPECS.hasChildren.output);
  });

  test('hasChild(name)', () => {
    expect(hasChild('name')).toBe(ATOM_SPECS.hasChild.output);
  });

  test('fieldIsString(name)', () => {
    expect(fieldIsString('name')).toBe(ATOM_SPECS.fieldIsString.output);
  });

  test('fieldIsNumber(age)', () => {
    expect(fieldIsNumber('age')).toBe(ATOM_SPECS.fieldIsNumber.output);
  });

  test('fieldIsBoolean(active)', () => {
    expect(fieldIsBoolean('active')).toBe(ATOM_SPECS.fieldIsBoolean.output);
  });

  test('fieldEnum(role, [user, admin])', () => {
    expect(fieldEnum('role', ['user', 'admin'])).toBe(ATOM_SPECS.fieldEnum.output);
  });

  test('immutable(createdAt)', () => {
    expect(immutable('createdAt')).toBe(ATOM_SPECS.immutable.output);
  });

  test('immutableSelf()', () => {
    expect(immutableSelf()).toBe(ATOM_SPECS.immutableSelf.output);
  });

  test('rootExists with path variable', () => {
    expect(rootExists(['users', { $: '$uid' }])).toBe(ATOM_SPECS.rootExistsPathVar.output);
  });

  test('rootExists with runtime ref (auth.uid)', () => {
    expect(rootExists(['users', { $: 'auth.uid' }])).toBe(ATOM_SPECS.rootExistsRuntimeRef.output);
  });

  test('rootEquals with auth.uid and value', () => {
    expect(rootEquals(['users', { $: 'auth.uid' }, 'role'], 'admin')).toBe(ATOM_SPECS.rootEquals.output);
  });

  // Edge cases
  test('ownPath with different variable', () => {
    expect(ownPath('$teamId')).toBe('auth.uid === $teamId');
  });

  test('fieldEnum with single value', () => {
    expect(fieldEnum('status', ['active'])).toBe('newData.child("status").val() === "active"');
  });

  test('rootExists with all-literal segments', () => {
    expect(rootExists(['config', 'features'])).toBe('root.child("config").child("features").exists()');
  });
});
