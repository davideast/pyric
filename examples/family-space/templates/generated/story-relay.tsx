import { useState, useMemo } from 'react';
import { useAppData } from '@kin/app';

function Section({ title, description, actions, children }) {
  return (
    <section style={{ display: 'grid', gap: 24, minWidth: 0 }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'grid', gap: 8, minWidth: 0 }}>
          <h2 style={{ margin: 0, fontSize: '1.5rem', color: '#1e1f20' }}>{title}</h2>
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
      style={{ minHeight: 44, padding: '11px 19px', cursor: (disabled || busy) ? 'not-allowed' : 'pointer', fontWeight: 500 }}
    >
      {children}
    </button>
  );
}

function Field({ id, label, value, onChange, hint, error, ...props }) {
  return (
    <div style={{ display: 'grid', gap: 8, minWidth: 0 }}>
      <label htmlFor={id} style={{ fontWeight: 500, color: '#1e1f20' }}>{label}</label>
      <input
        {...props}
        id={id}
        value={value}
        onChange={onChange}
        aria-invalid={!!error}
        aria-describedby={error || hint ? id + '-help' : undefined}
        style={{ width: '100%', minWidth: 0, padding: 12, border: '1px solid #e7eaee', borderRadius: 10, background: '#fff', color: '#1e1f20', fontSize: '1rem' }}
      />
      {(error || hint) && (
        <p id={id + '-help'} role={error ? 'alert' : undefined} style={{ margin: 0, color: error ? '#9e302b' : '#69727e', fontSize: '0.9rem' }}>
          {error || hint}
        </p>
      )}
    </div>
  );
}

function CardList({ items, renderItem, empty = 'Nothing here yet.' }) {
  return (
    <div className="surface" style={{ padding: 20, minWidth: 0, borderRadius: 12, border: '1px solid #e7eaee', background: '#fff' }}>
      {items.length ? (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 16 }}>
          {items.map(item => (
            <li key={item.id} style={{ minWidth: 0 }}>{renderItem(item)}</li>
          ))}
        </ul>
      ) : (
        <p style={{ margin: 0, color: '#69727e' }}>{empty}</p>
      )}
    </div>
  );
}

function Feedback({ kind = 'empty', title, children, actions }) {
  return (
    <div role={kind === 'error' ? 'alert' : 'status'} style={{ display: 'grid', gap: 12, padding: '20px 0', borderTop: '1px solid #e7eaee', minWidth: 0 }}>
      <strong style={{ color: kind === 'error' ? '#9e302b' : '#1e1f20', fontSize: '1.05rem' }}>{title}</strong>
      {children && <div style={{ color: '#69727e', lineHeight: 1.6 }}>{children}</div>}
      {actions && <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>{actions}</div>}
    </div>
  );
}

export default function App({ family }) {
  const { records, loading, error, setRecord } = useAppData();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [sentenceText, setSentenceText] = useState('');
  const [activeMemberId, setActiveMemberId] = useState(family.members[0]?.id || '');
  const [selectedRoundId, setSelectedRoundId] = useState('');

  const members = family.members || [];

  // Filter records that are story sentences
  const sentences = useMemo(() => {
    return records
      .filter(r => r.type === 'sentence' && r.roundId)
      .sort((a, b) => {
        const timeA = Number(a.createdAt) || 0;
        const timeB = Number(b.createdAt) || 0;
        if (timeA !== timeB) return timeA - timeB;
        return String(a.id).localeCompare(String(b.id));
      });
  }, [records]);

  // Group sentences by roundId
  const rounds = useMemo(() => {
    const map = new Map();
    for (const s of sentences) {
      if (!map.has(s.roundId)) {
        map.set(s.roundId, {
          roundId: s.roundId,
          title: s.roundTitle || 'Untitled Story',
          sentences: [],
          createdAt: s.createdAt
        });
      }
      map.get(s.roundId).sentences.push(s);
    }
    return Array.from(map.values()).sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
  }, [sentences]);

  // Determine current active round
  const currentRound = useMemo(() => {
    if (!rounds.length) return null;
    if (selectedRoundId && rounds.find(r => r.roundId === selectedRoundId)) {
      return rounds.find(r => r.roundId === selectedRoundId);
    }
    return rounds[0];
  }, [rounds, selectedRoundId]);

  // Suggested member turn based on member order and sentence count
  const suggestedMember = useMemo(() => {
    if (!members.length || !currentRound) return members[0] || null;
    const count = currentRound.sentences.length;
    return members[count % members.length];
  }, [members, currentRound]);

  async function handleStartNewStory() {
    setSaving(true);
    setSaveError('');
    try {
      const newRoundId = crypto.randomUUID();
      const firstSentenceId = crypto.randomUUID();
      const starterMember = members[0] || { id: 'anon', name: 'Someone' };

      // We automatically seed the round with a title/opening or let user start first sentence
      await setRecord(firstSentenceId, {
        type: 'sentence',
        roundId: newRoundId,
        roundTitle: `Story #${rounds.length + 1}`,
        authorId: starterMember.id,
        authorName: starterMember.name,
        text: `Once upon a time in ${family.family || 'our family'}...`,
        createdAt: Date.now()
      });
      setSelectedRoundId(newRoundId);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleAddSentence(e) {
    e.preventDefault();
    if (!sentenceText.trim() || !currentRound || saving || loading) return;

    setSaving(true);
    setSaveError('');
    try {
      const author = members.find(m => m.id === activeMemberId) || members[0] || { id: 'unknown', name: 'Family Member' };
      const newId = crypto.randomUUID();
      await setRecord(newId, {
        type: 'sentence',
        roundId: currentRound.roundId,
        roundTitle: currentRound.title,
        authorId: author.id,
        authorName: author.name,
        text: sentenceText.trim(),
        createdAt: Date.now()
      });
      setSentenceText('');

      // Advance suggested member turn automatically
      const nextIndex = (members.findIndex(m => m.id === author.id) + 1) % members.length;
      if (members[nextIndex]) {
        setActiveMemberId(members[nextIndex].id);
      }
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <main style={{ padding: 20, maxWidth: 760, margin: '0 auto', display: 'grid', gap: 24, fontFamily: 'inherit' }}>
      <Section
        title="Story Relay"
        description="Collaborative family storytelling. Each person adds one sentence in turn!"
        actions={
          rounds.length > 0 ? (
            <Button variant="secondary" onClick={handleStartNewStory} busy={saving} disabled={loading}>
              ✨ New story
            </Button>
          ) : null
        }
      >
        {error || saveError ? (
          <Feedback kind="error" title="Could not save or load stories">
            {error || saveError}
          </Feedback>
        ) : null}

        {loading ? (
          <Feedback kind="loading" title="Loading stories…" />
        ) : rounds.length === 0 ? (
          <Feedback
            kind="empty"
            title="No stories yet"
            actions={
              <Button onClick={handleStartNewStory} busy={saving}>
                Start a story
              </Button>
            }
          >
            Create the first collaborative story round for your family.
          </Feedback>
        ) : (
          <div style={{ display: 'grid', gap: 20 }}>
            {/* Story selector tabs if multiple rounds exist */}
            {rounds.length > 1 && (
              <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 4 }}>
                {rounds.map(r => (
                  <button
                    key={r.roundId}
                    onClick={() => setSelectedRoundId(r.roundId)}
                    className={currentRound?.roundId === r.roundId ? 'primary' : 'secondary'}
                    style={{ padding: '6px 12px', borderRadius: 8, fontSize: '0.9rem', whiteSpace: 'nowrap', cursor: 'pointer' }}
                  >
                    {r.title} ({r.sentences.length})
                  </button>
                ))}
              </div>
            )}

            {/* Current Active Story Card */}
            {currentRound && (
              <div className="surface" style={{ padding: 20, borderRadius: 12, border: '1px solid #e7eaee', background: '#fff', display: 'grid', gap: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                  <h3 style={{ margin: 0, fontSize: '1.2rem', color: '#1e1f20' }}>{currentRound.title}</h3>
                  <span style={{ fontSize: '0.85rem', color: '#69727e' }}>
                    {currentRound.sentences.length} sentence{currentRound.sentences.length === 1 ? '' : 's'}
                  </span>
                </div>

                {/* Full rendered story narrative view */}
                <div style={{ background: '#f7f8fa', padding: 16, borderRadius: 8, lineHeight: 1.7, color: '#1e1f20', fontSize: '1.05rem' }}>
                  {currentRound.sentences.map((s, idx) => (
                    <span key={s.id} title={`Added by ${s.authorName || 'Member'}`}>
                      {s.text}{' '}
                    </span>
                  ))}
                </div>

                {/* Sentence by sentence breakdown */}
                <div style={{ display: 'grid', gap: 8 }}>
                  <h4 style={{ margin: 0, fontSize: '0.95rem', color: '#69727e', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Contribution history</h4>
                  <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
                    {currentRound.sentences.map(s => (
                      <li key={s.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: '0.95rem', padding: '8px 12px', background: '#fff', borderRadius: 6, border: '1px solid #e7eaee' }}>
                        <span style={{ color: '#1e1f20' }}>{s.text}</span>
                        <span style={{ color: '#69727e', whiteSpace: 'nowrap', fontSize: '0.85rem' }}>— {s.authorName || 'Member'}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}

            {/* Turn indicator & Pass-the-device picker */}
            <div className="surface" style={{ padding: 20, borderRadius: 12, border: '1px solid #e7eaee', background: '#fff', display: 'grid', gap: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
                <div style={{ display: 'grid', gap: 4 }}>
                  <span style={{ fontSize: '0.85rem', color: '#69727e', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Suggested Turn</span>
                  <strong style={{ fontSize: '1.1rem', color: '#0659fd' }}>
                    👉 {suggestedMember ? suggestedMember.name : 'Anyone'}
                  </strong>
                </div>

                {members.length > 0 && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <label htmlFor="active-member" style={{ fontSize: '0.9rem', fontWeight: 500, color: '#69727e' }}>Who is holding device:</label>
                    <select
                      id="active-member"
                      value={activeMemberId}
                      onChange={e => setActiveMemberId(e.target.value)}
                      style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #e7eaee', background: '#fff', fontSize: '0.95rem', color: '#1e1f20' }}
                    >
                      {members.map(m => (
                        <option key={m.id} value={m.id}>
                          {m.name} ({m.role})
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>

              {/* Add sentence form */}
              <form onKeyDown={event=>{if(event.key==='Enter' && event.target.tagName==='INPUT'){event.preventDefault();if(event.currentTarget.reportValidity())event.currentTarget.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));}}} onSubmit={handleAddSentence} style={{ display: 'grid', gap: 16, borderTop: '1px solid #e7eaee', paddingTop: 16 }}>
                <Field
                  id="sentence-input"
                  label={`Your sentence (${members.find(m => m.id === activeMemberId)?.name || 'Member'})`}
                  value={sentenceText}
                  onChange={e => setSentenceText(e.target.value)}
                  placeholder="Type the next sentence of the story..."
                  hint="Keep it brief and fun! Honor-system family play."
                />
                <div>
                  <Button type="submit" busy={saving} disabled={loading || !sentenceText.trim()}>
                    {saving ? 'Adding…' : 'Add sentence'}
                  </Button>
                </div>
              </form>
            </div>
          </div>
        )}
      </Section>
    </main>
  );
}