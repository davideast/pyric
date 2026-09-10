import type { EvalTask } from '../types.js';

const FUNCTIONS_SOURCE = `function makeTrigger(reference, handler) {
  handler.__endpoint = {
    eventTrigger: {
      eventType: 'google.firebase.database.ref.v1.created',
      eventFilterPathPatterns: { ref: reference, instance: '*' },
    },
  };
  return handler;
}

exports.makeUppercase = makeTrigger('messages/{pushId}/original', (event) => (
  String(event.data.delta).toUpperCase()
));
`;

const task: EvalTask = {
  id: 'run-the-uppercase-trigger-without-writing-the-database',
  prompt:
    "Run the makeUppercase trigger as if 'shout' had just been written at messages/abc123/original, but don't actually write it there. Tell me what the handler returned.",
  seed: {
    projectFiles: {
      'firebase.json': JSON.stringify({ functions: { source: 'functions' } }),
      'functions/package.json': JSON.stringify({ name: 'fixture-functions', private: true, main: 'index.js' }),
      'functions/index.js': FUNCTIONS_SOURCE,
    },
  },
  acceptedFirstOperations: ['fire_functions_trigger'],
  assert: (state) => {
    const call = state.calls.find((c) => c.operation === 'fire_functions_trigger' && c.ok);
    if (call === undefined) return 'no fire_functions_trigger call ever succeeded';
    const data = call.data as { result?: unknown };
    if (data.result !== 'SHOUT') return `the handler's result was not carried back (got ${JSON.stringify(data.result)})`;
    if (state.database.get('messages/abc123/original') !== null) {
      return 'the synthetic event actually wrote to the database';
    }
    return true;
  },
  tags: ['functions', 'write'],
};

export default task;
