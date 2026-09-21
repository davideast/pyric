import { useState } from 'react';
import { useAppData } from '@kin/app';

function Section({ title, description, actions, children }) {
  return (
    <section style={{ display: 'grid', gap: 24, minWidth: 0 }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'grid', gap: 8, minWidth: 0 }}>
          <h2 style={{ margin: 0 }}>{title}</h2>
          {description && <p style={{ margin: 0, color: '#69727e', maxWidth: '65ch' }}>{description}</p>}
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
      style={{ minHeight: 44, padding: '11px 19px' }}
    >
      {children}
    </button>
  );
}

function Field({ id, label, value, onChange, hint, error, ...props }) {
  return (
    <div style={{ display: 'grid', gap: 8, minWidth: 0 }}>
      <label htmlFor={id}>{label}</label>
      <input
        {...props}
        id={id}
        value={value}
        onChange={onChange}
        aria-invalid={!!error}
        aria-describedby={error || hint ? id + '-help' : undefined}
        style={{ width: '100%', minWidth: 0, padding: 12, border: '1px solid #e7eaee', borderRadius: 10 }}
      />
      {(error || hint) && (
        <p id={id + '-help'} role={error ? 'alert' : undefined} style={{ margin: 0, color: error ? '#9e302b' : '#69727e' }}>
          {error || hint}
        </p>
      )}
    </div>
  );
}

function CardList({ items, renderItem, empty = 'Nothing here yet.' }) {
  return (
    <div className="surface" style={{ padding: 20, minWidth: 0 }}>
      {items.length ? (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 16 }}>
          {items.map((item) => (
            <li key={item.id} style={{ minWidth: 0 }}>
              {renderItem(item)}
            </li>
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
      <strong>{title}</strong>
      {children && <div style={{ color: '#69727e', lineHeight: 1.6 }}>{children}</div>}
      {actions && <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>{actions}</div>}
    </div>
  );
}

export default function App({ family }) {
  const { records, loading, error, setRecord, deleteRecord } = useAppData();
  const [activeMemberId, setActiveMemberId] = useState(family.members[0]?.id || '');
  const [title, setTitle] = useState('');
  const [savingId, setSavingId] = useState('');
  const [actionError, setActionError] = useState('');

  const members = family.members || [];
  const currentMember = members.find((m) => m.id === activeMemberId) || members[0];

  // Separate records into activities and votes based on record shape/kind
  const activities = records.filter((r) => r.type === 'activity');
  const votes = records.filter((r) => r.type === 'vote');

  async function handleAddIdea(e) {
    e.preventDefault();
    if (!title.trim() || loading || savingId) return;
    setSavingId('new');
    setActionError('');
    try {
      const newId = crypto.randomUUID();
      await setRecord(newId, {
        type: 'activity',
        title: title.trim(),
        authorId: currentMember ? currentMember.id : 'unknown',
        createdAt: Date.now(),
      });
      setTitle('');
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingId('');
    }
  }

  async function handleAddSampleIdeas() {
    if (loading || savingId) return;
    setSavingId('samples');
    setActionError('');
    try {
      const samples = [
        'Family board game tournament',
        'Bake cookies together',
        'Living room movie night & popcorn',
        'Weekend park walk & playground',
      ];
      for (const sample of samples) {
        await setRecord(crypto.randomUUID(), {
          type: 'activity',
          title: sample,
          authorId: currentMember ? currentMember.id : 'unknown',
          createdAt: Date.now(),
        });
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingId('');
    }
  }

  async function handleToggleVote(activityId) {
    if (loading || !currentMember || savingId) return;
    const existingVote = votes.find((v) => v.activityId === activityId && v.memberId === currentMember.id);
    setSavingId(activityId);
    setActionError('');
    try {
      if (existingVote) {
        await deleteRecord(existingVote.id);
      } else {
        const voteId = `vote-${activityId}-${currentMember.id}`;
        await setRecord(voteId, {
          type: 'vote',
          activityId: activityId,
          memberId: currentMember.id,
        });
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingId('');
    }
  }

  async function handleDeleteActivity(activityId) {
    if (loading || savingId) return;
    setSavingId(activityId);
    setActionError('');
    try {
      // Delete the activity
      await deleteRecord(activityId);
      // Delete associated votes as well to keep clean
      for (const v of votes.filter((v) => v.activityId === activityId)) {
        await deleteRecord(v.id);
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingId('');
    }
  }

  // Count votes per activity and rank them
  const activitiesWithVotes = activities.map((act) => {
    const actVotes = votes.filter((v) => v.activityId === act.id);
    return {
      ...act,
      votes: actVotes,
      voteCount: actVotes.length,
      votedByMe: currentMember ? actVotes.some((v) => v.memberId === currentMember.id) : false,
    };
  });

  const sortedActivities = [...activitiesWithVotes].sort((a, b) => b.voteCount - a.voteCount);
  const maxVotes = sortedActivities.length > 0 ? sortedActivities[0].voteCount : 0;
  const topActivities = maxVotes > 0 ? sortedActivities.filter((a) => a.voteCount === maxVotes) : [];
  const isTied = topActivities.length > 1;

  return (
    <main style={{ maxWidth: 760, margin: '0 auto', padding: 20, display: 'grid', gap: 32, minWidth: 0 }}>
      {/* Header & Participant Bar */}
      <div style={{ display: 'grid', gap: 16, background: '#fff', padding: 20, borderRadius: 12, border: '1px solid #e7eaee' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: '1.5rem' }}>Weekend Picker</h1>
            <p style={{ margin: '4px 0 0 0', color: '#69727e' }}>Propose activities and vote for what the family should do.</p>
          </div>
          {activities.length === 0 && (
            <Button variant="secondary" busy={savingId === 'samples'} disabled={loading} onClick={handleAddSampleIdeas}>
              Add sample ideas
            </Button>
          )}
        </div>

        {members.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', paddingTop: 8, borderTop: '1px solid #e7eaee' }}>
            <span style={{ fontSize: '0.9rem', fontWeight: 600, color: '#1e1f20' }}>Voting as:</span>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {members.map((m) => {
                const isSelected = m.id === currentMember?.id;
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => setActiveMemberId(m.id)}
                    style={{
                      padding: '6px 12px',
                      borderRadius: 20,
                      border: isSelected ? '2px solid #0659fd' : '1px solid #e7eaee',
                      background: isSelected ? '#eef4ff' : '#fff',
                      color: isSelected ? '#0659fd' : '#1e1f20',
                      fontWeight: isSelected ? 600 : 400,
                      cursor: 'pointer',
                    }}
                  >
                    {m.name} ({m.role})
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {error || actionError ? (
        <Feedback kind="error" title="Could not complete action">
          {error || actionError}
        </Feedback>
      ) : null}

      {/* Add Idea Section */}
      <Section title="Propose an activity" description="Add an idea to the family weekend poll.">
        <form onKeyDown={event=>{if(event.key==='Enter' && event.target.tagName==='INPUT'){event.preventDefault();if(event.currentTarget.reportValidity())event.currentTarget.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));}}} onSubmit={handleAddIdea} style={{ display: 'grid', gap: 16 }}>
          <Field
            id="activity-idea"
            label="Activity idea"
            placeholder="e.g. Visit the botanical gardens"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <div>
            <Button type="submit" busy={savingId === 'new'} disabled={loading || !title.trim()}>
              {savingId === 'new' ? 'Adding…' : 'Add idea'}
            </Button>
          </div>
        </form>
      </Section>

      {/* Ranked Results & Voting List */}
      <Section title="Activities & Votes" description="Toggle your vote on any idea. Each member gets one vote per activity.">
        {loading ? (
          <Feedback kind="loading" title="Loading weekend plans…" />
        ) : (
          <div style={{ display: 'grid', gap: 16 }}>
            {sortedActivities.length > 0 && maxVotes > 0 && (
              <div
                style={{
                  padding: 16,
                  borderRadius: 10,
                  background: isTied ? '#fff8e6' : '#eef4ff',
                  border: isTied ? '1px solid #ffeeba' : '1px solid #b6d4fe',
                  display: 'grid',
                  gap: 4,
                }}
              >
                <strong>{isTied ? 'Current Tie!' : 'Leading choice'}</strong>
                <p style={{ margin: 0, color: '#69727e' }}>
                  {isTied
                    ? `Multiple activities share the lead with ${maxVotes} vote(s): ${topActivities.map((a) => a.title).join(', ')}`
                    : `"${topActivities[0]?.title}" is currently in front with ${maxVotes} vote(s)!`}
                </p>
              </div>
            )}

            <CardList
              items={sortedActivities}
              empty="No weekend activities proposed yet. Add your ideas above or use the sample button!"
              renderItem={(item) => {
                const author = members.find((m) => m.id === item.authorId);
                const isBusy = savingId === item.id;
                return (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
                    <div style={{ display: 'grid', gap: 6, minWidth: 0, flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <span style={{ fontWeight: 600, fontSize: '1.05rem' }}>{item.title}</span>
                        <span
                          style={{
                            fontSize: '0.75rem',
                            padding: '2px 8px',
                            borderRadius: 12,
                            background: '#f7f8fa',
                            border: '1px solid #e7eaee',
                            color: '#69727e',
                          }}
                        >
                          {item.voteCount} {item.voteCount === 1 ? 'vote' : 'votes'}
                        </span>
                      </div>
                      <div style={{ fontSize: '0.85rem', color: '#69727e' }}>
                        Proposed by {author ? author.name : 'Family member'} • Voted by:{' '}
                        {item.votes.length > 0
                          ? item.votes
                              .map((v) => members.find((m) => m.id === v.memberId)?.name || 'Someone')
                              .join(', ')
                          : 'No votes yet'}
                      </div>
                    </div>

                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <Button
                        variant={item.votedByMe ? 'primary' : 'secondary'}
                        busy={isBusy}
                        disabled={loading}
                        onClick={() => handleToggleVote(item.id)}
                      >
                        {item.votedByMe ? 'Voted ✓' : 'Vote'}
                      </Button>
                      <button
                        type="button"
                        onClick={() => handleDeleteActivity(item.id)}
                        disabled={loading || isBusy}
                        title="Remove activity"
                        style={{
                          background: 'transparent',
                          border: 'none',
                          color: '#69727e',
                          cursor: 'pointer',
                          padding: 8,
                          fontSize: '1rem',
                        }}
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                );
              }}
            />
          </div>
        )}
      </Section>

      {/* Upcoming Schedule Inspiration */}
      {family.schedule && family.schedule.length > 0 && (
        <Section title="Upcoming family schedule" description="Read-only inspiration from your family calendar.">
          <CardList
            items={family.schedule}
            empty="No schedule items."
            renderItem={(sched) => (
              <div style={{ display: 'grid', gap: 4 }}>
                <span style={{ fontWeight: 600 }}>{sched.title}</span>
                {sched.body && <p style={{ margin: 0, color: '#69727e', fontSize: '0.9rem' }}>{sched.body}</p>}
                {sched.location && <span style={{ fontSize: '0.8rem', color: '#69727e' }}>📍 {sched.location}</span>}
              </div>
            )}
          />
        </Section>
      )}
    </main>
  );
}