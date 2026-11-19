import { row } from './section.ts';

export default row({
  order: 250,
  kind: 'pyric',
  api: 'pyric/functions in production AI mode',
  behavior:
    'In production AI mode pyric/functions stays the mirror: calls reach the app\'s local callable through pyric\'s gateway, never the deployed function. Sending a real App Check token from the production shadow app to an enforceAppCheck callable is unsupported, with a follow-up.',
  evidence:
    'Owner decision (plan decision 6): the function is the user\'s own local code, so firebase/functions is not passed through. On main, production AI mode swaps only firebase/ai and firebase/app-check.',
});
