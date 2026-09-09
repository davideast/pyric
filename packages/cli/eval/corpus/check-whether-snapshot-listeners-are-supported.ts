import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'check-whether-snapshot-listeners-are-supported',
  prompt:
    'Before I write the presence panel I need to know whether onSnapshot actually works here or whether I have to poll. What does pyric claim about it, and how good is the evidence?',
  seed: {
    firestore: { 'rooms/lobby': { open: true } },
  },
  acceptedFirstOperations: ['check_assurance_feature'],
  assert: (state) => {
    const asked = state.calls.find((call) => call.operation === 'check_assurance_feature');
    if (!asked) return 'the conformance registry was never consulted';
    const data = asked.data as
      | { match?: string; supports?: Array<{ feature?: string; availability?: string }> }
      | undefined;
    if (data?.match !== 'exact') return `the registry answered '${String(data?.match)}', not exact`;
    const support = data.supports?.[0];
    if (support?.feature !== 'onSnapshot') {
      return `the answer was about '${String(support?.feature)}' rather than onSnapshot`;
    }
    if (typeof support.availability !== 'string') return 'the answer carried no availability';
    return true;
  },
  tags: ['assurance', 'conformance', 'read'],
};

export default task;
