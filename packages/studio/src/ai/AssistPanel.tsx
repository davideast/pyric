/**
 * Renders one assist run's state (from `useAssist`): the streamed answer, any
 * tool steps, a running indicator, and an error state that links to settings
 * (covers both "no key" and a provider error like CORS). Reused by every assist.
 */

import type { ReactNode } from 'react';
import { openSettings } from './settings-store.js';
import type { AssistState } from './useAssist.js';
import './ai.css';

export function AssistPanel({
  state,
  idle,
}: {
  state: AssistState;
  /** Optional content shown before a run starts (e.g. a hint). */
  idle?: ReactNode;
}) {
  if (state.status === 'idle') return idle ? <>{idle}</> : null;

  return (
    <div className="ai-panel" data-pyric-ui="ai-panel" data-state={state.status}>
      {state.steps.length > 0 ? (
        <ul className="ai-panel__steps">
          {state.steps.map((s) => (
            <li key={s.callId} className="ai-panel__step" data-status={s.status}>
              <span className="ai-panel__stepname">{s.name}</span>
              {s.summary ? <span className="ai-panel__stepsummary">{s.summary}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}

      {state.text ? <div className="ai-panel__text">{state.text}</div> : null}

      {state.status === 'running' ? <span className="ai-panel__running">Thinking…</span> : null}

      {state.status === 'error' ? (
        <div className="ai-panel__error">
          <p className="ai-panel__errmsg">{state.error}</p>
          <button type="button" className="ai-panel__settingslink" onClick={openSettings}>
            Open AI settings
          </button>
        </div>
      ) : null}
    </div>
  );
}
