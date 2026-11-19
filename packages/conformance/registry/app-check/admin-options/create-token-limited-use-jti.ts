import { CONSUME, CREATE, REPLAY, row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ['createToken', 'verifyToken'],
  api: 'getAppCheck().createToken(appId, { limitedUse: true, jti }) twice, then verifyToken(token, { consume: true })',
  behavior: 'When `limitedUse` is `true` and `jti` is provided, the minted token carries the requested `jti` claim and a second `verifyToken(token, { consume: true })` of that same `jti` resolves `alreadyConsumed: true`.',
  evidence: `\`oracle:${CREATE}\` and \`oracle:${CONSUME}\` + replay: \`${REPLAY}\`.`,
  oracleObservations: [CREATE, CONSUME],
  notes: 'Capture keys: `limitedUse.withJti` (`jtiEqualsRequested`), and `consume` (`first` false, `secondSameJti` and `firstAgain` true). `sameTokens` varies across captures, so it is not pinned.',
});
