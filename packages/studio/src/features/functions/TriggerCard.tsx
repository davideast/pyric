/**
 * One discovered Cloud Function card with family/region badges, endpoint URL or
 * event pattern, and an accessible inline Fire drawer for fireable triggers.
 */

import { useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import {
  classifyTriggerFamily,
  familyMeta,
  fireCapability,
  formatDurationMs,
  formatJsonPreview,
  parseOptionalJsonPayload,
  parseOptionalStringMap,
  parseOptionalTimeoutMs,
  sampleRtdbPathFromPattern,
  shortEventLabel,
  triggerEndpointUrls,
  triggerEventPattern,
  triggerMetaBadges,
  triggerRegions,
} from './model.js';
import type {
  DiscoveredTrigger,
  FireOutcome,
  FireTriggerInput,
  HttpFireMethod,
} from './types.js';

export interface TriggerCardProps {
  readonly trigger: DiscoveredTrigger;
  readonly origin: string;
  readonly projectId?: string | null;
  readonly onFire: (
    trigger: DiscoveredTrigger,
    input: FireTriggerInput,
  ) => Promise<FireOutcome>;
  readonly onFilterExecutions?: (triggerName: string) => void;
}

const HTTP_METHODS: readonly HttpFireMethod[] = ['GET', 'POST', 'PUT', 'DELETE'];

export function TriggerCard({
  trigger,
  origin,
  projectId,
  onFire,
  onFilterExecutions,
}: TriggerCardProps) {
  const family = classifyTriggerFamily(trigger.eventType);
  const meta = familyMeta(family);
  const regions = triggerRegions(trigger);
  const endpointUrls = triggerEndpointUrls(trigger, origin, projectId);
  const pattern = triggerEventPattern(trigger);
  const badges = triggerMetaBadges(trigger);
  const capability = fireCapability(trigger);

  const [fireOpen, setFireOpen] = useState(false);
  const [firing, setFiring] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  const [selectedRegion, setSelectedRegion] = useState<string>(regions[0] ?? 'us-central1');
  const [httpMethod, setHttpMethod] = useState<HttpFireMethod>('POST');
  const [pathInput, setPathInput] = useState<string>(() =>
    capability.mode === 'rtdb-fire' ? sampleRtdbPathFromPattern(trigger.reference) : '',
  );
  const [payloadInput, setPayloadInput] = useState<string>('');
  const [attributesInput, setAttributesInput] = useState<string>('');
  const [timeoutInput, setTimeoutInput] = useState<string>('');
  const [validationError, setValidationError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<FireOutcome | null>(null);

  const toggleRef = useRef<HTMLButtonElement>(null);
  const drawerId = useId();
  const pathId = useId();
  const payloadId = useId();
  const attrsId = useId();
  const timeoutId = useId();
  const methodId = useId();
  const regionId = useId();
  const errorId = useId();

  const handleCopyUrl = (url: string) => {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(url).catch(() => {});
    }
    setCopiedUrl(url);
    setTimeout(() => {
      setCopiedUrl((current) => (current === url ? null : current));
    }, 1500);
  };

  const handleDrawerKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      setFireOpen(false);
      toggleRef.current?.focus();
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (firing) return;
    setValidationError(null);

    const input: FireTriggerInput = {};

    if (capability.mode === 'rtdb-fire') {
      const trimmedPath = pathInput.trim();
      if (trimmedPath.length === 0) {
        setValidationError('RTDB path is required to fire this trigger.');
        return;
      }
      const parsedValue = parseOptionalJsonPayload(payloadInput, {});
      if (!parsedValue.ok) {
        setValidationError(parsedValue.error);
        return;
      }
      const parsedTimeout = parseOptionalTimeoutMs(timeoutInput);
      if (!parsedTimeout.ok) {
        setValidationError(parsedTimeout.error);
        return;
      }
      input.path = trimmedPath;
      input.payload = parsedValue.value;
      if (parsedTimeout.value !== undefined) {
        input.timeoutMs = parsedTimeout.value;
      }
    } else if (capability.mode === 'http') {
      input.httpMethod = httpMethod;
      input.region = selectedRegion;
      input.path = pathInput.trim();
      if (httpMethod !== 'GET') {
        const parsedBody = parseOptionalJsonPayload(payloadInput, undefined);
        if (!parsedBody.ok) {
          setValidationError(parsedBody.error);
          return;
        }
        input.payload = parsedBody.value;
      }
    } else if (capability.mode === 'callable') {
      input.region = selectedRegion;
      const parsedData = parseOptionalJsonPayload(payloadInput, {});
      if (!parsedData.ok) {
        setValidationError(parsedData.error);
        return;
      }
      input.payload = parsedData.value;
    } else if (capability.mode === 'scheduler') {
      const parsedOpts = parseOptionalJsonPayload(payloadInput, {});
      if (!parsedOpts.ok) {
        setValidationError(parsedOpts.error);
        return;
      }
      if (
        !parsedOpts.isEmpty &&
        (typeof parsedOpts.value !== 'object' ||
          parsedOpts.value === null ||
          Array.isArray(parsedOpts.value))
      ) {
        setValidationError('Scheduler options must be a JSON object.');
        return;
      }
      input.payload = parsedOpts.value;
    } else if (capability.mode === 'pubsub') {
      const parsedPayload = parseOptionalJsonPayload(payloadInput, {});
      if (!parsedPayload.ok) {
        setValidationError(parsedPayload.error);
        return;
      }
      const parsedAttrs = parseOptionalStringMap(attributesInput);
      if (!parsedAttrs.ok) {
        setValidationError(parsedAttrs.error);
        return;
      }
      input.payload = parsedPayload.value;
      if (parsedAttrs.value !== undefined) {
        input.attributes = parsedAttrs.value;
      }
    } else if (capability.mode === 'tasks') {
      const parsedData = parseOptionalJsonPayload(payloadInput, {});
      if (!parsedData.ok) {
        setValidationError(parsedData.error);
        return;
      }
      input.payload = parsedData.value;
    }

    setFiring(true);
    setOutcome(null);
    try {
      const result = await onFire(trigger, input);
      setOutcome(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setOutcome({ ok: false, summary: message, error: message });
    } finally {
      setFiring(false);
    }
  };

  const payloadLabel =
    capability.mode === 'rtdb-fire'
      ? 'Event value (JSON, optional)'
      : capability.mode === 'callable'
        ? 'Callable data (JSON, optional)'
        : capability.mode === 'scheduler'
          ? 'Schedule options (JSON object, optional)'
          : capability.mode === 'pubsub'
            ? 'Message JSON payload (optional)'
            : capability.mode === 'tasks'
              ? 'Task data payload (JSON, optional)'
              : 'Request body (JSON, optional)';

  const payloadPlaceholder =
    capability.mode === 'rtdb-fire'
      ? '{"text": "hello"}'
      : capability.mode === 'scheduler'
        ? '{"jobName": "manual-run"}'
        : '{"example": true}';

  return (
    <article
      className="functions__card"
      data-functions-trigger={trigger.exportName}
      data-functions-family={family}
    >
      <div className="functions__card-top">
        <div className="functions__card-identity">
          <div className="functions__card-name-row">
            <h3 className="functions__card-name">{trigger.exportName}</h3>
            <span className="functions__family-badge" data-family={family}>
              {meta.shortLabel}
            </span>
            <span className="functions__event-pill">{shortEventLabel(trigger.eventType)}</span>
          </div>

          <div className="functions__badges">
            {regions.map((region) => (
              <span key={region} className="studio-badge functions__region-badge">
                {region}
              </span>
            ))}
            {badges.map((badge) => (
              <span key={`${badge.label}:${badge.value}`} className="studio-badge">
                {badge.label}: {badge.value}
              </span>
            ))}
          </div>
        </div>

        <div className="functions__card-actions">
          {onFilterExecutions ? (
            <button
              type="button"
              className="studio-button functions__action-btn"
              onClick={() => onFilterExecutions(trigger.exportName)}
            >
              Logs
            </button>
          ) : null}
          {capability.fireable ? (
            <button
              ref={toggleRef}
              type="button"
              className="studio-button studio-button--primary functions__fire-toggle"
              aria-expanded={fireOpen}
              aria-controls={drawerId}
              data-functions-fire-toggle={trigger.exportName}
              onClick={() => setFireOpen((open) => !open)}
            >
              {fireOpen ? 'Close' : capability.actionLabel}
            </button>
          ) : (
            <span
              className="functions__auto-badge"
              title={capability.description}
              data-functions-auto=""
            >
              Auto trigger
            </span>
          )}
        </div>
      </div>

      {endpointUrls.length > 0 ? (
        <ul className="functions__endpoints" aria-label="Endpoint URLs">
          {endpointUrls.map((url) => (
            <li key={url} className="functions__endpoint-row">
              <code className="functions__endpoint-url">{url}</code>
              <button
                type="button"
                className="functions__copy-btn"
                aria-label={`Copy endpoint URL for ${trigger.exportName}`}
                onClick={() => handleCopyUrl(url)}
              >
                {copiedUrl === url ? 'Copied' : 'Copy'}
              </button>
            </li>
          ))}
        </ul>
      ) : pattern ? (
        <div className="functions__pattern-row">
          <span className="functions__pattern-label">Pattern</span>
          <code className="functions__pattern-value">{pattern}</code>
        </div>
      ) : null}

      {!capability.fireable ? (
        <p className="functions__auto-hint">{capability.description}</p>
      ) : null}

      {capability.fireable && fireOpen ? (
        <form
          id={drawerId}
          className="functions__fire-form"
          data-functions-fire-form={trigger.exportName}
          onSubmit={(e) => void handleSubmit(e)}
          onKeyDown={handleDrawerKeyDown}
          noValidate
        >
          <p className="functions__fire-desc">{capability.description}</p>

          {(capability.mode === 'http' || capability.mode === 'callable') && regions.length > 1 ? (
            <div className="functions__field">
              <label className="functions__label" htmlFor={regionId}>
                Region
              </label>
              <select
                id={regionId}
                className="functions__input"
                value={selectedRegion}
                onChange={(e) => setSelectedRegion(e.target.value)}
              >
                {regions.map((region) => (
                  <option key={region} value={region}>
                    {region}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          {capability.mode === 'http' ? (
            <div className="functions__field-row">
              <div className="functions__field functions__field--compact">
                <label className="functions__label" htmlFor={methodId}>
                  Method
                </label>
                <select
                  id={methodId}
                  className="functions__input"
                  value={httpMethod}
                  onChange={(e) => setHttpMethod(e.target.value as HttpFireMethod)}
                >
                  {HTTP_METHODS.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>
              <div className="functions__field">
                <label className="functions__label" htmlFor={pathId}>
                  Subpath (optional)
                </label>
                <input
                  id={pathId}
                  type="text"
                  className="functions__input mono"
                  placeholder="/health"
                  value={pathInput}
                  onChange={(e) => setPathInput(e.target.value)}
                />
              </div>
            </div>
          ) : null}

          {capability.mode === 'rtdb-fire' ? (
            <div className="functions__field-row">
              <div className="functions__field">
                <label className="functions__label" htmlFor={pathId}>
                  Concrete RTDB path
                </label>
                <input
                  id={pathId}
                  type="text"
                  className="functions__input mono"
                  value={pathInput}
                  aria-invalid={validationError?.includes('path') ? 'true' : undefined}
                  aria-describedby={validationError ? errorId : undefined}
                  onChange={(e) => setPathInput(e.target.value)}
                />
              </div>
              <div className="functions__field functions__field--compact">
                <label className="functions__label" htmlFor={timeoutId}>
                  Timeout (ms, optional)
                </label>
                <input
                  id={timeoutId}
                  type="text"
                  inputMode="numeric"
                  className="functions__input mono"
                  placeholder="10000"
                  value={timeoutInput}
                  aria-invalid={validationError?.includes('Timeout') ? 'true' : undefined}
                  aria-describedby={validationError ? errorId : undefined}
                  onChange={(e) => setTimeoutInput(e.target.value)}
                />
              </div>
            </div>
          ) : null}

          {!(capability.mode === 'http' && httpMethod === 'GET') ? (
            <div className="functions__field">
              <label className="functions__label" htmlFor={payloadId}>
                {payloadLabel}
              </label>
              <textarea
                id={payloadId}
                className="functions__textarea mono"
                rows={3}
                placeholder={payloadPlaceholder}
                value={payloadInput}
                aria-invalid={
                  validationError && !validationError.includes('Attribute') && !validationError.includes('path')
                    ? 'true'
                    : undefined
                }
                aria-describedby={validationError ? errorId : undefined}
                onChange={(e) => {
                  setPayloadInput(e.target.value);
                  if (validationError) setValidationError(null);
                }}
              />
            </div>
          ) : null}

          {capability.mode === 'pubsub' ? (
            <div className="functions__field">
              <label className="functions__label" htmlFor={attrsId}>
                Attributes (JSON string map, optional)
              </label>
              <input
                id={attrsId}
                type="text"
                className="functions__input mono"
                placeholder='{"source": "studio"}'
                value={attributesInput}
                aria-invalid={validationError?.includes('Attribute') ? 'true' : undefined}
                aria-describedby={validationError ? errorId : undefined}
                onChange={(e) => {
                  setAttributesInput(e.target.value);
                  if (validationError) setValidationError(null);
                }}
              />
            </div>
          ) : null}

          {validationError ? (
            <p
              id={errorId}
              className="functions__fire-alert"
              role="alert"
              data-functions-fire-validation=""
            >
              {validationError}
            </p>
          ) : null}

          <div className="functions__fire-submit-row">
            <button
              type="submit"
              className="studio-button studio-button--primary"
              disabled={firing}
              data-functions-fire-submit={trigger.exportName}
            >
              {firing ? 'Firing...' : `Run ${trigger.exportName}`}
            </button>
            <button
              type="button"
              className="studio-button"
              onClick={() => {
                setFireOpen(false);
                toggleRef.current?.focus();
              }}
            >
              Cancel
            </button>
          </div>

          {outcome ? (
            <div
              className={
                outcome.ok
                  ? 'functions__fire-result functions__fire-result--ok'
                  : 'functions__fire-result functions__fire-result--err'
              }
              role={outcome.ok ? 'status' : 'alert'}
              data-functions-fire-outcome={outcome.ok ? 'ok' : 'error'}
            >
              <div className="functions__fire-result-head">
                <strong>{outcome.ok ? 'Succeeded' : 'Failed'}</strong>
                <span>{outcome.summary}</span>
                {outcome.executionId ? (
                  <span className="studio-badge mono">run #{outcome.executionId}</span>
                ) : null}
                {outcome.durationMs !== undefined ? (
                  <span className="studio-badge mono">
                    {formatDurationMs(outcome.durationMs)}
                  </span>
                ) : null}
              </div>
              {outcome.result !== undefined ? (
                <pre className="functions__code-block">{formatJsonPreview(outcome.result)}</pre>
              ) : null}
            </div>
          ) : null}
        </form>
      ) : null}
    </article>
  );
}
