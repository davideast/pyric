import { defineRowSection } from '../../section-rows.ts';
import { bindSwiftFirestoreRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'firestore-swift',
  order: 100,
  defaults: {
    section: 'Concurrency & async sequences',
  },
});

export const row = bindSwiftFirestoreRow(section);

export const LIVE_HOST_TRANSACTIONS_SUITE =
  'packages/swift-client/Tests/PyricLiveHostTests/FirestoreTransactionsLiveHostConformanceTests.swift';
