/**
 * Traffic-conformance harness (SF-S0c) — the UI's behavioral validator.
 * Pure diff of recorded sandbox traffic against the access matrix; a
 * measurement tool, not yet a gate (S4 wires it into a live path).
 */
export {
  checkTrafficConformance,
  type RecordedOp,
  type ConformanceReport,
  type ConformanceViolation,
  type CoverageNote,
} from './traffic-conformance';
