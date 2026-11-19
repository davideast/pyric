import { CLIENT, row } from './section.ts';

export default row({
  order: 190,
  kind: 'upstream',
  api: 'httpsCallable(functions, name, { timeout })',
  behavior:
    'When no answer arrives within timeout ms (70000 when unset), the call rejects with FunctionsError functions/deadline-exceeded, message "deadline-exceeded", without aborting the request. .stream() has no timeout.',
  evidence: `upstream: \`failAfter\` and \`callAtURL\` (\`options.timeout || 70000\`) in ${CLIENT}; \`streamAtURL\` takes only a signal.`,
});
