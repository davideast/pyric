import { useState } from 'react';
import { useAppData } from '@kin/app';

const QUESTIONS = [
  { id: 1, text: 'What is 7 multiplied by 8?', options: ['54', '56', '64', '72'], correct: 1 },
  { id: 2, text: 'Which animal is known as the "Ship of the Desert"?', options: ['Horse', 'Elephant', 'Camel', 'Llama'], correct: 2 },
  { id: 3, text: 'How many planets are in our solar system?', options: ['7', '8', '9', '10'], correct: 1 },
  { id: 4, text: 'Which of these mammals can truly fly?', options: ['Flying squirrel', 'Bat', 'Sugar glider', 'Lemur'], correct: 1 },
  { id: 5, text: 'What is the closest star to Earth?', options: ['Sirius', 'Proxima Centauri', 'The Sun', 'Polaris'], correct: 2 },
];

function Section({ title, description, actions, children }) {
  return (
    <section style={{ display: 'grid', gap: 24, minWidth: 0 }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'grid', gap: 8, minWidth: 0 }}>
          <h2 style={{ margin: 0, fontSize: 24, fontWeight: 700, color: '#1e1f20' }}>{title}</h2>
          {description && <p style={{ margin: 0, color: '#69727e', maxWidth: '65ch', lineHeight: 1.5 }}>{description}</p>}
        </div>
        {actions && <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>{actions}</div>}
      </header>
      {children}
    </section>
  );
}

function Button({ children, variant = 'primary', busy = false, disabled = false, type = 'button', ...props }) {
  return (
    <button
      {...props}
      type={type === 'submit' ? 'button' : type} onClick={event=>{if(type==='submit'){event.preventDefault();const form=event.currentTarget.form;if(form?.reportValidity())form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));}else props.onClick?.(event);}}
      className={variant === 'primary' ? 'primary' : 'secondary'}
      disabled={disabled || busy}
      aria-busy={busy}
      style={{
        minHeight: 44,
        padding: '11px 19px',
        borderRadius: 10,
        fontWeight: 600,
        cursor: disabled || busy ? 'not-allowed' : 'pointer',
        border: variant === 'primary' ? 'none' : '1px solid #e7eaee',
        background: variant === 'primary' ? '#0659fd' : '#ffffff',
        color: variant === 'primary' ? '#ffffff' : '#1e1f20'
      }}
    >
      {children}
    </button>
  );
}

function Feedback({ kind = 'empty', title, children, actions }) {
  return (
    <div
      role={kind === 'error' ? 'alert' : 'status'}
      style={{
        display: 'grid',
        gap: 12,
        padding: '24px 20px',
        background: kind === 'error' ? '#fdf2f2' : '#f7f8fa',
        border: `1px solid ${kind === 'error' ? '#f8d7da' : '#e7eaee'}`,
        borderRadius: 12,
        minWidth: 0
      }}
    >
      <strong style={{ color: kind === 'error' ? '#9e302b' : '#1e1f20' }}>{title}</strong>
      {children && <div style={{ color: '#69727e', lineHeight: 1.6 }}>{children}</div>}
      {actions && <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>{actions}</div>}
    </div>
  );
}

export default function App({ family }) {
  const { records, loading, error, setRecord, deleteRecord } = useAppData();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  const [selectedMemberId, setSelectedMemberId] = useState(family.members[0]?.id || '');




  const members = family.members || [];

  // Find current active round record or latest round
  const rounds = records.filter(r => r.type === 'round').sort((a,b)=>a.createdAt-b.createdAt || a.id.localeCompare(b.id));
  const activeRound = rounds.length ? rounds[rounds.length - 1] : null;

  async function startNewRound() {
    setSaving(true);
    setSaveError('');
    try {
      setReview(false);
      const newRoundId = `round_${crypto.randomUUID()}`;
      await setRecord(newRoundId, {
        type: 'round',
        createdAt: Date.now(),
        roundNumber: rounds.length + 1
      });
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function submitAnswer(optionIndex) {
    if (!activeRound || selectedOption !== null || saving) return;
    const currentQ = QUESTIONS[activeQuestionIndex];
    const isCorrect = optionIndex === currentQ.correct;


    setSaving(true);
    setSaveError('');
    try {
      const answerRecordId = `ans_${activeRound.id}_${selectedMemberId}_q${currentQ.id}`;
      await setRecord(answerRecordId, {
        type: 'answer',
        roundId: activeRound.id,
        memberId: selectedMemberId,
        questionId: currentQ.id,
        selectedOption: optionIndex,
        correct: isCorrect,
        answeredAt: Date.now()
      });
      setReview(true);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  function nextQuestion() { setReview(false); }
  const [review,setReview]=useState(false);
  // Calculate scores for active round
  const roundAnswers = activeRound ? records.filter(r => r.type === 'answer' && r.roundId === activeRound.id) : [];

  const memberScores = members.map(m => {
    const mAnswers = roundAnswers.filter(a => a.memberId === m.id);
    const correctCount = mAnswers.filter(a => a.correct).length;
    const totalAnswered = mAnswers.length;
    return { member: m, correctCount, totalAnswered };
  });

  const answered=roundAnswers.filter(a=>a.memberId===selectedMemberId);
  const nextIndex=QUESTIONS.findIndex(q=>!answered.some(a=>a.questionId===q.id));
  const lastAnswer=[...answered].sort((a,b)=>b.answeredAt-a.answeredAt)[0];
  const activeQuestionIndex=review&&lastAnswer?QUESTIONS.findIndex(q=>q.id===lastAnswer.questionId):nextIndex<0?QUESTIONS.length:nextIndex;
  const currentQ = QUESTIONS[activeQuestionIndex];
  const currentMemberAnswer = activeRound && currentQ
    ? roundAnswers.find(a => a.memberId === selectedMemberId && a.questionId === currentQ.id)
    : null;

  const selectedOption=currentMemberAnswer?.selectedOption??null;
  const answerFeedback=currentMemberAnswer?(currentMemberAnswer.correct?'Correct!':`The correct answer was: ${currentQ.options[currentQ.correct]}`):null;

  return (
    <main style={{ padding: 20, maxWidth: 760, margin: '0 auto', display: 'grid', gap: 24, fontFamily: 'Figtree, sans-serif', color: '#1e1f20' }}>
      <Section
        title="Family Trivia"
        description="Pass-and-play trivia game with 5 family-friendly questions. Answer turn-by-turn and see who wins!"
        actions={
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {!activeRound && (
              <Button busy={saving} disabled={loading || !!error} onClick={startNewRound}>
                Start quiz
              </Button>
            )}
            {activeRound && (
              <Button variant="secondary" busy={saving} disabled={loading || !!error} onClick={startNewRound}>
                New round
              </Button>
            )}
          </div>
        }
      >
        {error || saveError ? (
          <Feedback kind="error" title="Could not load or save game data">
            {error || saveError}
          </Feedback>
        ) : null}

        {loading ? (
          <Feedback kind="loading" title="Loading trivia records…" />
        ) : !activeRound ? (
          <Feedback kind="empty" title="No active trivia round">
            Ready to test your knowledge? Click "Start quiz" above to begin.
          </Feedback>
        ) : (
          <div style={{ display: 'grid', gap: 20, minWidth: 0 }}>
            {/* Member picker & Round info */}
            <div className="surface" style={{ padding: 16, borderRadius: 12, display: 'grid', gap: 12, border: '1px solid #e7eaee', background: '#ffffff' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
                <div>
                  <span style={{ fontSize: 13, fontWeight: 600, color: '#69727e', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    Round #{activeRound.roundNumber || 1}
                  </span>
                  <h3 style={{ margin: '4px 0 0 0', fontSize: 18 }}>Current Player</h3>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <label htmlFor="member-select" style={{ fontWeight: 600, fontSize: 14 }}>Playing as:</label>
                  <select
                    id="member-select"
                    value={selectedMemberId}
                    onChange={e => {
                      setSelectedMemberId(e.target.value); setReview(false);
                    }}
                    style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #e7eaee', background: '#fff', fontSize: 14 }}
                  >
                    {members.map(m => (
                      <option key={m.id} value={m.id}>{m.name} ({m.role})</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            {/* Quiz active / finished state */}
            {activeQuestionIndex < QUESTIONS.length ? (
              <div className="surface" style={{ padding: 24, borderRadius: 12, display: 'grid', gap: 20, border: '1px solid #e7eaee', background: '#ffffff' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontWeight: 600, color: '#0659fd' }}>
                    Question {activeQuestionIndex + 1} of {QUESTIONS.length}
                  </span>
                  <span style={{ fontSize: 13, color: '#69727e' }}>Honor system turn-based play</span>
                </div>

                <h3 style={{ margin: 0, fontSize: 20, lineHeight: 1.4 }}>{currentQ.text}</h3>

                <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
                  {currentQ.options.map((opt, idx) => {
                    const alreadyAnsweredThisQ = !!currentMemberAnswer;
                    const isSelected = currentMemberAnswer ? currentMemberAnswer.selectedOption === idx : selectedOption === idx;
                    const isThisCorrect = idx === currentQ.correct;

                    let bg = '#ffffff';
                    let borderColor = '#e7eaee';
                    let textColor = '#1e1f20';

                    if (alreadyAnsweredThisQ || selectedOption !== null) {
                      if (isThisCorrect) {
                        bg = '#e6f4ea';
                        borderColor = '#34a853';
                        textColor = '#137333';
                      } else if (isSelected) {
                        bg = '#fce8e6';
                        borderColor = '#ea4335';
                        textColor = '#c5221f';
                      }
                    }

                    return (
                      <button
                        key={idx}
                        disabled={alreadyAnsweredThisQ || selectedOption !== null || saving}
                        onClick={() => submitAnswer(idx)}
                        style={{
                          padding: '16px',
                          borderRadius: 10,
                          border: `2px solid ${borderColor}`,
                          background: bg,
                          color: textColor,
                          textAlign: 'left',
                          fontWeight: 600,
                          fontSize: 15,
                          cursor: alreadyAnsweredThisQ || selectedOption !== null || saving ? 'default' : 'pointer',
                          transition: 'all 0.2s ease'
                        }}
                      >
                        {String.fromCharCode(65 + idx)}. {opt}
                      </button>
                    );
                  })}
                </div>

                {(answerFeedback || currentMemberAnswer) && (
                  <div style={{ display: 'grid', gap: 12, paddingTop: 8 }}>
                    <div style={{ padding: 12, borderRadius: 8, background: '#f7f8fa', border: '1px solid #e7eaee', fontWeight: 600 }}>
                      {answerFeedback || (currentMemberAnswer?.correct ? 'Correct!' : `Incorrect. The correct answer was: ${currentQ.options[currentQ.correct]}`)}
                    </div>
                    <div>
                      <Button onClick={nextQuestion}>
                        {activeQuestionIndex === QUESTIONS.length - 1 ? 'View Final Scores' : 'Next Question →'}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="surface" style={{ padding: 24, borderRadius: 12, display: 'grid', gap: 20, border: '1px solid #e7eaee', background: '#ffffff' }}>
                <h3 style={{ margin: 0, fontSize: 22 }}>Round Complete! 🎉</h3>
                <p style={{ margin: 0, color: '#69727e' }}>Here are the final scores for this round:</p>

                <div style={{ display: 'grid', gap: 12 }}>
                  {memberScores.map(({ member, correctCount, totalAnswered }) => (
                    <div key={member.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', borderRadius: 8, background: '#f7f8fa', border: '1px solid #e7eaee' }}>
                      <span style={{ fontWeight: 600 }}>{member.name} ({member.role})</span>
                      <span style={{ fontWeight: 700, color: '#0659fd' }}>{correctCount} / {QUESTIONS.length} correct</span>
                    </div>
                  ))}
                </div>

                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', paddingTop: 8 }}>
                  <Button onClick={startNewRound} busy={saving}>
                    Start New Round
                  </Button>
                </div>
              </div>
            )}

            {/* Leaderboard summary card */}
            <div className="surface" style={{ padding: 20, borderRadius: 12, display: 'grid', gap: 12, border: '1px solid #e7eaee', background: '#ffffff' }}>
              <h4 style={{ margin: 0, fontSize: 16 }}>Live Round Scoreboard</h4>
              <div style={{ display: 'grid', gap: 8 }}>
                {memberScores.map(({ member, correctCount, totalAnswered }) => (
                  <div key={member.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, color: '#69727e' }}>
                    <span>{member.name}</span>
                    <span>{totalAnswered} answered ({correctCount} correct)</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </Section>
    </main>
  );
}