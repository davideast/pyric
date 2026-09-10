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

exports.turnedOff = makeTrigger('messages/{id}', () => undefined);
exports.turnedOff.__endpoint.omit = true;
`;

const task: EvalTask = {
  id: 'discover-the-triggers-this-project-defines',
  prompt:
    'What Realtime Database triggered Cloud Functions does this project define, and is there anything in there the sandbox cannot run?',
  seed: {
    projectFiles: {
      'firebase.json': JSON.stringify({ functions: { source: 'functions' } }),
      'functions/package.json': JSON.stringify({ name: 'fixture-functions', private: true, main: 'index.js' }),
      'functions/index.js': FUNCTIONS_SOURCE,
    },
  },
  acceptedFirstOperations: ['list_functions_triggers'],
  assert: (state) => {
    const call = state.calls.find((c) => c.operation === 'list_functions_triggers' && c.ok);
    if (call === undefined) return 'no list_functions_triggers call ever succeeded';
    const data = call.data as { triggers?: Array<{ exportName: string }>; unsupported?: Array<{ exportName: string }> };
    if (!Array.isArray(data.triggers) || !data.triggers.some((t) => t.exportName === 'makeUppercase')) {
      return 'the supported trigger was not named';
    }
    if (!Array.isArray(data.unsupported) || !data.unsupported.some((u) => u.exportName === 'turnedOff')) {
      return 'the unsupported trigger was not named';
    }
    return true;
  },
  tags: ['functions', 'read'],
};

export default task;
