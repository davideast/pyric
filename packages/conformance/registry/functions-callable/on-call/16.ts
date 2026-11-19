import { CLIENT, row } from './section.ts';

export default row({
  order: 160,
  kind: 'observed',
  api: 'httpsCallableFromURL(functions, url)',
  behavior:
    'httpsCallableFromURL with https://{region}-{projectId}.cloudfunctions.net/{name} and with the function\'s run.app URL reaches the same v2 callable and returns its result. In pyric a page maps the cloudfunctions.net URL to /{projectId}/{region}/{name} on its own origin and a run.app URL through the lowercased service name, warning when that mapping is ambiguous; any other URL is an off-machine call the guard refuses.',
  evidence:
    `upstream: \`callAtURL\` posts to the given URL unchanged (${CLIENT}). Owner decision (plan decision 4): the run.app mapping and warning. Production behavior needs \`functions-callable-client-from-url\`.`,
});
