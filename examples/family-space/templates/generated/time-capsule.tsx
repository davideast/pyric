import { useState } from 'react';
import { useAppData } from '@kin/app';

function Section({ title, description, actions, children }) {
  return (
    <section style={{ display: 'grid', gap: 24, minWidth: 0 }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'grid', gap: 8, minWidth: 0 }}>
          <h2 style={{ margin: 0 }}>{title}</h2>
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
      style={{ minHeight: 44, padding: '11px 19px', cursor: (disabled || busy) ? 'not-allowed' : 'pointer' }}
    >
      {children}
    </button>
  );
}

function Field({ id, label, value, onChange, hint, error, ...props }) {
  return (
    <div style={{ display: 'grid', gap: 8, minWidth: 0 }}>
      <label htmlFor={id} style={{ fontWeight: 500 }}>{label}</label>
      <input
        {...props}
        id={id}
        value={value}
        onChange={onChange}
        aria-invalid={!!error}
        aria-describedby={error || hint ? id + '-help' : undefined}
        style={{ width: '100%', minWidth: 0, padding: 12, border: '1px solid #e7eaee', borderRadius: 10, background: '#fff' }}
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
    <div className="surface" style={{ padding: 20, minWidth: 0, borderRadius: 12 }}>
      {items.length ? (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 16 }}>
          {items.map(item => (
            <li key={item.id} style={{ minWidth: 0, borderBottom: '1px solid #f2f4f7', paddingBottom: 16, lastChild: { borderBottom: 0, paddingBottom: 0 } }}>
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

  const [memoryText, setMemoryText] = useState('');
  const [openDate, setOpenDate] = useState('');
  const [selectedAuthor, setSelectedAuthor] = useState(family.members[0]?.id || '');
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState('');
  const [actionId, setActionId] = useState(null);
  const [confirmation,setConfirmation]=useState('');

  const todayStr = new Date().toISOString().split('T')[0];

  async function handleAddMemory(e) {
    e.preventDefault();
    if (!memoryText.trim() || !openDate || loading || saving) return;

    setSaving(true);
    setFailure('');
    try {
      const id = crypto.randomUUID();
      await setRecord(id, {
        memory: memoryText.trim(),
        openDate,
        authorId: selectedAuthor || family.members[0]?.id || 'unknown',
        createdAt: Date.now(),
        forceOpened: false
      });
      setMemoryText('');
      setOpenDate('');
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleOpenNow(item) {
    if(confirmation!=='open-'+item.id){setConfirmation('open-'+item.id);return;}
    setConfirmation('');
    setActionId(item.id);
    setFailure('');
    try {
      await setRecord(item.id, {
        memory:item.memory,openDate:item.openDate,authorId:item.authorId,createdAt:item.createdAt,
        forceOpened: true
      });
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
    } finally {
      setActionId(null);
    }
  }

  async function handleDelete(item) {
    if(confirmation!=='delete-'+item.id){setConfirmation('delete-'+item.id);return;}
    setConfirmation('');
    setActionId(item.id);
    setFailure('');
    try {
      await deleteRecord(item.id);
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
    } finally {
      setActionId(null);
    }
  }

  const sortedMemories = [...records].sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));

  const sealedMemories = sortedMemories.filter(item => {
    if (item.forceOpened) return false;
    return item.openDate && item.openDate > todayStr;
  });

  const readyMemories = sortedMemories.filter(item => {
    if (item.forceOpened) return true;
    return !item.openDate || item.openDate <= todayStr;
  });

  const getMemberName = (id) => {
    const member = family.members.find(m => m.id === id);
    return member ? member.name : 'Family member';
  };

  return (
    <main style={{ maxWidth: 760, margin: '0 auto', padding: 20, display: 'grid', gap: 32, fontFamily: 'inherit', color: '#1e1f20' }}>
      <Section
        title="Family Time Capsule"
        description="Save memories, predictions, and notes for the family to open on a future date. Note: Sealed text is a playful UI reveal, not privacy or security encryption; all family app records are shared."
      >
        {error || failure ? (
          <Feedback kind="error" title="Could not save or load time capsule">
            {error || failure}
          </Feedback>
        ) : null}

        <form onKeyDown={event=>{if(event.key==='Enter' && event.target.tagName==='INPUT'){event.preventDefault();if(event.currentTarget.reportValidity())event.currentTarget.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));}}} onSubmit={handleAddMemory} className="surface" style={{ padding: 20, borderRadius: 12, display: 'grid', gap: 16 }}>
          <h3 style={{ margin: 0, fontSize: '1.1rem' }}>Bury a new memory</h3>

          <div style={{ display: 'grid', gap: 8 }}>
            <label htmlFor="author-select" style={{ fontWeight: 500 }}>Saved by</label>
            <select
              id="author-select"
              value={selectedAuthor}
              onChange={e => setSelectedAuthor(e.target.value)}
              style={{ width: '100%', padding: 12, border: '1px solid #e7eaee', borderRadius: 10, background: '#fff' }}
            >
              {family.members.map(m => (
                <option key={m.id} value={m.id}>{m.name} ({m.role})</option>
              ))}
            </select>
          </div>

          <div style={{ display: 'grid', gap: 8 }}>
            <label htmlFor="memory-textarea" style={{ fontWeight: 500 }}>Memory</label>
            <textarea
              id="memory-textarea"
              rows={3}
              value={memoryText}
              onChange={e => setMemoryText(e.target.value)}
              placeholder="What should the family remember or discover later?"
              style={{ width: '100%', minWidth: 0, padding: 12, border: '1px solid #e7eaee', borderRadius: 10, background: '#fff', fontFamily: 'inherit', resize: 'vertical' }}
            />
          </div>

          <Field
            id="open-date"
            label="Open on"
            type="date"
            value={openDate}
            min={todayStr}
            onChange={e => setOpenDate(e.target.value)}
            hint="Choose a future date to unlock this capsule."
          />

          <div>
            <Button
              type="submit"
              busy={saving}
              disabled={loading || !!error || !memoryText.trim() || !openDate}
            >
              {saving ? 'Saving…' : 'Save memory'}
            </Button>
          </div>
        </form>
      </Section>

      {loading ? (
        <Feedback kind="loading" title="Loading time capsules…" />
      ) : (
        <div style={{ display: 'grid', gap: 24 }}>
          <Section title={`Ready to Open (${readyMemories.length})`} description="Memories whose reveal date has arrived, or capsules opened early.">
            <CardList
              items={readyMemories}
              empty="No ready memories right now. Check your sealed items or save a new one!"
              renderItem={item => (
                <div style={{ display: 'grid', gap: 8 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                    <span style={{ fontWeight: 600, color: '#0659fd' }}>{getMemberName(item.authorId)}</span>
                    <span style={{ fontSize: '0.85rem', color: '#69727e' }}>
                      Unlock date: {item.openDate || 'Immediate'} {item.forceOpened ? '(Opened early)' : ''}
                    </span>
                  </div>
                  <p style={{ margin: 0, whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{item.memory}</p>
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
                    <Button
                      variant="secondary"
                      busy={actionId === item.id}
                      onClick={() => handleDelete(item)}
                      style={{ padding: '6px 12px', minHeight: 32, fontSize: '0.85rem' }}
                    >
                      {confirmation==='delete-'+item.id?'Confirm delete':'Delete'}
                    </Button>
                  </div>
                </div>
              )}
            />
          </Section>

          <Section title={`Sealed Capsules (${sealedMemories.length})`} description="Locked away until their future date arrives.">
            <CardList
              items={sealedMemories}
              empty="No sealed memories in the time capsule."
              renderItem={item => (
                <div style={{ display: 'grid', gap: 8 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                    <span style={{ fontWeight: 600, color: '#69727e' }}>Sealed memory by {getMemberName(item.authorId)}</span>
                    <span style={{ fontSize: '0.85rem', color: '#9e302b', fontWeight: 500 }}>
                      🔒 Unlocks on {item.openDate}
                    </span>
                  </div>
                  <div style={{ background: '#f7f8fa', padding: 12, borderRadius: 8, border: '1px dashed #e7eaee', color: '#69727e', fontStyle: 'italic' }}>
                    Contents are locked and sealed until {item.openDate}.
                  </div>
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center', marginTop: 4 }}>
                    <Button
                      variant="secondary"
                      busy={actionId === item.id}
                      onClick={() => handleOpenNow(item)}
                      style={{ padding: '6px 12px', minHeight: 32, fontSize: '0.85rem' }}
                    >
                      {confirmation==='open-'+item.id?'Confirm reveal':'Reveal now…'}
                    </Button>
                    <Button
                      variant="secondary"
                      busy={actionId === item.id}
                      onClick={() => handleDelete(item)}
                      style={{ padding: '6px 12px', minHeight: 32, fontSize: '0.85rem' }}
                    >
                      {confirmation==='delete-'+item.id?'Confirm delete':'Delete'}
                    </Button>
                  </div>
                </div>
              )}
            />
          </Section>
        </div>
      )}
    </main>
  );
}