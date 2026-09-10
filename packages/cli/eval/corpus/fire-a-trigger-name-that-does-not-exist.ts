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
  id: 'fire-a-trigger-name-that-does-not-exist',
  prompt:
    "Fire the sendWelcomeEmail trigger against users/new1/profile with the value true, so I can see what it does with a brand new signup.",
  seed: {
    projectFiles: {
      'firebase.json': JSON.stringify({ functions: { source: 'functions' } }),
      'functions/package.json': JSON.stringify({ name: 'fixture-functions', private: true, main: 'index.js' }),
      'functions/index.js': FUNCTIONS_SOURCE,
    },
  },
  acceptedFirstOperations: ['fire_functions_trigger', 'list_functions_triggers'],
  assert: (state) => {
    const attempt = state.calls.find((c) => c.operation === 'fire_functions_trigger');
    if (attempt === undefined) return 'no fire_functions_trigger call was ever made';
    if (attempt.ok) return 'a trigger the project never defined was reported as fired';
    return true;
  },
  tags: ['functions', 'write'],
};

export default task;
