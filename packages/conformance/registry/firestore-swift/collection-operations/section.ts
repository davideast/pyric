import { defineRowSection } from '../../section-rows.ts';
import { bindSwiftFirestoreRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'firestore-swift',
  order: 30,
  defaults: {
    section: '`CollectionReference` \u2014 collection operations',
  },
});

export const row = bindSwiftFirestoreRow(section);

export const LIVE_HOST_INSTANCE_SUITE =
  'packages/swift-client/Tests/PyricLiveHostTests/FirestoreInstanceLiveHostConformanceTests.swift';
