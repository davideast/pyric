import { useEffect, useMemo, useState } from "react";
import type { AssuranceProbeResult } from "@pyric/cli/assurance";
import type { AssuranceVisualizationSnapshot } from "@pyric/cli/assurance/browser";
import { DenialDetail } from "../rules-debug/RulesDebug.js";
import { currentPath, replacePath } from "../../shell/router.js";
import {
  projectAssuranceRows,
  toRuleDecision,
  type AssuranceMatrixRow,
} from "./model.js";
import { useAssuranceCampaigns } from "./useAssuranceCampaigns.js";
import "./assurance.css";

export interface AssuranceSurfaceProps {
  campaigns?: readonly AssuranceVisualizationSnapshot[];
}

function verdictClass(expected: string, observed: string): string {
  if (expected !== observed) return "assurance-verdict--mismatch";
  return observed === "ALLOW"
    ? "assurance-verdict--allow"
    : "assurance-verdict--deny";
}

function classificationLabel(
  value: AssuranceProbeResult["classification"],
): string {
  return value.replaceAll("-", " ");
}

function JsonEvidence({ value }: { value: unknown }) {
  return (
    <pre className="assurance-evidence__json">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function CampaignEmpty() {
  return (
    <section
      className="assurance-empty"
      aria-labelledby="assurance-empty-title"
    >
      <p className="assurance-surface__eyebrow">
        Local authorization assurance
      </p>
      <h1 id="assurance-empty-title">No campaign in this Studio session</h1>
      <p>
        Campaigns appear here as the local assurance tools map actors, run
        controls, and test explicit security invariants.
      </p>
      <span className="assurance-local-state">
        Pyric sandboxes only | network off
      </span>
    </section>
  );
}

function AttachmentSummary({
  attachment,
}: {
  attachment: NonNullable<
    AssuranceVisualizationSnapshot["context"]
  >["attachment"];
}) {
  if (!attachment) return null;
  return (
    <div
      className="assurance-attachment"
      aria-label="Attached sandbox inventory"
    >
      <span>
        <strong>{attachment.source.origin}</strong>
        read-only clone
      </span>
      <span>
        <strong>{attachment.inventory.firestoreDocuments}</strong>
        Firestore docs
      </span>
      <span>
        <strong>{attachment.inventory.authUsers}</strong>
        Auth users
      </span>
      <span>
        <strong>
          {attachment.inventory.rtdbPresent ? "present" : "empty"}
        </strong>
        RTDB
      </span>
    </div>
  );
}

export function AssuranceSurface({
  campaigns: supplied,
}: AssuranceSurfaceProps) {
  const live = useAssuranceCampaigns();
  const campaigns = supplied ?? live;
  const query = currentPath().query;
  const [campaignId, setCampaignId] = useState(
    query.campaign ??
      campaigns.find((item) => item.report)?.campaignId ??
      campaigns[0]?.campaignId ??
      "",
  );
  const campaign =
    campaigns.find((item) => item.campaignId === campaignId) ?? campaigns[0];
  const rows = useMemo(
    () => (campaign?.report ? projectAssuranceRows(campaign.report) : []),
    [campaign],
  );
  const [probeId, setProbeId] = useState(query.probe ?? rows[0]?.id ?? "");

  useEffect(() => {
    if (!campaignId && campaigns[0]) setCampaignId(campaigns[0].campaignId);
  }, [campaignId, campaigns]);
  useEffect(() => {
    if (!rows.some((row) => row.id === probeId)) setProbeId(rows[0]?.id ?? "");
  }, [rows, probeId]);

  if (!campaign) return <CampaignEmpty />;
  const attachment = campaign.context?.attachment;
  const report = campaign.report;
  if (!report) {
    return (
      <section
        className="assurance-empty"
        aria-labelledby="assurance-mapped-title"
      >
        <p className="assurance-surface__eyebrow">{campaign.campaignId}</p>
        <h1 id="assurance-mapped-title">
          Campaign mapped, awaiting its first run
        </h1>
        <p>
          {campaign.observations.length} known-good operation(s) and{" "}
          {campaign.probes.length} probe(s) are available.
        </p>
        <AttachmentSummary attachment={attachment} />
        {attachment?.coverageGaps.length ? (
          <ul
            className="assurance-coverage-gaps"
            aria-label="Attachment coverage gaps"
          >
            {attachment.coverageGaps.map((gap) => (
              <li key={gap.code}>
                <code>{gap.service}</code>
                {gap.reason}
              </li>
            ))}
          </ul>
        ) : null}
        <span className="assurance-local-state">
          Pyric sandboxes only | network off
        </span>
      </section>
    );
  }

  const selectedRow = rows.find((row) => row.id === probeId) ?? rows[0];
  const selected = report.results.find(
    (result) => result.probeId === selectedRow?.id,
  );
  const ruleDecision = selected ? toRuleDecision(selected) : null;
  const verification = campaign.verifications?.at(-1);
  const verificationPassed =
    verification !== undefined &&
    verification.summary.controlsPassed === verification.summary.probes &&
    verification.summary.noCounterexamples === verification.summary.probes &&
    verification.summary.localCounterexamples === 0 &&
    verification.summary.engineGaps === 0 &&
    verification.summary.invalidProbes === 0;

  function chooseCampaign(next: string) {
    setCampaignId(next);
    const nextCampaign = campaigns.find((item) => item.campaignId === next);
    const nextProbe = nextCampaign?.report?.results[0]?.probeId ?? "";
    setProbeId(nextProbe);
    replacePath({
      tab: "assurance",
      query: { campaign: next, probe: nextProbe || undefined },
    });
  }

  function chooseProbe(row: AssuranceMatrixRow) {
    setProbeId(row.id);
    replacePath({
      tab: "assurance",
      query: { campaign: campaign.campaignId, probe: row.id },
    });
  }

  return (
    <section className="assurance-surface" aria-labelledby="assurance-title">
      <header className="assurance-surface__header">
        <div>
          <p className="assurance-surface__eyebrow">
            Local authorization assurance
          </p>
          <h1 id="assurance-title">{campaign.campaignId}</h1>
        </div>
        <div className="assurance-surface__controls">
          {campaigns.length > 1 ? (
            <label>
              <span>Campaign</span>
              <select
                value={campaign.campaignId}
                onChange={(event) => chooseCampaign(event.target.value)}
              >
                {campaigns.map((item) => (
                  <option key={item.campaignId} value={item.campaignId}>
                    {item.campaignId}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <span className="assurance-local-state">
            Pyric sandboxes only | network off
          </span>
        </div>
      </header>

      <AttachmentSummary attachment={attachment} />

      <div className="assurance-summary" aria-label="Campaign summary">
        <div>
          <span>Controls</span>
          <strong>
            {report.summary.controlsPassed}/{report.summary.probes}
          </strong>
        </div>
        <div>
          <span>Counterexamples</span>
          <strong>{report.summary.localCounterexamples}</strong>
        </div>
        <div>
          <span>Candidate signals</span>
          <strong>{report.summary.candidateSignals}</strong>
        </div>
        <div>
          <span>Engine gaps</span>
          <strong>{report.summary.engineGaps}</strong>
        </div>
        <div>
          <span>Coverage gaps</span>
          <strong>{attachment?.coverageGaps.length ?? 0}</strong>
        </div>
      </div>

      {verification ? (
        <div
          className={`assurance-verification-band assurance-verification-band--${verificationPassed ? "passed" : "failed"}`}
          role="status"
        >
          <strong>
            {verificationPassed
              ? "Candidate rules verified"
              : "Candidate rules need review"}
          </strong>
          <span>
            {verification.summary.controlsPassed}/{verification.summary.probes}{" "}
            controls preserved
            {" | "}
            {verification.summary.noCounterexamples}/
            {verification.summary.probes} negative cases denied
          </span>
          <code>{verification.campaignId}</code>
        </div>
      ) : null}

      {attachment?.coverageGaps.length ? (
        <div className="assurance-coverage-band">
          <strong>{attachment.coverageGaps.length} attachment gap(s)</strong>
          <span>
            {attachment.coverageGaps
              .map((gap) => `${gap.service}: ${gap.reason}`)
              .join(" ")}
          </span>
        </div>
      ) : null}

      <div className="assurance-workspace">
        <section
          className="assurance-matrix"
          aria-labelledby="assurance-matrix-title"
        >
          <div className="assurance-section-heading">
            <h2 id="assurance-matrix-title">Expected and observed access</h2>
            <span>{report.targetHash}</span>
          </div>
          <div className="assurance-table" role="table">
            <div className="assurance-table__header" role="row">
              <span role="columnheader">Operation</span>
              <span role="columnheader">Actor</span>
              <span role="columnheader">Expected</span>
              <span role="columnheader">Observed</span>
              <span role="columnheader">Impact</span>
            </div>
            {rows.map((row) => (
              <button
                key={row.id}
                type="button"
                className="assurance-table__row"
                aria-pressed={row.id === selectedRow?.id}
                onClick={() => chooseProbe(row)}
                role="row"
              >
                <span role="cell">
                  <small>{row.service}</small>
                  {row.operation}
                </span>
                <span role="cell">{row.actor}</span>
                <span
                  role="cell"
                  className={`assurance-verdict ${row.expected === "ALLOW" ? "assurance-verdict--allow" : "assurance-verdict--deny"}`}
                >
                  {row.expected}
                </span>
                <span
                  role="cell"
                  className={`assurance-verdict ${verdictClass(row.expected, row.observed)}`}
                >
                  {row.observed}
                </span>
                <span role="cell">{row.impact}</span>
              </button>
            ))}
          </div>
        </section>

        {selected ? (
          <aside
            className="assurance-inspector"
            aria-labelledby="assurance-inspector-title"
          >
            <div className="assurance-section-heading">
              <div>
                <span
                  className={`assurance-classification assurance-classification--${selected.classification}`}
                >
                  {classificationLabel(selected.classification)}
                </span>
                <h2 id="assurance-inspector-title">{selected.probeId}</h2>
              </div>
              <span>{selected.actorEvidence.reachability}</span>
            </div>

            <dl className="assurance-facts">
              <div>
                <dt>Invariant</dt>
                <dd>{selected.invariant.statement}</dd>
              </div>
              <div>
                <dt>Mutation</dt>
                <dd>{selected.mutationSpec.description}</dd>
              </div>
              <div>
                <dt>Actor</dt>
                <dd>
                  {selected.actorEvidence.uid ?? selected.actorEvidence.actorId}{" "}
                  via {selected.actorEvidence.acquisition}
                </dd>
              </div>
              <div>
                <dt>Fidelity</dt>
                <dd>
                  {selected.qualification.supported
                    ? "Supported for this probe"
                    : "Engine gap"}
                </dd>
              </div>
            </dl>

            {selected.qualification.requirements.some(
              (item) => !item.supported,
            ) ? (
              <ul className="assurance-gaps">
                {selected.qualification.requirements
                  .filter((item) => !item.supported)
                  .map((item) => (
                    <li key={item.id}>
                      <code>{item.id}</code>
                      {item.reason}
                    </li>
                  ))}
              </ul>
            ) : null}

            {selected.stateDiff ? (
              <section
                className="assurance-evidence"
                aria-labelledby="assurance-state-title"
              >
                <h3 id="assurance-state-title">State evidence</h3>
                <div className="assurance-evidence__diff">
                  <div>
                    <span>Before</span>
                    <JsonEvidence value={selected.stateDiff.before} />
                  </div>
                  <div>
                    <span>After</span>
                    <JsonEvidence value={selected.stateDiff.after} />
                  </div>
                </div>
              </section>
            ) : null}

            {ruleDecision ? (
              <section
                className="assurance-rule-decision"
                aria-labelledby="assurance-rule-title"
              >
                <h3 id="assurance-rule-title">Rule decision</h3>
                <DenialDetail denial={ruleDecision} />
              </section>
            ) : (
              <p className="assurance-no-decision">
                This service recorded operation and state evidence but no
                canonical rule-decision event.
              </p>
            )}
          </aside>
        ) : null}
      </div>
    </section>
  );
}
