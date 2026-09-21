import { normal, abortBefore, duplicateKey } from './normal.mjs';
import { abortAfter, stopRace, unavailableLookup } from './interruption.mjs';
import { explicitStop, lostGateway } from './recovery.mjs';
import { transportLoss, unresolved } from './transport.mjs';
export const scenarios = {
    'normal-response': { profile: 'observable', run: s => normal(s), expected: { completed: true, singleRelease: true, usageObserved: true } },
    'normal-stream': { profile: 'observable', run: s => normal(s, { streaming: true }), expected: { completed: true, singleRelease: true, usageObserved: true } },
    'abort-before-dispatch': { profile: 'observable', run: abortBefore, expected: { zeroDispatch: true, noReservation: true } },
    'abort-after-acceptance': { profile: 'observable', run: s => abortAfter(s), expected: { retainedUntilObservation: true, singleRelease: true } },
    'abort-after-chunk': { profile: 'observable', run: s => abortAfter(s, { chunk: true }), expected: { retainedUntilObservation: true, singleRelease: true } },
    'gateway-deadline': { profile: 'observable', run: s => abortAfter(s, { deadline: true }), expected: { retainedUntilObservation: true, singleRelease: true } },
    'complete-then-stop': { profile: 'observable', run: s => stopRace(s, { completeFirst: true }), expected: { stableTerminal: true, singleRelease: true } },
    'stop-then-complete': { profile: 'observable', run: s => stopRace(s), expected: { stableTerminal: true, singleRelease: true } },
    'duplicate-key': { profile: 'observable', maxConcurrent: 2, run: duplicateKey, expected: { oneProviderOperation: true, twoChargedDispatches: true, eachReservationReleasedOnce: true } },
    'missing-lookup': { profile: 'missing', run: unavailableLookup, expected: { retainedUnknown: true, unresolvedLookup: true } },
    'inaccessible-lookup': { profile: 'inaccessible', run: unavailableLookup, expected: { retainedUnknown: true, unresolvedLookup: true } },
    'explicit-stop': { profile: 'observable', run: explicitStop, expected: { acknowledgmentHeldCapacity: true, ownerEnforced: true, singleRelease: true } },
    'lost-gateway': { profile: 'observable', run: lostGateway, expected: { restartHeldCapacity: true, noRedispatch: true, singleRelease: true } },
    'transport-loss': { profile: 'observable', run: transportLoss, expected: { capacityBoundRespected: true } },
    'unresolvable-budget': { profile: 'unobservable', run: unresolved, expected: { unsupportedStop: true, capacityBoundRespected: true } },
    'unsafe-transport-release': { profile: 'unobservable', unsafe: true, run: unresolved, expected: { capacityBoundRespected: false } },
};

// At most five polling barriers (50 inspections each), setup/control/drain and
// gateway callbacks fit in 512 IPC commands. Native retries are bounded separately.
for (const scenario of Object.values(scenarios)) Object.assign(scenario, { maxCommands: 512, maxTransactionAttempts: 8 });
