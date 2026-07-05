import type { ReactNode } from 'react';
import { Badge } from '../../primitives/Badge.js';
import { JsonView } from '../../primitives/JsonView.js';
import type { TrafficEvent } from '../types.js';
import { defaultFormatTime, reasonVerdict } from './format.js';

export interface TrafficDetailProps {
  event: TrafficEvent;
  /** Fired by the back affordance. When absent, no back button. */
  onBack?: () => void;
  /**
   * Render-prop slot below the header — the playground drops its
   * denial overlay (classification + LLM analysis) here. The library
   * doesn't own that analysis.
   */
  renderClassification?: (event: TrafficEvent) => ReactNode;
  /** Override the timestamp rendering. Default is `HH:MM:SS`. */
  formatTime?: (at: number) => string;
  className?: string;
}

function Section({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <section data-pyric-traffic-section="" data-pyric-section-label={label}>
      <h3 data-pyric-section-heading="">{label}</h3>
      {children}
    </section>
  );
}

/**
 * Headless drill-in panel for a single traffic event. Renders the
 * header (result + origin + timestamp + method/path + matched rule),
 * a consumer classification slot, then JSON sections for auth,
 * request payload, and resource before/after via `<JsonView>`, plus
 * the reasons list, `triggeredBy`, and `groupId`.
 *
 * `evalMs` appears here as a minor header field only — it is not a
 * log column (local simulator; latency is de-featured per
 * the design rationale).
 *
 * Styling hooks: `[data-pyric-ui="traffic-detail"]`,
 * `[data-pyric-traffic-section]` (with `data-pyric-section-label`),
 * `[data-pyric-traffic-reason]` (with `data-pyric-reason-verdict`).
 */
export function TrafficDetail({
  event,
  onBack,
  renderClassification,
  formatTime = defaultFormatTime,
  className,
}: TrafficDetailProps) {
  const requestData = event.request?.resourceData;

  return (
    <div className={className} data-pyric-ui="traffic-detail">
      <header data-pyric-traffic-detail-header="">
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            data-pyric-traffic-back=""
            aria-label="Back to traffic log"
          >
            Back
          </button>
        ) : null}
        <div data-pyric-traffic-detail-meta="">
          <Badge kind={event.result}>{event.result}</Badge>
          <span data-pyric-traffic-origin="">{event.origin}</span>
          <span data-pyric-traffic-time="">{formatTime(event.at)}</span>
          <span data-pyric-traffic-eval-ms="">{event.evalMs.toFixed(1)}ms</span>
        </div>
        <p data-pyric-traffic-detail-title="">
          <span data-pyric-traffic-method="">{event.method}</span>
          <span data-pyric-traffic-path="">{event.path}</span>
        </p>
        {event.matchedRule ? (
          <p data-pyric-traffic-matched-rule="">
            matched rule #{event.matchedRule.ruleIndex} ·{' '}
            {event.matchedRule.operations.join(', ')}
          </p>
        ) : null}
      </header>

      {renderClassification ? renderClassification(event) : null}

      <Section label="AUTH">
        <JsonView value={event.auth} />
      </Section>

      {requestData !== undefined ? (
        <Section label="REQUEST · resource.data">
          <JsonView value={requestData} />
        </Section>
      ) : null}

      {event.resourceBefore !== undefined ? (
        <Section label="RESOURCE BEFORE">
          <JsonView
            value={
              event.resourceBefore.exists ? event.resourceBefore.data : null
            }
          />
        </Section>
      ) : null}

      {event.resourceAfter !== undefined ? (
        <Section label="RESOURCE AFTER">
          <JsonView
            value={
              event.resourceAfter.exists ? event.resourceAfter.data : null
            }
          />
        </Section>
      ) : null}

      {event.reasons.length > 0 ? (
        <Section label="REASONS">
          <ul data-pyric-traffic-reasons="">
            {event.reasons.map((reason, i) => (
              <li
                key={i}
                data-pyric-traffic-reason=""
                data-pyric-reason-verdict={reasonVerdict(reason)}
              >
                {reason}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {event.triggeredBy ? (
        <Section label="TRIGGERED BY">
          <p data-pyric-traffic-triggered-by="">
            <span data-pyric-traffic-method="">
              {event.triggeredBy.method}
            </span>
            <span data-pyric-traffic-path="">{event.triggeredBy.path}</span>
          </p>
        </Section>
      ) : null}

      {event.groupId ? (
        <Section label="GROUP">
          <p data-pyric-traffic-group="">{event.groupId}</p>
        </Section>
      ) : null}
    </div>
  );
}
