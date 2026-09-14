/** Same row surfaces, insets, field tracks and icon treatment as Traffic. */
export const RULE_EVIDENCE_STYLES = `
  .rules-evidence, .rules-section, .rules-detail-body { display: grid; gap: var(--space-3); min-width: 0; font-size: 12px; }
  .rules-evidence { gap: 20px; }
  .rules-evidence code { font-family: var(--pyric-font-mono, 'Geist Mono', monospace); white-space: pre-wrap; overflow-wrap: anywhere; }
  .rules-evidence .rule-expression { display: block; min-width: 0; max-width: 100%; white-space: nowrap; overflow-wrap: normal; overflow-x: auto; overflow-y: hidden; }
  /* Keep overlay scrollbars below the text, including while a trackpad gesture is active. */
  .rule-expression::after { content: ''; display: block; height: 16px; }
  .rule-expression:focus-visible { outline: 2px solid var(--pyric-accent); outline-offset: -2px; }
  .rules-record { display: grid; grid-template-columns: 0 minmax(0, 1fr) 0; grid-template-rows: 0 auto 0; gap: var(--space-3); }
  .rules-record + .rules-record { border-top: 1px solid var(--pyric-border-soft); }
  .rules-record-body { grid-column: 2; grid-row: 2; display: grid; gap: 12px; min-width: 0; overflow-wrap: anywhere; }
  .rules-record-heading { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
  .rules-record-heading strong { font-weight: 550; font-size: 13px; }
  .rules-status { color: var(--pyric-error); font-size: 11px; }
  .rules-facts { all: unset; display: grid; gap: 8px; }
  .rules-expected { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: baseline; }
  .rules-value-source { color: var(--pyric-muted); flex-basis: 100%; font-size: 11px; }
  .rules-disclosure { border-block: 1px solid var(--pyric-border-soft); }
  .rules-disclosure > summary { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 44px; list-style: none; cursor: pointer; color: var(--pyric-accent); font-weight: 550; }
  .rules-disclosure > summary::-webkit-details-marker { display: none; }
  .rules-disclosure > summary:hover { color: var(--pyric-text); }
  .rules-disclosure > summary:focus-visible { outline: 2px solid var(--pyric-accent); outline-offset: -2px; border-radius: 4px; }
  .rules-chevron { display: flex; align-items: center; }
  .rules-chevron .icon { width: 14px; height: 14px; }
  .rules-disclosure[open] > summary .icon { transform: rotate(90deg); }
  .rules-detail-body { grid-template-rows: 0; row-gap: 16px; }
  .rules-detail-body::before, .rules-detail-body::after { content: ''; }
  .rules-privacy { color: var(--pyric-muted); line-height: 1.5; }
`;
