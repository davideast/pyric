/**
 * Policy Contracts — each policy composes atoms into a named pattern.
 */

export const POLICY_SPECS = {
  pathOwnerOnly: {
    args: ['$uid'],
    output: '(auth != null) && (auth.uid == $uid)',
  },
  fieldOwnerOnly: {
    args: ['author'],
    output: '(auth != null) && (auth.uid == data.child("author").val())',
  },
  ownerOrNew: {
    args: ['author'],
    output: '(auth != null) && ((!data.exists()) || (auth.uid == data.child("author").val()))',
  },
  hasRole: {
    args: [['users', { $: 'auth.uid' }, 'role'], 'admin'],
    output: 'root.child("users").child(auth.uid).child("role").val() == "admin"',
  },
  isMember: {
    args: ['team-members', 'teamId'],
    output: 'root.child("team-members").child($teamId).child(auth.uid).exists()',
  },
  required: {
    args: [['name', 'email']],
    output: '(newData.hasChild("name")) && (newData.hasChild("email"))',
  },
  transition: {
    args: ['status', [['open', 'playing'], ['open', 'cancelled']]],
    output: '((data.child("status").val() == "open") && (newData.child("status").val() == "playing")) || ((data.child("status").val() == "open") && (newData.child("status").val() == "cancelled"))',
  },
} as const;
