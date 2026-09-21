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
        style={{ width: '100%', minWidth: 0, padding: 12, border: '1px solid #e7eaee', borderRadius: 10, background: '#fff' }}
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
  const [title, setTitle] = useState('');
  const [readerId, setReaderId] = useState(family.members[0]?.id || '');
  const [filterReader, setFilterReader] = useState('all');
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState('');

  const members = family.members || [];
  const defaultMemberId = members[0]?.id || '';
  const currentReaderId = readerId || defaultMemberId;

  async function addBook(event) {
    event.preventDefault();
    if (!title.trim() || loading || saving) return;
    setSaving(true);
    setFailure('');
    try {
      await setRecord(crypto.randomUUID(), {
        title: title.trim(),
        readerId: currentReaderId,
        status: 'reading',
        timestamp: Date.now()
      });
      setTitle('');
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function addSampleBooks() {
    if (loading || saving) return;
    setSaving(true);
    setFailure('');
    try {
      const sampleTitles = ['The Magic Treehouse', 'The Great Family Cookbook', 'Adventures in Space'];
      for (let i = 0; i < sampleTitles.length; i++) {
        const assignedReader = members[i % members.length]?.id || defaultMemberId;
        await setRecord(crypto.randomUUID(), {
          title: sampleTitles[i],
          readerId: assignedReader,
          status: i === 0 ? 'finished' : 'reading',
          timestamp: Date.now() - i * 100000
        });
      }
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function toggleStatus(item) {
    if (loading || saving) return;
    setSaving(true);
    setFailure('');
    const newStatus = item.status === 'finished' ? 'reading' : 'finished';
    try {
      await setRecord(item.id, {
        title: item.title,
        readerId: item.readerId,
        status: newStatus,
        timestamp: item.timestamp || Date.now()
      });
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function removeItem(id) {
    if (loading || saving) return;
    setSaving(true);
    setFailure('');
    try {
      await deleteRecord(id);
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const books = records.map(r => ({
    id: r.id,
    title: String(r.title ?? ''),
    readerId: String(r.readerId ?? defaultMemberId),
    status: String(r.status ?? 'reading'),
    timestamp: Number(r.timestamp ?? 0)
  }));

  const filteredBooks = books.filter(b => filterReader === 'all' || b.readerId === filterReader);
  const finishedCount = books.filter(b => b.status === 'finished').length;

  function getMemberName(id) {
    const found = members.find(m => m.id === id);
    return found ? found.name : 'Someone';
  }

  return (
    <main style={{ maxWidth: 760, margin: '0 auto', padding: 20, display: 'grid', gap: 24, fontFamily: 'inherit' }}>
      <Section
        title="Family Reading Trail"
        description={`Books we are exploring together. ${finishedCount} book${finishedCount === 1 ? '' : 's'} finished so far!`}
      >
        {error || failure ? (
          <Feedback kind="error" title="Could not save or load books">
            {error || failure}
          </Feedback>
        ) : null}

        <form onKeyDown={event=>{if(event.key==='Enter' && event.target.tagName==='INPUT'){event.preventDefault();if(event.currentTarget.reportValidity())event.currentTarget.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));}}} onSubmit={addBook} style={{ display: 'grid', gap: 16, background: '#fff', padding: 20, borderRadius: 12, border: '1px solid #e7eaee' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 12, alignItems: 'end' }}>
            <Field
              id="book-title"
              label="Book title"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="e.g. The Hobbit"
            />
            <div style={{ display: 'grid', gap: 8, minWidth: 0 }}>
              <label htmlFor="reader-select">Reader</label>
              <select
                id="reader-select"
                value={currentReaderId}
                onChange={e => setReaderId(e.target.value)}
                style={{ height: 46, padding: '0 12px', border: '1px solid #e7eaee', borderRadius: 10, background: '#fff', minWidth: 120 }}
              >
                {members.map(m => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <Button type="submit" busy={saving} disabled={loading || !!error || !title.trim()}>
              {saving ? 'Adding…' : 'Add book'}
            </Button>
          </div>
        </form>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 14, color: '#69727e' }}>Filter reader:</span>
            <select
              value={filterReader}
              onChange={e => setFilterReader(e.target.value)}
              style={{ padding: '8px 12px', border: '1px solid #e7eaee', borderRadius: 8, background: '#fff', fontSize: 14 }}
            >
              <option value="all">Everyone ({books.length})</option>
              {members.map(m => (
                <option key={m.id} value={m.id}>
                  {m.name} ({books.filter(b => b.readerId === m.id).length})
                </option>
              ))}
            </select>
          </div>

          {!books.length && !loading && (
            <Button variant="secondary" busy={saving} onClick={addSampleBooks}>
              Add sample books
            </Button>
          )}
        </div>

        {loading ? (
          <Feedback kind="loading" title="Loading reading trail…" />
        ) : (
          <CardList
            items={filteredBooks}
            renderItem={item => (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
                <div style={{ display: 'grid', gap: 4, minWidth: 0 }}>
                  <span style={{ fontWeight: 500, fontSize: 16, textDecoration: item.status === 'finished' ? 'line-through' : 'none', color: item.status === 'finished' ? '#69727e' : '#1e1f20' }}>
                    {item.title}
                  </span>
                  <span style={{ fontSize: 13, color: '#69727e' }}>
                    Reader: {getMemberName(item.readerId)} • Status: {item.status === 'finished' ? 'Finished ✓' : 'Reading'}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <Button variant="secondary" busy={saving} onClick={() => toggleStatus(item)}>
                    {item.status === 'finished' ? 'Mark reading' : 'Mark finished'}
                  </Button>
                  <Button variant="secondary" busy={saving} onClick={() => removeItem(item.id)}>
                    Remove
                  </Button>
                </div>
              </div>
            )}
            empty={filterReader === 'all' ? 'No books on the trail yet. Add your first book or sample books above!' : 'No books found for this reader.'}
          />
        )}
      </Section>
    </main>
  );
}