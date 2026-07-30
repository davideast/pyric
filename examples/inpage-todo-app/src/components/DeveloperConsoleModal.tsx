import React, { useState, useTransition } from 'react';
import { useWorkspace, usePresence, useActivityStream } from '../context/WorkspaceContext';

interface DeveloperConsoleModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAcceptAiTask: (title: string, category: string, priority: 'Low' | 'Medium' | 'High') => Promise<void>;
  onError: (title: string, err: any) => void;
  fcmToken: string | null;
}

export const DeveloperConsoleModal: React.FC<DeveloperConsoleModalProps> = ({
  isOpen,
  onClose,
  onAcceptAiTask,
  onError,
  fcmToken,
}) => {
  const { appService, sandboxDriver } = useWorkspace();
  const presenceUids = usePresence();
  const activityEvents = useActivityStream();

  const [tab, setTab] = useState<'db' | 'rtdb' | 'ai' | 'fcm'>('db');
  const [aiPrompt, setAiPrompt] = useState('Generate 3 high-impact onboarding milestones for security engineering');
  const [aiScenario, setAiScenario] = useState<'success' | 'malformed' | 'quota_error'>('success');
  const [aiSuggestions, setAiSuggestions] = useState<Array<{ title: string; category: string; priority: string }>>([]);
  const [aiRaw, setAiRaw] = useState<string>('');
  const [aiStatus, setAiStatus] = useState<string>('READY');
  const [isAiPending, startAiTransition] = useTransition();

  if (!isOpen) return null;

  const summary = sandboxDriver.getInspectorSummary();

  const handleGenerateTasks = () => {
    startAiTransition(async () => {
      try {
        if (aiScenario === 'quota_error') {
          throw { code: 'RESOURCE_EXHAUSTED', message: 'Simulated 429 Quota Exceeded error from generative AI broker.' };
        }

        const promptText =
          aiScenario === 'malformed'
            ? 'Return unstructured plaintext markdown instead of valid JSON array'
            : aiPrompt || 'Generate 3 high-impact onboarding tasks';

        if (aiScenario === 'malformed') {
          setAiRaw(`Sure, here are some task recommendations:\n1. Audit security rules\n2. Configure IAM profiles\n3. Enable encryption`);
          setAiStatus('SCHEMA_VALIDATION_REJECTED');
          setAiSuggestions([]);
          return;
        }

        const res = await appService.generateTaskSuggestions(promptText);
        setAiRaw(res.raw);
        setAiStatus(`VALID_SCHEMA (${res.items.length} items)`);
        setAiSuggestions(res.items);
      } catch (err: any) {
        setAiStatus('AI_SERVICE_ERROR');
        setAiRaw(JSON.stringify({ error: err.message, code: err.code || 'UNKNOWN' }, null, 2));
        setAiSuggestions([]);
        onError('Firebase AI Logic Service Error', err);
      }
    });
  };

  const handleSimulatePush = async (type: 'overdue' | 'update' | 'silent') => {
    try {
      if (!fcmToken) {
        onError('FCM Simulation Denied', {
          message: 'Must enable push notification enrollment before delivering simulated payloads.',
        });
        return;
      }
      await sandboxDriver.deliverSimulatedPush(type, appService.messaging);
    } catch (err) {
      onError('Simulated Push Delivery Failure', err);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4 sm:p-6 backdrop-blur-md select-text cursor-default">
      <div className="w-full h-full max-w-6xl rounded-2xl bg-zinc-900 border border-zinc-800 shadow-2xl flex flex-col overflow-hidden">
        {/* Console Header */}
        <header className="flex items-center justify-between p-5 border-b border-zinc-800 bg-zinc-950/60 shrink-0">
          <div className="flex items-center gap-3">
            <span className="p-2 rounded-xl bg-purple-500/20 text-purple-300 font-mono text-xs font-bold border border-purple-500/30">
              Pyric Console
            </span>
            <div className="flex flex-col">
              <h2 className="text-base font-bold text-white">
                Authoritative Sandbox Simulation Workspace
              </h2>
              <span className="text-xs text-zinc-400">
                Inspect database structures, trigger atomic fan-out writes, and evaluate declarative security rules in real time.
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-white font-bold text-xs border border-zinc-700 transition-colors"
          >
            &times; Close Console
          </button>
        </header>

        {/* Console Tabs */}
        <nav className="flex items-center gap-2 p-3 border-b border-zinc-800 bg-zinc-900 overflow-x-auto shrink-0">
          <button
            type="button"
            onClick={() => setTab('db')}
            className={`px-4 py-2 rounded-md text-xs font-bold shrink-0 ${tab === 'db' ? 'bg-white text-zinc-950 shadow-sm' : 'text-zinc-400 hover:bg-zinc-800 font-semibold'}`}
          >
            🗄️ Firestore & Storage Rules
          </button>
          <button
            type="button"
            onClick={() => setTab('rtdb')}
            className={`px-4 py-2 rounded-md text-xs font-bold shrink-0 ${tab === 'rtdb' ? 'bg-white text-zinc-950 shadow-sm' : 'text-zinc-400 hover:bg-zinc-800 font-semibold'}`}
          >
            📡 Realtime Database (RTDB)
          </button>
          <button
            type="button"
            onClick={() => setTab('ai')}
            className={`px-4 py-2 rounded-md text-xs font-bold shrink-0 ${tab === 'ai' ? 'bg-white text-zinc-950 shadow-sm' : 'text-zinc-400 hover:bg-zinc-800 font-semibold'}`}
          >
            🤖 AI Logic Assistant
          </button>
          <button
            type="button"
            onClick={() => setTab('fcm')}
            className={`px-4 py-2 rounded-md text-xs font-bold shrink-0 ${tab === 'fcm' ? 'bg-white text-zinc-950 shadow-sm' : 'text-zinc-400 hover:bg-zinc-800 font-semibold'}`}
          >
            📬 Cloud Messaging (FCM)
          </button>
        </nav>

        {/* TAB 1: DB & Storage Rules */}
        {tab === 'db' ? (
          <div className="flex-1 p-6 flex flex-col gap-5 overflow-y-auto text-xs">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 p-4 rounded-xl bg-zinc-900/60 border border-zinc-800">
              <div className="flex flex-col gap-1">
                <span className="text-zinc-400">Active Identity:</span>
                <strong className="text-white font-mono text-[11px] truncate">
                  {summary.currentUid}
                </strong>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-zinc-400">Total Documents:</span>
                <strong className="text-white font-mono text-sm">
                  {summary.totalDocuments} items
                </strong>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-zinc-400">Collections:</span>
                <strong className="text-white text-sm capitalize">
                  {summary.collections.join(', ') || 'todos'}
                </strong>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-zinc-400">Event Operations:</span>
                <strong className="text-white font-mono text-sm">
                  {summary.totalEvents} ops
                </strong>
              </div>
            </div>

            {summary.recentDenials.length === 0 ? (
              <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 font-medium text-xs">
                ✓ Zero security rule denials recorded in this session.
              </div>
            ) : (
              <div className="flex flex-col gap-2 pt-2 border-t border-zinc-800">
                <span className="font-bold text-red-400 text-xs">
                  Recent Rule Denials ({summary.recentDenials.length}):
                </span>
                <div className="flex flex-col gap-2 max-h-48 overflow-y-auto">
                  {summary.recentDenials.map((d, i) => (
                    <div
                      key={i}
                      className="p-2 rounded bg-red-500/10 border border-red-500/30 font-mono text-[11px] text-red-300 flex flex-col gap-1"
                    >
                      <span>
                        {d.method} {d.path} (uid: {d.auth ? d.auth.uid : 'null'})
                      </span>
                      <span>
                        Line {d.rule?.line || '?'}: {d.rule?.expression || ''}
                      </span>
                      <pre className="text-[10px] whitespace-pre-wrap">
                        {(d.reasons || []).join('\n')}
                      </pre>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex-1 flex flex-col gap-2 pt-2 border-t border-zinc-800 min-h-[200px]">
              <span className="font-bold text-xs text-white">
                Active Firestore Security Rules:
              </span>
              <pre className="flex-1 p-4 rounded-xl bg-zinc-950 border border-zinc-800 text-zinc-300 font-mono text-xs overflow-auto select-text">
                {summary.activeFirestoreRules}
              </pre>
            </div>
          </div>
        ) : null}

        {/* TAB 2: RTDB Simulation */}
        {tab === 'rtdb' ? (
          <div className="flex-1 p-6 flex flex-col gap-6 overflow-y-auto text-xs">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="flex flex-col gap-2.5 p-4 rounded-xl bg-zinc-950 border border-zinc-800">
                <strong className="text-white font-bold text-sm">👤 User Presence Control</strong>
                <p className="text-zinc-400 leading-relaxed">
                  Simulate live client heartbeats by toggling your online status in the{' '}
                  <code className="text-emerald-400 font-mono">/presence/$uid</code> path.
                </p>
                <button
                  type="button"
                  onClick={() => sandboxDriver.togglePresence().catch((err) => onError('RTDB Presence Modification Failed', err))}
                  className="mt-auto py-2 px-3 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-bold transition-colors"
                >
                  Toggle Presence State
                </button>
              </div>
              <div className="flex flex-col gap-2.5 p-4 rounded-xl bg-zinc-950 border border-zinc-800">
                <strong className="text-white font-bold text-sm">⚡ Atomic Fan-Out Write</strong>
                <p className="text-zinc-400 leading-relaxed">
                  Execute a multi-path atomic transaction updating both{' '}
                  <code className="text-blue-400 font-mono">/shared_fanout</code> and{' '}
                  <code className="text-blue-400 font-mono">/activity_stream</code> simultaneously.
                </p>
                <button
                  type="button"
                  onClick={() => sandboxDriver.triggerAtomicFanOut().catch((err) => onError('RTDB Atomic Fan-Out Failed', err))}
                  className="mt-auto py-2 px-3 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-bold transition-colors"
                >
                  Trigger Atomic Write
                </button>
              </div>
              <div className="flex flex-col gap-2.5 p-4 rounded-xl bg-zinc-950 border border-zinc-800">
                <strong className="text-white font-bold text-sm">🛑 Declarative Rule Denial</strong>
                <p className="text-zinc-400 leading-relaxed">
                  Attempt writing a malformed payload to trigger an intentional{' '}
                  <code className="text-red-400 font-mono">.validate</code> failure in RTDB Security Rules.
                </p>
                <button
                  type="button"
                  onClick={() => sandboxDriver.testRtdbRuleDenial().catch((err) => onError('RTDB Declarative Rule Validation Failure (.validate Mismatch)', err))}
                  className="mt-auto py-2 px-3 rounded-lg bg-red-600 hover:bg-red-700 text-white font-bold transition-colors"
                >
                  Test .validate Denial
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 flex-1 min-h-[260px]">
              <div className="flex flex-col gap-3 p-4 rounded-xl bg-zinc-950 border border-zinc-800">
                <span className="font-bold text-white text-sm">
                  Active Presence Users (<code className="text-emerald-400 font-mono">/presence</code>):
                </span>
                <div className="flex-1 flex flex-col gap-2 p-3 rounded-lg bg-zinc-900 border border-zinc-800 overflow-y-auto max-h-48">
                  {presenceUids.length === 0 ? (
                    <p className="text-zinc-500 italic">No users currently active in presence tree.</p>
                  ) : (
                    presenceUids.map((uid) => (
                      <div
                        key={uid}
                        className="p-2 rounded bg-zinc-900 border border-zinc-800 text-xs text-emerald-400 font-mono font-semibold flex items-center gap-2"
                      >
                        <span>🟢</span>
                        <span>{uid}</span>
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div className="flex flex-col gap-3 p-4 rounded-xl bg-zinc-950 border border-zinc-800">
                <span className="font-bold text-white text-sm">
                  Live Activity Stream (<code className="text-blue-400 font-mono">/activity_stream</code>):
                </span>
                <div className="flex-1 flex flex-col gap-2 p-3 rounded-lg bg-zinc-900 border border-zinc-800 overflow-y-auto max-h-48">
                  {activityEvents.length === 0 ? (
                    <p className="text-zinc-500 italic">Awaiting activity stream events...</p>
                  ) : (
                    activityEvents.map((evt, idx) => {
                      const timeStr = new Date(evt.timestamp).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                      });
                      return (
                        <div
                          key={idx}
                          className="p-1.5 rounded bg-zinc-900 border border-zinc-800 text-[11px] font-mono flex items-center gap-2"
                        >
                          <span className="text-zinc-500 shrink-0">[{timeStr}]</span>
                          <strong className="text-zinc-200">{evt.user}:</strong>{' '}
                          <span className="text-zinc-300">{evt.action}</span>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-2 border-t border-zinc-800 pt-4 text-xs">
              <span className="font-bold text-zinc-300">
                Active Realtime Database (.read / .write / .validate) Rules:
              </span>
              <pre className="p-4 rounded-xl bg-zinc-950 border border-zinc-800 font-mono text-zinc-300 overflow-x-auto">
                {JSON.stringify(summary.activeRtdbRulesJson, null, 2)}
              </pre>
            </div>
          </div>
        ) : null}

        {/* TAB 3: AI Logic Assistant */}
        {tab === 'ai' ? (
          <div className="flex-1 p-6 flex flex-col gap-6 overflow-y-auto text-xs">
            <div className="flex flex-col sm:flex-row gap-4 justify-between items-start sm:items-center p-4 rounded-xl bg-purple-500/10 border border-purple-500/25">
              <div className="flex flex-col gap-1">
                <strong className="text-white font-bold text-sm flex items-center gap-2">
                  <span>🤖</span>
                  <span>Firebase AI Logic Scripting & Task Assistant</span>
                </strong>
                <span className="text-zinc-300">
                  Evaluates schema-validating generative suggestions before persisting to Firestore.
                </span>
              </div>
              <div className="flex items-center gap-2">
                <label className="text-xs font-semibold text-purple-300">Test Scenario:</label>
                <select
                  value={aiScenario}
                  onChange={(e) => {
                    const val = e.target.value as any;
                    setAiScenario(val);
                    sandboxDriver.setAiScenario(val);
                  }}
                  className="h-9 rounded-lg bg-zinc-900 border border-purple-500/40 text-purple-200 font-bold px-3 text-xs"
                >
                  <option value="success">✅ Valid Schema (Success)</option>
                  <option value="malformed">⚠️ Malformed Schema output</option>
                  <option value="quota_error">🛑 429 Quota Exceeded exception</option>
                </select>
              </div>
            </div>

            <div className="flex flex-col sm:flex-row gap-3">
              <input
                type="text"
                placeholder="e.g. Generate 3 actionable onboarding milestones for security engineering..."
                value={aiPrompt}
                onChange={(e) => setAiPrompt(e.target.value)}
                className="h-11 flex-1 rounded-xl bg-zinc-950 border border-zinc-800 px-4 text-sm text-white focus:outline-none focus:border-purple-500"
              />
              <button
                type="button"
                onClick={handleGenerateTasks}
                disabled={isAiPending}
                className="h-11 px-6 rounded-xl bg-purple-600 hover:bg-purple-700 text-white font-bold text-sm shadow-md transition-colors shrink-0 disabled:opacity-50"
              >
                {isAiPending ? '⏳ Synthesizing...' : '✨ Generate Tasks'}
              </button>
            </div>

            {aiStatus !== 'READY' ? (
              <div className="flex flex-col gap-6 pt-2 border-t border-zinc-800">
                <div className="flex flex-col gap-3">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-white text-sm">
                      Suggested Tasks (Pre-Write Validation):
                    </span>
                    <span className="font-mono px-2 py-0.5 rounded text-[10px] bg-emerald-500/20 border border-emerald-500/30 text-emerald-300 font-bold uppercase">
                      {aiStatus}
                    </span>
                  </div>
                  <div className="grid grid-cols-1 gap-3">
                    {aiScenario === 'malformed' ? (
                      <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 text-xs flex flex-col gap-1.5">
                        <p className="font-bold">
                          ⚠️ Pre-Write Schema Validation Failed (Zero Database Mutations Executed)
                        </p>
                        <p className="text-[11px] text-zinc-300">
                          The model returned conversational markdown instead of a JSON task array. In accordance with safety principles, the output was rejected before reaching Firestore.
                        </p>
                      </div>
                    ) : aiSuggestions.length > 0 ? (
                      aiSuggestions.map((item, idx) => (
                        <div
                          key={idx}
                          className="p-3 rounded-lg bg-zinc-900 border border-zinc-800 flex items-center justify-between gap-3 hover:border-purple-500/50 transition-colors"
                        >
                          <div className="flex flex-col gap-1 truncate">
                            <strong className="text-white text-xs truncate">
                              {item.title}
                            </strong>
                            <div className="flex items-center gap-2 text-[11px] text-zinc-400 font-mono">
                              <span>Cat: {item.category || 'Work'}</span> &bull;{' '}
                              <span>Prio: {item.priority || 'Medium'}</span>
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() =>
                              onAcceptAiTask(
                                item.title,
                                item.category || 'Work',
                                (item.priority as any) || 'Medium'
                              )
                            }
                            className="px-3 py-1.5 rounded bg-purple-600 hover:bg-purple-700 text-white font-bold text-xs shrink-0 transition-colors"
                          >
                            + Add Task
                          </button>
                        </div>
                      ))
                    ) : null}
                  </div>
                </div>
                <div className="flex flex-col gap-2">
                  <span className="font-bold text-zinc-400 text-xs">
                    Raw AI Model Broker Output (JSON):
                  </span>
                  <pre className="p-4 rounded-xl bg-zinc-950 border border-zinc-800 font-mono text-zinc-300 text-[11px] overflow-x-auto max-h-64">
                    {aiRaw}
                  </pre>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        {/* TAB 4: FCM Simulator */}
        {tab === 'fcm' ? (
          <div className="flex-1 p-6 flex flex-col gap-6 overflow-y-auto text-xs">
            <div className="p-4 rounded-xl bg-blue-500/10 border border-blue-500/25 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
              <div className="flex flex-col gap-1">
                <strong className="text-white font-bold text-sm flex items-center gap-2">
                  <span>📬</span>
                  <span>Cloud Messaging (FCM) Simulation Drivers</span>
                </strong>
                <span className="text-zinc-300">
                  Deliver synthetic push alerts and background data sync payloads via authoritative{' '}
                  <code className="text-blue-300 font-mono">messagingSandbox.deliver</code> drivers.
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-zinc-400 font-semibold">Token State:</span>
                {fcmToken ? (
                  <span className="inline-flex items-center gap-2">
                    <span className="text-emerald-400 font-bold">Active</span>
                    <code className="px-2 py-0.5 rounded bg-zinc-950 border border-zinc-800 font-mono text-[11px] max-w-[220px] truncate">
                      {fcmToken}
                    </code>
                  </span>
                ) : (
                  <span className="text-zinc-500 italic">
                    Token not requested yet (Enable via top header bar)
                  </span>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
              <div className="flex flex-col gap-3 p-5 rounded-xl bg-zinc-950 border border-zinc-800">
                <div className="flex items-center gap-2 text-amber-400 font-bold text-sm">
                  <span>⏰</span> <span>High Priority Alert</span>
                </div>
                <p className="text-zinc-400 text-xs leading-relaxed">
                  Simulate a high-urgency foreground push notification alerting the client to an overdue project task.
                </p>
                <button
                  type="button"
                  onClick={() => handleSimulatePush('overdue')}
                  className="mt-auto py-2.5 px-4 rounded-lg bg-amber-600 hover:bg-amber-700 text-white font-bold transition-colors"
                >
                  Send Overdue Alert
                </button>
              </div>
              <div className="flex flex-col gap-3 p-5 rounded-xl bg-zinc-950 border border-zinc-800">
                <div className="flex items-center gap-2 text-purple-400 font-bold text-sm">
                  <span>🔄</span> <span>Collaborator Update</span>
                </div>
                <p className="text-zinc-400 text-xs leading-relaxed">
                  Simulate a notification triggered when a shared workspace collaborator modifications occur.
                </p>
                <button
                  type="button"
                  onClick={() => handleSimulatePush('update')}
                  className="mt-auto py-2.5 px-4 rounded-lg bg-purple-600 hover:bg-purple-700 text-white font-bold transition-colors"
                >
                  Send Update Alert
                </button>
              </div>
              <div className="flex flex-col gap-3 p-5 rounded-xl bg-zinc-950 border border-zinc-800">
                <div className="flex items-center gap-2 text-blue-400 font-bold text-sm">
                  <span>📦</span> <span>Silent Data Sync Payload</span>
                </div>
                <p className="text-zinc-400 text-xs leading-relaxed">
                  Simulate a data-only payload containing background refresh tokens without triggering system UI banners.
                </p>
                <button
                  type="button"
                  onClick={() => handleSimulatePush('silent')}
                  className="mt-auto py-2.5 px-4 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-bold transition-colors"
                >
                  Send Silent Payload
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
};
