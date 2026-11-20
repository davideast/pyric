import { defineRowSection } from '../../section-rows.ts';
import { bindSwiftFirestoreRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'firestore-swift',
  order: 50,
  defaults: {
    section: 'Snapshots & metadata',
  },
});

export const row = bindSwiftFirestoreRow(section);

export const LIVE_HOST_SNAPSHOTS_SUITE =
  'packages/swift-client/Tests/PyricLiveHostTests/FirestoreSnapshotsLiveHostConformanceTests.swift';
