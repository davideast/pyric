/**
 * Unsupported-trigger diagnostics panel surfaced when a project's Functions
 * source exports triggers that the local runtime skips or rejects.
 */

import { familyMeta, parseUnsupportedDiagnostic } from './model.js';
import type { UnsupportedTrigger } from './types.js';

export interface UnsupportedDiagnosticsProps {
  readonly items: readonly UnsupportedTrigger[];
}

export function UnsupportedDiagnostics({ items }: UnsupportedDiagnosticsProps) {
  if (items.length === 0) return null;

  const parsed = items.map(parseUnsupportedDiagnostic);

  return (
    <section
      className="functions__diagnostics"
      data-functions-unsupported=""
      role="region"
      aria-labelledby="functions-unsupported-heading"
    >
      <header className="functions__diagnostics-head">
        <div>
          <h2 id="functions-unsupported-heading" className="functions__diagnostics-title">
            Unsupported triggers
          </h2>
          <p className="functions__diagnostics-copy">
            These exports were discovered in your Functions source but will not execute in
            the local runtime.
          </p>
        </div>
        <span className="functions__count-pill functions__count-pill--warn">
          {items.length} skipped
        </span>
      </header>

      <ul className="functions__diagnostics-list">
        {parsed.map((item) => (
          <li
            key={`${item.exportName}:${item.rawEventType}`}
            className="functions__diagnostic-row"
            data-functions-unsupported-item={item.exportName}
          >
            <div className="functions__diagnostic-main">
              <code className="functions__export-name">{item.exportName}</code>
              <span className="functions__family-badge" data-family={item.family}>
                {familyMeta(item.family).shortLabel}
              </span>
              <code className="functions__event-type">{item.eventType}</code>
            </div>
            <p className="functions__diagnostic-reason">{item.reason}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
