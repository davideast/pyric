import { observationPayload, requestStatusLabel } from 'pyric/sandbox/internal';
import { actingIdentity, opensRulesInspector, subjectTarget, type StudioTrafficEvent } from './verdict.js';
import { pushPath } from '../../shell/router.js';
import { TrafficRulesInspector } from './TrafficRulesInspector.js';

export function executionOutcome(event: StudioTrafficEvent): string {
  const status = event.observation?.status;
  if (status) return requestStatusLabel(status);
  if (event.result === 'error') return 'Failed';
  if (event.result === 'deny') return 'Denied';
  if (event.result === 'unsupported') return 'Unsupported';
  // A rules allow alone is not proof that the eventual write succeeded.
  if (event.kind === 'request') return 'Rules evaluated';
  return 'Succeeded';
}

type Fact = readonly [label: string, value: string];

function Facts({ title, items }: { title: string; items: readonly Fact[] }) {
  return <section className="traffic__fact-group" aria-label={title}>
    <h4>{title}</h4>
    <dl>{items.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
  </section>;
}

function durationLabel(ms: number | undefined): string {
  if (ms === undefined) return 'Not recorded';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function Payload({ label, value }: { label: string; value: unknown }) {
  const preview = observationPayload(value);
  if (!preview) return <p className="traffic__evidence-note">{label}: Not recorded</p>;
  return <details className="traffic__payload"><summary>{label}</summary><pre tabIndex={0}>{preview.text}</pre>{preview.truncated && <p>Preview truncated.</p>}</details>;
}

export function TrafficRequestInspector({ event, onClose }: { event?: StudioTrafficEvent; onClose: () => void }) {
  if (!event) return <section className="traffic__inspector" data-pyric-ui="traffic-inspect-missing">
    <p className="traffic__inspector-missing">This request is unavailable. It may have expired or belong to another session.</p>
    <button type="button" className="traffic__inspector-close" onClick={onClose}>Back to the log</button>
  </section>;
  const observation = event.observation;
  const ai = observation?.ai;
  const target = subjectTarget(event);
  const requestFacts: Fact[] = [
    ['Service', event.service ?? 'firestore'], ['Operation', event.method],
    ['Outcome', executionOutcome(event)],
  ];
  if (!ai) requestFacts.push(['Target', event.path]);
  const timingFacts: Fact[] = [
    ['Started', new Date(observation?.startedAt ?? event.at).toISOString()],
    ['Ended', observation?.endedAt === undefined ? 'Not recorded' : new Date(observation.endedAt).toISOString()],
    ['Duration', durationLabel(event.durationMs)],
  ];
  if (ai) timingFacts.push(['First chunk', durationLabel(ai.firstChunkMs)]);
  return <section className="traffic__inspector traffic__request-detail" data-pyric-ui="traffic-request-inspector">
    <header className="traffic__request-header"><h3>Request details</h3><button type="button" className="traffic__inspector-close" onClick={onClose}>Back to the log</button></header>
    <div className="traffic__fact-groups">
      <Facts title="Request" items={requestFacts} />
      {ai && <Facts title="Model routing" items={[
        ['Requested model', ai.requestedModel], ['Routed model', ai.routedModel ?? 'Not recorded'],
        ['Reported model', ai.reportedModel ?? 'Not recorded'],
      ]} />}
      <Facts title="Timing" items={timingFacts} />
      {ai && <Facts title="Token usage" items={[
        ['Source', ai.usageSource], ['Input tokens', ai.inputTokens?.toLocaleString() ?? 'Not recorded'],
        ['Output tokens', ai.outputTokens?.toLocaleString() ?? 'Not recorded'],
      ]} />}
      <Facts title="Context" items={[
        ['Identity', actingIdentity(event)], ['Origin', event.operationContext.source.kind], ['Request ID', event.id],
      ]} />
    </div>
    {observation?.error && <p className="traffic__evidence-note" role="status">Error: {observation.error.code}</p>}
    <div className="traffic__request-evidence">
      {ai ? <>
        <p className="traffic__evidence-note">Input: Not recorded</p>
        <details className="traffic__payload"><summary>Returned response</summary>{observation?.response
          ? <><pre tabIndex={0}>{observation.response.text}</pre>{observation.response.truncated && <p className="traffic__evidence-note">Preview truncated.</p>}</>
          : <p className="traffic__evidence-note">Response content: Not recorded</p>}</details>
      </> : <>
        <Payload label="Request" value={event.request} />
        <Payload label="Service evidence" value={event.detail} />
        <Payload label="Resource before" value={event.resourceBefore} />
        <Payload label="Resource after" value={event.resourceAfter} />
      </>}
      {target && <button className="traffic__resource-link" type="button" onClick={() => pushPath(target)}>Open resource</button>}
      {opensRulesInspector(event) && <details className="traffic__payload"><summary>Security Rules</summary><TrafficRulesInspector eventId={event.id} onClose={onClose} /></details>}
    </div>
  </section>;
}
