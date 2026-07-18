import type { ActivityIncident } from './activity-monitor.js';

/** Producer limits shared with the host-side semantic validator. */
export const ACTIVITY_CONTRACT = Object.freeze({
  readThreshold: 5,
  readWindowMs: 1_000,
  duplicateListenerThreshold: 3,
  churnAttachThreshold: 4,
  churnDetachThreshold: 3,
  listenerWindowMs: 2_000,
  maxEventsPerFingerprint: 32,
  criticalReadThreshold: 20,
  criticalDuplicateListenerThreshold: 10,
  criticalChurnThreshold: 12,
});

/** Reject incident combinations the monitor itself can never generate. */
export function hasGeneratedActivitySemantics(incident: ActivityIncident): boolean {
  if (incident.pattern === 'repeated-read') {
    return incident.count >= ACTIVITY_CONTRACT.readThreshold
      && incident.count <= ACTIVITY_CONTRACT.maxEventsPerFingerprint
      && incident.windowMs <= ACTIVITY_CONTRACT.readWindowMs
      && incident.confidence === 'high'
      && incident.severity === (
        incident.count >= ACTIVITY_CONTRACT.criticalReadThreshold ? 'critical' : 'warning'
      );
  }
  const balance = incident.listenerBalance;
  if (!balance) return false;
  if (incident.pattern === 'duplicate-listener') {
    return incident.count >= ACTIVITY_CONTRACT.duplicateListenerThreshold
      && incident.count <= ACTIVITY_CONTRACT.maxEventsPerFingerprint
      && balance.attaches <= ACTIVITY_CONTRACT.maxEventsPerFingerprint
      && balance.detaches <= ACTIVITY_CONTRACT.maxEventsPerFingerprint
      && balance.active <= ACTIVITY_CONTRACT.maxEventsPerFingerprint
      && balance.active === incident.count
      && incident.confidence === (
        incident.count >= ACTIVITY_CONTRACT.criticalDuplicateListenerThreshold
          ? 'high'
          : 'medium'
      )
      && incident.severity === (
        incident.count >= ACTIVITY_CONTRACT.criticalDuplicateListenerThreshold
          ? 'critical'
          : 'warning'
      );
  }
  return incident.count >= ACTIVITY_CONTRACT.churnAttachThreshold
    && incident.count <= ACTIVITY_CONTRACT.maxEventsPerFingerprint
    && incident.windowMs <= ACTIVITY_CONTRACT.listenerWindowMs
    && balance.attaches <= ACTIVITY_CONTRACT.maxEventsPerFingerprint
    && balance.detaches <= ACTIVITY_CONTRACT.maxEventsPerFingerprint
    && balance.active <= ACTIVITY_CONTRACT.maxEventsPerFingerprint
    && balance.attaches === incident.count
    && balance.detaches >= ACTIVITY_CONTRACT.churnDetachThreshold
    && incident.confidence === 'high'
    && incident.severity === (
      incident.count >= ACTIVITY_CONTRACT.criticalChurnThreshold ? 'critical' : 'warning'
    );
}
