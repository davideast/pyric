export { AUTH_SESSION_SCOPE, FOLLOWS_CURRENT_USER } from './listener-routing.js';
export { monitorFirebaseActivity } from '../sandbox/activity-monitor.js';
export {
  ACTIVITY_CONTRACT,
  hasGeneratedActivitySemantics,
} from '../sandbox/activity-contract.js';
export type {
  ActivityFeed,
  ActivityIncident,
  ActivityMonitor,
  ActivityPattern,
  ActivityReport,
  ActivitySourceAttribution,
} from '../sandbox/activity-monitor.js';

// Diagnostic projections do not invoke arbitrary query-operand getters.
export { activityValue } from '../sandbox/activity-query-value.js';
export { activityStructuralIdentity } from '../sandbox/activity-structural-identity.js';
