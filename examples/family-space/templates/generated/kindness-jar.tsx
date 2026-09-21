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

function CardList({ items, renderItem, empty = 'Nothing here yet.' }) {
  return (
    <div className="surface" style={{ padding: 20, minWidth: 0 }}>
      {items.length ? (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 16 }}>
          {items.map(item => (
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
  const [authorId, setAuthorId] = useState(family?.members?.[0]?.id ?? '');
  const [recipientId, setRecipientId] = useState(family?.members?.[1]?.id ?? family?.members?.[0]?.id ?? '');
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState('');
  const [deletingId, setDeletingId] = useState('');

  const members = family?.members ?? [];
  const memberMap = new Map(members.map(m => [m.id, m.name]));

  // Sort notes newest first by createdAt timestamp
  const notes = [...records].sort((a, b) => Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0));
  const noteCount = notes.length;

  async function addKindness(event) {
    event.preventDefault();
    if (!body.trim() || loading || saving) return;
    setSaving(true);
    setFailure('');
    try {
      await setRecord(crypto.randomUUID(), {
        authorId,
        recipientId,
        body: body.trim(),
        createdAt: Date.now()
      });
      setBody('');
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function removeNote(id) {
    if (loading || deletingId) return;
    setDeletingId(id);
    setFailure('');
    try {
      await deleteRecord(id);
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
    } finally {
      setDeletingId('');
    }
  }

  // Geometric jar fill level calculation (caps at 15 notes for full visual)
  const fillRatio = Math.min(noteCount / 15, 1);
  const liquidHeight = Math.round(fillRatio * 130);

  return (
    <main style={{ padding: 20, maxWidth: 760, margin: '0 auto', display: 'grid', gap: 24, minWidth: 0 }}>
      <Section
        title="Kindness Jar"
        description="Share a short thank-you or a kind act with someone in the family. Notes fill the jar as our appreciation grows."
      >
        {error || failure ? (
          <Feedback kind="error" title="Could not save or load notes">
            {error || failure}
          </Feedback>
        ) : null}

        {/* Jar Illustration */}
        <div className="surface" style={{ padding: 24, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <svg width="120" height="170" viewBox="0 0 120 170" fill="none" xmlns="http://www.w3.org/2000/svg">
              {/* Lid */}
              <rect x="35" y="10" width="50" height="12" rx="4" fill="#69727e" />
              <rect x="42" y="4" width="36" height="6" rx="2" fill="#69727e" />
              {/* Jar Body Outline */}
              <path
                d="M30 30 C30 24 35 22 40 22 H80 C85 22 90 24 90 30 V38 C105 45 112 60 112 90 C112 125 105 155 90 162 C85 165 35 165 30 162 C15 155 8 125 8 90 C8 60 15 45 30 38 Z"
                stroke="#1e1f20"
                strokeWidth="4"
                fill="#ffffff"
              />
              {/* Liquid / Notes filling */}
              {liquidHeight > 0 && (
                <g clipPath="url(#jarClip)">
                  <rect
                    x="8"
                    y={164 - liquidHeight}
                    width="104"
                    height={liquidHeight}
                    fill="#0659fd"
                    fillOpacity="0.18"
                  />
                  {/* Floating dots inside jar representing notes */}
                  {notes.slice(0, 15).map((_, i) => {
                    const cx = 25 + ((i * 37) % 70);
                    const cy = 150 - ((i * 23) % (liquidHeight - 20 || 10));
                    return <circle key={i} cx={cx} cy={cy} r="5" fill="#0659fd" fillOpacity="0.6" />;
                  })}
                </g>
              )}
              <defs>
                <clipPath id="jarClip">
                  <path d="M30 30 C30 24 35 22 40 22 H80 C85 22 90 24 90 30 V38 C105 45 112 60 112 90 C112 125 105 155 90 162 C85 165 35 165 30 162 C15 155 8 125 8 90 C8 60 15 45 30 38 Z" />
                </clipPath>
              </defs>
            </svg>
            <div style={{ display: 'grid', gap: 4 }}>
              <span style={{ fontSize: 28, fontWeight: 700, color: '#0659fd' }}>{noteCount}</span>
              <span style={{ color: '#69727e', fontSize: 14 }}>Kindness note{noteCount === 1 ? '' : 's'} collected</span>
            </div>
          </div>

          {/* Add Kindness Form */}
          <form onKeyDown={event=>{if(event.key==='Enter' && event.target.tagName==='INPUT'){event.preventDefault();if(event.currentTarget.reportValidity())event.currentTarget.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));}}} onSubmit={addKindness} style={{ width: '100%', display: 'grid', gap: 16, marginTop: 8 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div style={{ display: 'grid', gap: 6, minWidth: 0 }}>
                <label htmlFor="author" style={{ fontSize: 14, fontWeight: 600 }}>From</label>
                <select
                  id="author"
                  value={authorId}
                  onChange={e => setAuthorId(e.target.value)}
                  style={{ width: '100%', minWidth: 0, padding: 10, border: '1px solid #e7eaee', borderRadius: 10, background: '#fff' }}
                >
                  {members.map(m => (
                    <option key={m.id} value={m.id}>{m.name}</option>
                  ))}
                </select>
              </div>

              <div style={{ display: 'grid', gap: 6, minWidth: 0 }}>
                <label htmlFor="recipient" style={{ fontSize: 14, fontWeight: 600 }}>For</label>
                <select
                  id="recipient"
                  value={recipientId}
                  onChange={e => setRecipientId(e.target.value)}
                  style={{ width: '100%', minWidth: 0, padding: 10, border: '1px solid #e7eaee', borderRadius: 10, background: '#fff' }}
                >
                  {members.map(m => (
                    <option key={m.id} value={m.id}>{m.name}</option>
                  ))}
                </select>
              </div>
            </div>

            <div style={{ display: 'grid', gap: 8, minWidth: 0 }}>
              <label htmlFor="kindness-note" style={{ fontSize: 14, fontWeight: 600 }}>Kindness note</label>
              <textarea
                id="kindness-note"
                rows={3}
                value={body}
                onChange={e => setBody(e.target.value)}
                placeholder="Write something kind or thank someone for a helpful act..."
                style={{ width: '100%', minWidth: 0, padding: 12, border: '1px solid #e7eaee', borderRadius: 10, fontFamily: 'inherit', resize: 'vertical' }}
              />
            </div>

            <div>
              <Button type="submit" busy={saving} disabled={loading || !!error || !body.trim()}>
                {saving ? 'Adding…' : 'Add kindness'}
              </Button>
            </div>
          </form>
        </div>

        {/* Notes List */}
        {loading ? (
          <Feedback kind="loading" title="Loading kindness notes…" />
        ) : (
          <CardList
            items={notes}
            empty="The jar is empty right now. Be the first to share a kind note!"
            renderItem={item => {
              const fromName = memberMap.get(String(item.authorId ?? '')) || 'Someone';
              const toName = memberMap.get(String(item.recipientId ?? '')) || 'Someone';
              const dateStr = item.createdAt ? new Date(Number(item.createdAt)).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
              const isDeleting = deletingId === item.id;

              return (
                <div style={{ display: 'grid', gap: 8, minWidth: 0 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <div style={{ fontSize: 13, color: '#69727e' }}>
                      <strong style={{ color: '#1e1f20' }}>{fromName}</strong> for <strong style={{ color: '#1e1f20' }}>{toName}</strong> {dateStr ? `• ${dateStr}` : ''}
                    </div>
                    <button
                      type="button"
                      onClick={() => removeNote(item.id)}
                      disabled={isDeleting}
                      style={{ background: 'none', border: 'none', color: '#69727e', cursor: 'pointer', fontSize: 13, padding: 4 }}
                    >
                      {isDeleting ? 'Removing…' : 'Delete'}
                    </button>
                  </div>
                  <p style={{ margin: 0, whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{String(item.body ?? '')}</p>
                </div>
              );
            }}
          />
        )}
      </Section>
    </main>
  );
}