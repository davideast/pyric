import { describe, expect, it } from 'bun:test';
import type * as FirebaseDatabase from 'firebase/database';
import type {
  EmulatorMockTokenOptions,
  EventType,
  IteratedDataSnapshot,
  ListenOptions,
  QueryConstraintType,
  TransactionOptions,
  Database,
  DataSnapshot,
  QueryConstraint,
  TransactionResult,
  Query,
  DatabaseReference,
} from '../../src/database/index.js';

type BothWays<Left, Right> =
  [Left] extends [Right]
    ? ([Right] extends [Left] ? true : false)
    : false;

function assertBothWays<Value extends true>(): Value {
  return true as Value;
}

describe('RTDB public type parity', () => {
  it('exports census-visible types with upstream-compatible shapes', () => {
    const emulator = assertBothWays<BothWays<
      EmulatorMockTokenOptions,
      FirebaseDatabase.EmulatorMockTokenOptions
    >>();
    const event = assertBothWays<BothWays<EventType, FirebaseDatabase.EventType>>();
    const listen = assertBothWays<BothWays<ListenOptions, FirebaseDatabase.ListenOptions>>();
    const constraint = assertBothWays<BothWays<
      QueryConstraintType,
      FirebaseDatabase.QueryConstraintType
    >>();
    const transaction = assertBothWays<BothWays<
      TransactionOptions,
      FirebaseDatabase.TransactionOptions
    >>();

    const iteratedToFirebase = (snapshot: IteratedDataSnapshot): FirebaseDatabase.IteratedDataSnapshot => snapshot;
    const firebaseToIterated = (snapshot: FirebaseDatabase.IteratedDataSnapshot): IteratedDataSnapshot => snapshot;
    const databaseToFirebase = (database: Database): FirebaseDatabase.Database => database;
    const snapshotToFirebase = (snapshot: DataSnapshot): FirebaseDatabase.DataSnapshot => snapshot;
    const constraintToFirebase = (constraint: QueryConstraint): FirebaseDatabase.QueryConstraint => constraint;
    const transactionToFirebase = (result: TransactionResult): FirebaseDatabase.TransactionResult => result;
    const queryToFirebase = (value: Query): FirebaseDatabase.Query => value;
    const referenceToFirebase = (value: DatabaseReference): FirebaseDatabase.DatabaseReference => value;

    expect([emulator, event, listen, constraint, transaction]).toEqual([
      true, true, true, true, true,
    ]);
    expect(typeof iteratedToFirebase).toBe('function');
    expect(typeof firebaseToIterated).toBe('function');
    expect([
      databaseToFirebase,
      snapshotToFirebase,
      constraintToFirebase,
      transactionToFirebase,
      queryToFirebase,
      referenceToFirebase,
    ].every((value) => typeof value === 'function')).toBe(true);
  });
});
