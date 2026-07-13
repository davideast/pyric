/**
 * Constraint Atoms — Typed Service Contract
 *
 * Each atom is a pure function that returns an Expr. This spec defines
 * the exact output for each atom given specific inputs.
 */

export const ATOM_SPECS = {
  // --- Authentication ---
  authenticated: { args: [], output: 'auth !== null' },

  // --- Ownership ---
  ownPath: { args: ['$uid'], output: 'auth.uid === $uid' },
  ownField: { args: ['author'], output: 'auth.uid === data.child("author").val()' },

  // --- Existence ---
  isNew: { args: [], output: '!data.exists()' },

  // --- Schema: field checks ---
  hasChildren: { args: [], output: 'newData.hasChildren()' },
  hasChild: { args: ['name'], output: 'newData.hasChild("name")' },
  fieldIsString: { args: ['name'], output: 'newData.child("name").isString()' },
  fieldIsNumber: { args: ['age'], output: 'newData.child("age").isNumber()' },
  fieldIsBoolean: { args: ['active'], output: 'newData.child("active").isBoolean()' },
  fieldEnum: {
    args: ['role', ['user', 'admin']],
    output: 'newData.child("role").val() === "user" || newData.child("role").val() === "admin"',
  },

  // --- Immutability ---
  immutable: { args: ['createdAt'], output: '!data.exists() || newData.child("createdAt").val() === data.child("createdAt").val()' },
  immutableSelf: { args: [], output: '!data.exists() || newData.val() === data.val()' },

  // --- Cross-path ---
  rootExistsPathVar: {
    args: [['users', { $: '$uid' }]],
    output: 'root.child("users").child($uid).exists()',
  },
  rootExistsRuntimeRef: {
    args: [['users', { $: 'auth.uid' }]],
    output: 'root.child("users").child(auth.uid).exists()',
  },
  rootEquals: {
    args: [['users', { $: 'auth.uid' }, 'role'], 'admin'],
    output: 'root.child("users").child(auth.uid).child("role").val() === "admin"',
  },
} as const;
