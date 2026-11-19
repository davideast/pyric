import { CONSUME, REPLAY, row } from './section.ts';

export default row({
  order: 80,
  featureKeys: ['verifyToken'],
  api: 'getAppCheck().verifyToken(token, { consume: true })',
  behavior: 'Resolves an object whose own property order is `alreadyConsumed`, `appId`, `token`.',
  evidence: `\`oracle:${CONSUME}\` + replay: \`${REPLAY}\`.`,
  oracleObservations: [CONSUME],
  notes: 'Capture key `consume` (`keyOrder`).',
});
