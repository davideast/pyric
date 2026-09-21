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
    <div
      role={kind === 'error' ? 'alert' : 'status'}
      style={{ display: 'grid', gap: 12, padding: '20px 0', borderTop: '1px solid #e7eaee', minWidth: 0 }}
    >
      <strong>{title}</strong>
      {children && <div style={{ color: '#69727e', lineHeight: 1.6 }}>{children}</div>}
      {actions && <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>{actions}</div>}
    </div>
  );
}

export default function App({ family }) {
  const { records, loading, error, setRecord, deleteRecord } = useAppData();
  const [itemName, setItemName] = useState('');
  const [assignedMemberId, setAssignedMemberId] = useState('');
  const [filter, setFilter] = useState('all');
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState('');
  const [confirmUnpack,setConfirmUnpack]=useState(false);
  const [isEditingTrip, setIsEditingTrip] = useState(false);

  const tripRecord = records.find((r) => r.id === 'trip-title');
  const tripTitle = typeof tripRecord?.title === 'string' ? tripRecord.title : 'Family Adventure';
  const [tripInput, setTripInput] = useState(tripTitle);

  const items = records.filter((r) => r.id !== 'trip-title');
  const packedCount = items.filter((i) => i.packed).length;
  const progressPercent = items.length ? Math.round((packedCount / items.length) * 100) : 0;

  const filteredItems = items.filter((item) => {
    if (filter === 'remaining') return !item.packed;
    if (filter === 'packed') return item.packed;
    return true;
  });

  async function handleSaveTrip(e) {
    e.preventDefault();
    if (!tripInput.trim() || loading || saving) return;
    setSaving(true);
    setActionError('');
    try {
      await setRecord('trip-title', { title: tripInput.trim() });
      setIsEditingTrip(false);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleAddItem(e) {
    e.preventDefault();
    if (!itemName.trim() || loading || saving) return;
    setSaving(true);
    setActionError('');
    try {
      await setRecord(crypto.randomUUID(), {
        name: itemName.trim(),
        packed: false,
        assignedTo: assignedMemberId || '',
      });
      setItemName('');
      setAssignedMemberId('');
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleTogglePacked(item) {
    if (loading || saving) return;
    setSaving(true);
    setActionError('');
    try {
      await setRecord(item.id, {
        name: item.name,
        packed: !item.packed,
        assignedTo: item.assignedTo || '',
      });
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteItem(id) {
    if (loading || saving) return;
    setSaving(true);
    setActionError('');
    try {
      await deleteRecord(id);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleUnpackAll() {
    if (loading || saving || !items.length) return;
    if (!confirmUnpack) { setConfirmUnpack(true); return; }
    setConfirmUnpack(false);
    setSaving(true);
    setActionError('');
    try {
      for (const item of items) {
        await setRecord(item.id, {
          name: item.name,
          packed: false,
          assignedTo: item.assignedTo || '',
        });
      }
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleAddSampleItems() {
    if (loading || saving) return;
    const samples = [
      { name: 'Passports & Tickets', assignedTo: family.members[0]?.id || '' },
      { name: 'Water bottles', assignedTo: family.members[1]?.id || '' },
      { name: 'First aid kit', assignedTo: '' },
      { name: 'Sunscreen & Hats', assignedTo: '' },
    ];
    setSaving(true);
    setActionError('');
    try {
      for (const sample of samples) {
        await setRecord(crypto.randomUUID(), {
          name: sample.name,
          packed: false,
          assignedTo: sample.assignedTo,
        });
      }
      if (!tripRecord) {
        await setRecord('trip-title', { title: 'Family Weekend Getaway' });
        setTripInput('Family Weekend Getaway');
      }
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const members = family?.members ?? [];

  return (
    <main style={{ maxWidth: 760, margin: '0 auto', padding: 20, display: 'grid', gap: 24, minWidth: 0, boxSizing: 'border-box' }}>
      {confirmUnpack && <Button variant="secondary" onClick={()=>setConfirmUnpack(false)}>Cancel unpack</Button>}
      <Section
        title={tripTitle}
        description={`Pack & Go for ${family?.family || 'Family'}. Track everything before departure.`}
        actions={
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button variant="secondary" onClick={() => { setTripInput(tripTitle); setIsEditingTrip(!isEditingTrip); }}>
              {isEditingTrip ? 'Cancel' : 'Edit Trip Name'}
            </Button>
            {items.length > 0 && (
              <Button variant="secondary" disabled={loading || saving} onClick={handleUnpackAll}>
                {confirmUnpack ? "Confirm unpack all" : "Unpack all"}
              </Button>
            )}
            {!items.length && (
              <Button variant="secondary" disabled={loading || saving} onClick={handleAddSampleItems}>
                Add sample items
              </Button>
            )}
          </div>
        }
      >
        {error || actionError ? (
          <Feedback kind="error" title="Could not complete action">
            {error || actionError}
          </Feedback>
        ) : null}

        {isEditingTrip && (
          <form onKeyDown={event=>{if(event.key==='Enter' && event.target.tagName==='INPUT'){event.preventDefault();if(event.currentTarget.reportValidity())event.currentTarget.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));}}} onSubmit={handleSaveTrip} className="surface" style={{ padding: 20, display: 'grid', gap: 16 }}>
            <Field
              id="trip-title-input"
              label="Trip Title"
              value={tripInput}
              onChange={(e) => setTripInput(e.target.value)}
              hint="Give your trip a lightweight title."
            />
            <div>
              <Button type="submit" busy={saving} disabled={loading || !tripInput.trim()}>
                Save Trip Name
              </Button>
            </div>
          </form>
        )}

        {/* Progress Bar */}
        <div className="surface" style={{ padding: 20, display: 'grid', gap: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontWeight: 600 }}>Packing Progress</span>
            <span style={{ color: '#69727e' }}>
              {packedCount} of {items.length} packed ({progressPercent}%)
            </span>
          </div>
          <div style={{ width: '100%', height: 10, background: '#e7eaee', borderRadius: 5, overflow: 'hidden' }}>
            <div
              style={{
                width: `${progressPercent}%`,
                height: '100%',
                background: '#0659fd',
                transition: 'width 0.3s ease',
              }}
            />
          </div>
        </div>

        {/* Add Item Form */}
        <form onKeyDown={event=>{if(event.key==='Enter' && event.target.tagName==='INPUT'){event.preventDefault();if(event.currentTarget.reportValidity())event.currentTarget.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));}}} onSubmit={handleAddItem} className="surface" style={{ padding: 20, display: 'grid', gap: 16 }}>
          <h3 style={{ margin: 0, fontSize: '1rem' }}>Add Packing Item</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', gap: 12, alignItems: 'end' }}>
            <Field
              id="packing-item-input"
              label="Packing item"
              value={itemName}
              onChange={(e) => setItemName(e.target.value)}
              placeholder="e.g. Hiking boots, Chargers..."
            />
            <div style={{ display: 'grid', gap: 8, minWidth: 0 }}>
              <label htmlFor="assigned-member">Responsible</label>
              <select
                id="assigned-member"
                value={assignedMemberId}
                onChange={(e) => setAssignedMemberId(e.target.value)}
                style={{ width: '100%', minWidth: 0, padding: 12, border: '1px solid #e7eaee', borderRadius: 10, background: '#fff', minHeight: 44 }}
              >
                <option value="">Anyone / Unassigned</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <Button type="submit" busy={saving} disabled={loading || !itemName.trim()}>
              {saving ? 'Adding…' : 'Add item'}
            </Button>
          </div>
        </form>

        {/* Filters & List */}
        <div style={{ display: 'grid', gap: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <Button
                variant={filter === 'all' ? 'primary' : 'secondary'}
                onClick={() => setFilter('all')}
              >
                All ({items.length})
              </Button>
              <Button
                variant={filter === 'remaining' ? 'primary' : 'secondary'}
                onClick={() => setFilter('remaining')}
              >
                Remaining ({items.filter((i) => !i.packed).length})
              </Button>
              <Button
                variant={filter === 'packed' ? 'primary' : 'secondary'}
                onClick={() => setFilter('packed')}
              >
                Packed ({packedCount})
              </Button>
            </div>
          </div>

          {loading ? (
            <Feedback kind="loading" title="Loading packing list…" />
          ) : (
            <CardList
              items={filteredItems}
              empty={
                items.length === 0
                  ? 'No packing items yet. Add your first item above or load sample items.'
                  : 'No items match this filter.'
              }
              renderItem={(item) => {
                const assigned = members.find((m) => m.id === item.assignedTo);
                return (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 12,
                      minWidth: 0,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0, flex: 1 }}>
                      <input
                        type="checkbox"
                        checked={!!item.packed}
                        disabled={saving}
                        onChange={() => handleTogglePacked(item)}
                        style={{ width: 20, height: 20, cursor: 'pointer' }}
                        aria-label={`Toggle packed for ${String(item.name)}`}
                      />
                      <div style={{ display: 'grid', gap: 4, minWidth: 0, flex: 1 }}>
                        <span
                          style={{
                            textDecoration: item.packed ? 'line-through' : 'none',
                            color: item.packed ? '#69727e' : 'inherit',
                            fontWeight: 500,
                            wordBreak: 'break-word',
                          }}
                        >
                          {String(item.name ?? '')}
                        </span>
                        {assigned && (
                          <span style={{ fontSize: '0.85rem', color: '#69727e' }}>
                            Responsible: {assigned.name}
                          </span>
                        )}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleDeleteItem(item.id)}
                      disabled={saving}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: '#69727e',
                        cursor: 'pointer',
                        padding: 8,
                        fontSize: '0.9rem',
                      }}
                      title="Delete item"
                    >
                      Remove
                    </button>
                  </div>
                );
              }}
            />
          )}
        </div>
      </Section>
    </main>
  );
}