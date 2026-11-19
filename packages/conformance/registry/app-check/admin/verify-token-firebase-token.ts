import { row } from './section.ts';

export default row({
  order: 80,
  diverged: 'by-design',
  api: 'getAppCheck().verifyToken(firebaseToken) in sandbox AI mode',
  featureKeys: ['verifyToken'],
  behavior: 'Production verifies the App Check tokens Firebase issues. Sandbox: in sandbox AI mode, or in a process not started with `@pyric/cli/register` in production AI mode, a token whose `kid` names a key other than the sandbox\'s rejects with `app-check/invalid-argument` and Pyric\'s message, which says the token was not minted by the Pyric sandbox and to start the server in production AI mode (`PYRIC_AI_MODE=production`). The project check comes first, as in production.',
  evidence: 'capture `app-check-admin-verify-token` (production verifies a token from its debug exchange); the sandbox side is pinned in the admin suite.',
  observations: ['app-check-admin-verify-token'],
  errorText: true,
  notes: 'Divergence, by design: the sandbox holds no Firebase keys and, in sandbox AI mode, never loads firebase-admin or reaches Google. The page gets such a token only in production AI mode. The code stays `invalid-argument`, so a server that branches on it still answers 401. The Vite SSR plane maps `firebase-admin/*` to this mirror without the register, so it keeps this message in production AI mode too.',
});
