/**
 * In-place rules inspection for observed Live mode traffic rows (Firestore and
 * Realtime Database).
 *
 * Decided local evaluations (`production.local.result === 'allow' | 'deny'`)
 * mount {@link DenialDetail} over the local trace or RTDB rule cascade under
 * production's verdict. Unevaluated local verdicts (`result === 'unevaluated'`)
 * render production's verdict, the rule node and source line (marked as
 * neutral context rather than ✓/✗), `$variable` bindings, and the missing
 * runtime inputs that prevented local proof. Decided verdicts read as what the
 * local rules would do, beneath what production did.
 */

import type { ReactNode } from 'react';
import { Badge } from '@pyric/ui/primitives';
import {
  DenialDetail,
  LazyRulesCodeEditor,
  resolveMarkedLine,
} from '../rules-debug/index.js';
import {
  stripPyricSourceMap,
  useStudioRulesSource,
} from '../../shell/studio-rules-source.js';
import { TrafficRulesInspector } from './TrafficRulesInspector.js';
import {
  liveRuleEvaluation,
  liveUnevaluatedInspection,
  localDrift,
  opensLiveRulesInspector,
  productionLabel,
  type LiveUnevaluatedInspection,
  type LiveUnevaluatedRuleContext,
  type StudioTrafficEvent,
} from './verdict.js';

const DRIFT_REASON =
  "The local rules file differs from the deployed rules, or pyric's rules engine differs from production's.";

function InspectorHeader({ onClose }: { onClose: () => void }) {
  return (
    <div className="traffic__inspector-bar">
      <span className="traffic__inspector-title">rules inspector</span>
      <button
        type="button"
        className="traffic__inspector-close"
        onClick={onClose}
        aria-label="Close rules inspector (Esc)"
      >
        close (esc)
      </button>
    </div>
  );
}

function UnevaluatedField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-slate-gray">
        {label}
      </span>
      {children}
    </div>
  );
}

function buildMissingPathsRuleLabel(
  ruleContext: LiveUnevaluatedRuleContext | undefined,
  missingPaths: readonly string[],
): string {
  let pathNoun = `uncaptured paths ${missingPaths.join(', ')}`;
  if (missingPaths.length === 1) {
    pathNoun = `uncaptured path ${missingPaths[0]}`;
  }
  const parts = [`Matched rule — paused on ${pathNoun}`];
  if (ruleContext?.nodeLabel !== undefined) parts.push(ruleContext.nodeLabel);
  if (ruleContext?.line !== undefined) parts.push(`line ${ruleContext.line}`);
  return parts.join(' · ');
}

/**
 * The heading over an unevaluated verdict's rule. When `missingPaths` names the
 * exact uncaptured path(s) the rule paused on, lead with those paths alongside
 * the matched rule; otherwise preserve the service-specific heading.
 */
function buildApplicableRuleLabel(
  ruleContext: LiveUnevaluatedRuleContext | undefined,
  missingPaths: readonly string[] | undefined,
): string {
  if (missingPaths !== undefined && missingPaths.length > 0) {
    return buildMissingPathsRuleLabel(ruleContext, missingPaths);
  }
  if (ruleContext === undefined || ruleContext.nodeLabel === undefined) {
    return 'applicable local rules';
  }
  let lead = 'applicable rule';
  if (ruleContext.engine === 'firestore') lead = 'rule evaluated with missing inputs';
  if (ruleContext.line !== undefined) {
    return `${lead} — ${ruleContext.nodeLabel} · line ${ruleContext.line}`;
  }
  return `${lead} — ${ruleContext.nodeLabel}`;
}

function buildSourceAriaLabel(service: string, hasLine: boolean): string {
  const fileLabel = service === 'rtdb' ? 'database.rules.json' : 'firestore.rules';
  if (!hasLine) return `Local ${fileLabel}`;
  if (service === 'rtdb') return `Local ${fileLabel}, the applicable rule is marked`;
  return `Local ${fileLabel}, the rule evaluated with missing inputs is marked`;
}

function UnevaluatedRuleSection({
  inspection,
  rawRulesSource,
}: {
  inspection: LiveUnevaluatedInspection;
  rawRulesSource: string;
}) {
  const ruleContext = inspection.ruleContext;
  const isFirestore = inspection.service !== 'rtdb';
  let cleanSource = rawRulesSource;
  if (isFirestore) {
    cleanSource = stripPyricSourceMap(rawRulesSource);
  }
  const hasSource = cleanSource.trim().length > 0;
  const rawLine = ruleContext?.line;
  let markedLine = rawLine;
  if (isFirestore) {
    markedLine = resolveMarkedLine(rawRulesSource, rawLine);
  }
  const hasBindings =
    ruleContext?.pathVariableBindings !== undefined &&
    Object.keys(ruleContext.pathVariableBindings).length > 0;

  const isEmptyRuleSection =
    !hasSource && ruleContext === undefined && inspection.missingPaths === undefined;
  if (isEmptyRuleSection) {
    return null;
  }

  const label = buildApplicableRuleLabel(ruleContext, inspection.missingPaths);
  const ariaLabel = buildSourceAriaLabel(inspection.service, markedLine !== undefined);
  let ruleBody: ReactNode = null;
  if (hasSource) {
    ruleBody = (
      <div data-pyric-ui="live-unevaluated-rule-source" data-marked-line={markedLine}>
        <LazyRulesCodeEditor
          value={cleanSource}
          readOnly
          markLine={markedLine}
          markKind="context"
          minHeightRem={12}
          ariaLabel={ariaLabel}
        />
      </div>
    );
  } else if (ruleContext?.expression !== undefined) {
    ruleBody = (
      <pre className="overflow-auto rounded-md border border-border bg-content-bg p-3 font-mono text-xs leading-relaxed text-slate-gray">
        {ruleContext.expression}
      </pre>
    );
  }

  return (
    <>
      <UnevaluatedField label={label}>
        {ruleContext === undefined ? (
          <p className="text-xs leading-relaxed text-slate-gray">
            No direct rule sits at <code>{inspection.path}</code>; child rules may still apply to
            nested paths in the write payload.
          </p>
        ) : null}
        {ruleBody}
      </UnevaluatedField>
      {hasBindings && ruleContext?.pathVariableBindings !== undefined ? (
        <UnevaluatedField label="$variable bindings">
          <code className="font-mono text-xs text-soft-white">
            {Object.entries(ruleContext.pathVariableBindings)
              .map(([name, value]) => `${name.startsWith('$') ? name : `$${name}`} → ${value}`)
              .join(', ')}
          </code>
        </UnevaluatedField>
      ) : null}
    </>
  );
}

function UnevaluatedAuthSection({ event }: { event: StudioTrafficEvent }) {
  const uid = event.auth?.uid;
  const claimNames = event.production?.claimNames;
  const hasClaimNames = claimNames !== undefined && claimNames.length > 0;
  return (
    <UnevaluatedField label="observed request context">
      <div
        data-pyric-ui="live-unevaluated-context"
        className="flex flex-col gap-1 rounded-md border border-border bg-content-bg p-3 font-mono text-xs"
      >
        {uid !== undefined && uid !== '' ? (
          <>
            <span className="text-soft-white">auth.uid: {uid}</span>
            {hasClaimNames ? (
              <span className="text-slate-gray">token claim names: {claimNames.join(', ')}</span>
            ) : null}
          </>
        ) : (
          <span className="italic text-slate-gray">
            unauthenticated — auth was null for this call.
          </span>
        )}
      </div>
    </UnevaluatedField>
  );
}

function MissingPathsPills({ missingPaths }: { missingPaths: readonly string[] | undefined }) {
  if (missingPaths === undefined || missingPaths.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5 pt-0.5">
      {missingPaths.map((missingPath) => (
        <code
          key={missingPath}
          data-missing-path={missingPath}
          className="rounded border border-border bg-sidebar-bg px-1.5 py-0.5 font-mono text-[11px] text-soft-white"
        >
          {missingPath}
        </code>
      ))}
    </div>
  );
}

function LiveUnevaluatedDetailBody({
  event,
  inspection,
  rulesSource,
}: {
  event: StudioTrafficEvent;
  inspection: LiveUnevaluatedInspection;
  rulesSource: string;
}) {
  const servicePrefix = inspection.service !== 'firestore' ? `${inspection.service} · ` : '';
  return (
    <div
      data-pyric-ui="live-unevaluated-detail"
      className="flex min-h-0 flex-col gap-4 overflow-auto rounded-lg border border-border bg-sidebar-bg p-5"
    >
      <section>
        <div className="mb-2 flex items-center gap-2">
          <Badge
            kind="unevaluated"
            className="rounded bg-content-bg px-2 py-0.5 text-xs font-semibold uppercase text-slate-gray"
          >
            not evaluated locally
          </Badge>
          <span className="font-mono text-sm text-soft-white">
            {servicePrefix}
            {inspection.rawMethod} {inspection.path}
          </span>
        </div>
        <p className="text-sm leading-relaxed text-soft-white">{inspection.headline}</p>
      </section>

      <UnevaluatedField label="missing runtime context">
        <ul
          data-pyric-ui="live-unevaluated-needs"
          className="flex flex-col gap-2 rounded-md border border-border bg-content-bg p-3"
        >
          {inspection.gaps.map((gap) => (
            <li key={gap.gap} data-live-need={gap.gap} className="flex flex-col gap-1">
              <code className="font-mono text-xs text-primary">{gap.label}</code>
              <p className="m-0 text-xs leading-relaxed text-slate-gray">{gap.detail}</p>
              {gap.gap === 'stored-document' && (
                <MissingPathsPills missingPaths={inspection.missingPaths} />
              )}
            </li>
          ))}
        </ul>
      </UnevaluatedField>

      <UnevaluatedRuleSection inspection={inspection} rawRulesSource={rulesSource} />

      <UnevaluatedAuthSection event={event} />
    </div>
  );
}

/**
 * A live op's local rules view under production's verdict: the decided
 * evaluation, worded as what the local rules would do, or the unevaluated
 * verdict's missing inputs. `null` for an op with neither. `header` leads it
 * and `showDrift` adds the drift sentence when the host that mounts it does
 * not show one already.
 */
export function LiveRulesView({
  event,
  className,
  header,
  showDrift,
}: {
  event: StudioTrafficEvent;
  className: string;
  header?: ReactNode;
  showDrift: boolean;
}) {
  const service = event.service ?? 'firestore';
  const rulesSource = useStudioRulesSource(service, event.instance);
  const production = event.production;
  const evaluation = liveRuleEvaluation(event, rulesSource);
  let unevaluated: LiveUnevaluatedInspection | undefined;
  if (evaluation === undefined) {
    unevaluated = liveUnevaluatedInspection(event, rulesSource);
  }
  if (evaluation === undefined && unevaluated === undefined) return null;
  const drifts = showDrift && localDrift(event) !== undefined;
  let body: ReactNode = null;
  if (evaluation !== undefined) {
    body = <DenialDetail denial={evaluation} rulesSource={rulesSource} advisory />;
  } else if (unevaluated !== undefined) {
    body = <LiveUnevaluatedDetailBody event={event} inspection={unevaluated} rulesSource={rulesSource} />;
  }
  return (
    <div
      data-pyric-ui="traffic-live-rules-inspector"
      data-live-unevaluated={unevaluated === undefined ? undefined : ''}
      className={className}
    >
      {header}
      {production === undefined ? null : (
        <p className="traffic__live-production" data-production-verdict={production.outcome.status}>
          {productionLabel(production)}
        </p>
      )}
      {drifts ? (
        <p className="traffic__drift-reason" data-drift-reason="">
          {DRIFT_REASON}
        </p>
      ) : null}
      {body}
    </div>
  );
}

/**
 * Resolves `?inspect=<id>` to either the Live mode rules inspector (for
 * observed ops with a decided or unevaluated local verdict) or the sandbox
 * rules inspector.
 */
export function TrafficInspectedDetail({
  eventId,
  events,
  onClose,
}: {
  eventId: string;
  events: readonly StudioTrafficEvent[];
  onClose: () => void;
}) {
  const event = events.find((candidate) => candidate.id === eventId);
  if (event !== undefined && opensLiveRulesInspector(event)) {
    return (
      <LiveRulesView
        event={event}
        className="traffic__inspector"
        header={<InspectorHeader onClose={onClose} />}
        showDrift
      />
    );
  }
  return <TrafficRulesInspector eventId={eventId} onClose={onClose} />;
}
