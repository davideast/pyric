import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'import-the-acme-team-then-look-one-up',
  prompt:
    'Load our three Acme people into the sandbox on tenant-acme, with kim as the owner and the other two as viewers, then read back whichever one is at kim@acme.test so I can check the claims stuck.',
  seed: {},
  acceptedFirstOperations: ['import_auth_users', 'seed_sandbox', 'create_auth_user'],
  assert: (state) => {
    const kim = state.users.get('kim');
    if (kim === null) return 'kim is not in the pool';
    if (kim.tenant !== 'tenant-acme') return `kim is on tenant ${String(kim.tenant)}`;
    if (kim.claims.role !== 'owner') return `kim has role ${String(kim.claims.role)}`;
    if (state.users.list().length < 3) return 'fewer than three people were loaded';
    const read = state.calls.find(
      (call) => call.operation === 'get_auth_user_by_email' && call.ok,
    );
    if (!read) return 'nobody was read back by address';
    const user = (read.data as { user?: { uid?: string; tenantId?: string | null } })?.user;
    if (user?.uid !== 'kim') return `the address read back ${String(user?.uid)}`;
    if (user.tenantId !== 'tenant-acme') return 'the read did not report the tenant';
    return true;
  },
  tags: ['auth', 'tenant', 'multi-step'],
};

export default task;
