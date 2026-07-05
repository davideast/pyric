/**
 * The NL-seed assist UI, mounted above the Firestore data grid. Type a request,
 * the model generates documents (via the propose_seed tool), they are PREVIEWED,
 * then applied as admin writes (preview-before-apply). The selection-wide
 * `LlmClient` + the AssistPanel are shared with the other assists.
 */

import { useMemo, useState } from 'react';
import { useAssist } from '../../ai/useAssist.js';
import { AssistPanel } from '../../ai/AssistPanel.js';
import { useStudioDataSource, useStudioSeed, type SeedOp } from '../../shell/studio-data.js';
import { SEED_SYSTEM, buildSeedPrompt, makeProposeSeedTool } from './seed.js';
import './seed.css';

type ApplyState = 'idle' | 'applying' | { written: number; errors: string[] };

export function FirestoreSeedBox() {
  const data = useStudioDataSource();
  const applySeed = useStudioSeed();
  const [request, setRequest] = useState('');
  const [proposed, setProposed] = useState<SeedOp[] | null>(null);
  const [applied, setApplied] = useState<ApplyState>('idle');

  const collections = data.status === 'ready' ? data.handles.listRootCollections() : [];

  const tool = useMemo(() => makeProposeSeedTool({ onProposed: setProposed }), []);
  const tools = useMemo(() => [tool], [tool]);
  const assist = useAssist({ systemPrompt: SEED_SYSTEM, tools });

  const generate = () => {
    if (!request.trim()) return;
    setProposed(null);
    setApplied('idle');
    assist.run(buildSeedPrompt({ request: request.trim(), collections }));
  };
  const apply = async () => {
    if (!proposed) return;
    setApplied('applying');
    setApplied(await applySeed(proposed));
  };

  return (
    <div className="seed" data-pyric-ui="firestore-seed">
      <div className="seed__bar">
        <input
          className="seed__input"
          value={request}
          spellCheck={false}
          placeholder="Generate data with AI: e.g. add 10 users and 50 notes owned by them"
          onChange={(e) => setRequest(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') generate();
          }}
        />
        <button
          type="button"
          className="seed__btn"
          onClick={generate}
          disabled={assist.state.status === 'running' || !request.trim()}
        >
          {assist.state.status === 'running' ? 'Generating…' : '✨ Generate'}
        </button>
      </div>

      <AssistPanel state={assist.state} />

      {proposed ? (
        <div className="seed__preview" data-pyric-ui="seed-preview">
          <div className="seed__previewhead">
            <span className="seed__count">{proposed.length} document(s) to write</span>
            {typeof applied === 'object' ? (
              <span className="seed__applied">
                Wrote {applied.written}
                {applied.errors.length ? `, ${applied.errors.length} failed` : ''}.
              </span>
            ) : (
              <button
                type="button"
                className="seed__btn"
                onClick={() => void apply()}
                disabled={applied === 'applying'}
              >
                {applied === 'applying' ? 'Applying…' : `Apply ${proposed.length} document(s)`}
              </button>
            )}
          </div>
          <ul className="seed__list">
            {proposed.slice(0, 30).map((op, i) => (
              <li key={`${op.path}-${i}`} className="seed__item">
                <span className="seed__path">{op.path}</span>
                <span className="seed__data">{JSON.stringify(op.data)}</span>
              </li>
            ))}
            {proposed.length > 30 ? (
              <li className="seed__more">+{proposed.length - 30} more</li>
            ) : null}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
