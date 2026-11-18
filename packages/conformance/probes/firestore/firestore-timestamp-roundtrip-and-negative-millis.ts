import type { Probe } from '../../rigs/types.ts';
import { withFirestoreProbeSession } from '../../src/sdk-probe-runtime.ts';

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: ['web-config', 'firestore-rules'],
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'Timestamp normalizes negative-epoch milliseconds to non-negative nanoseconds, exposes isEqual/toJSON/valueOf, and round-trips consistently alongside Date and serverTimestamp() through setDoc and getDoc.',
  async observe() {
    return withFirestoreProbeSession(async ({ db, firestoreSdk, collectionPath }) => {
      const { Timestamp, collection, doc, getDoc, serverTimestamp, setDoc } = firestoreSdk;

      const negMillis = Timestamp.fromMillis(-500);
      const negDate = Timestamp.fromDate(new Date(-500));
      const earlierNeg = Timestamp.fromMillis(-1500);
      const posMillis = Timestamp.fromMillis(500);

      const valueApi = {
        negMillisSeconds: negMillis.seconds,
        negMillisNanoseconds: negMillis.nanoseconds,
        negMillisRoundTrip: negMillis.toMillis(),
        negDateEqualsNegMillis: negDate.isEqual(negMillis),
        negMillisNotEqualsEarlier: !negMillis.isEqual(earlierNeg),
        negMillisJson: negMillis.toJSON(),
        valueOfOrdersChronologically:
          earlierNeg.valueOf() < negMillis.valueOf() &&
          negMillis.valueOf() < posMillis.valueOf(),
      };

      const fixedMillis = 1_700_000_000_250;
      const explicitInput = Timestamp.fromMillis(fixedMillis);
      const dateInput = new Date(fixedMillis);

      const items = collection(db, collectionPath('timestamp-roundtrip'));
      const targetRef = doc(items, 'ts-doc');
      await setDoc(targetRef, {
        explicitTs: explicitInput,
        dateTs: dateInput,
        negTs: negMillis,
        serverTs: serverTimestamp(),
      });

      const snap = await getDoc(targetRef);
      const raw = snap.data() ?? {};
      const readExplicit = raw.explicitTs as InstanceType<typeof Timestamp>;
      const readDate = raw.dateTs as InstanceType<typeof Timestamp>;
      const readNeg = raw.negTs as InstanceType<typeof Timestamp>;
      const readServer = raw.serverTs as InstanceType<typeof Timestamp>;

      return {
        valueApi,
        roundTrip: {
          explicitIsTimestamp: readExplicit instanceof Timestamp,
          explicitSeconds: readExplicit.seconds,
          explicitNanoseconds: readExplicit.nanoseconds,
          explicitMillis: readExplicit.toMillis(),
          dateIsTimestamp: readDate instanceof Timestamp,
          dateEqualsExplicit: readDate.isEqual(readExplicit),
          negIsTimestamp: readNeg instanceof Timestamp,
          negSeconds: readNeg.seconds,
          negNanoseconds: readNeg.nanoseconds,
          negMillis: readNeg.toMillis(),
          serverIsTimestamp: readServer instanceof Timestamp,
          serverSecondsInteger:
            Number.isInteger(readServer.seconds) && readServer.seconds > 1_600_000_000,
          serverNanosecondsInRange:
            Number.isInteger(readServer.nanoseconds) &&
            readServer.nanoseconds >= 0 &&
            readServer.nanoseconds < 1_000_000_000,
        },
      };
    });
  },
};
