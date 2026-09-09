import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'add-audit-log-entry',
  prompt: 'Drop a row into the auditLog collection recording that dana_acme exported the billing report. I do not care what the document id is.',
  seed: {},
  acceptedFirstOperations: ['add_firestore_document'],
  assert: (state) => {
    const rows = state.firestore.list('auditLog');
    if (rows.length === 0) return 'auditLog is empty';
    const hit = rows.some((r) => JSON.stringify(r.data).includes('dana_acme'));
    if (!hit) return 'no auditLog row mentions dana_acme';
    return true;
  },
  tags: ['firestore', 'write'],
};

export default task;
