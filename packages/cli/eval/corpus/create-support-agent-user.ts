import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'create-support-agent-user',
  prompt: 'I need a support rep in the sandbox to reproduce a ticket. Create sam_support with email sam@northwind.test and a custom claim support set to true.',
  seed: {},
  acceptedFirstOperations: ['create_auth_user'],
  assert: (state) => {
    const user = state.users.get('sam_support');
    if (!user) return 'sam_support was not created';
    if (user.claims.support !== true) return 'sam_support is missing the support claim';
    return true;
  },
  tags: ['auth', 'write'],
};

export default task;
