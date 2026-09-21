# Authoring utility: writes the canonical versioned kit into the Firestore seed.
# No runtime bundle/fallback is generated; running apps read Firestore only.
import json
from pathlib import Path
entries=[]
def add(id,purpose,use,avoid,tags,caps,deps,source,example):
 entries.append(dict(id=id,version=1,purpose=purpose,useWhen=use,avoidWhen=avoid,tags=tags,capabilities=caps,dependencies=deps,source=source,example=example))
add('section-actions','Aligned heading, description and actions','Page or section heading with optional actions','Nested application navigation',['heading','toolbar','header','layout','spacing'],['layout','heading','actions'],[],'''function Section({title,description,actions,children}) {
 return <section style={{display:'grid',gap:24,minWidth:0}}><header style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:16,flexWrap:'wrap'}}><div style={{display:'grid',gap:8,minWidth:0}}><h2 style={{margin:0}}>{title}</h2>{description && <p style={{margin:0,color:'#69727e',maxWidth:'65ch'}}>{description}</p>}</div>{actions && <div style={{display:'flex',gap:12,flexWrap:'wrap',alignItems:'center'}}>{actions}</div>}</header>{children}</section>;
}''','<Section title="Weekend plans" description="Choose something together."><p>No plans yet.</p></Section>')
add('button','Consistent primary and secondary actions','Submit, retry, add or remove actions','Navigation to external sites',['button','action','submit','save','retry'],['actions'],[],'''function Button({children,variant='primary',busy=false,disabled=false,type='button',...props}) {
 return <button {...props} type={type} className={variant === 'primary' ? 'primary' : 'secondary'} disabled={disabled || busy} aria-busy={busy} style={{minHeight:44,padding:'11px 19px'}}>{children}</button>;
}''','<Button>Choose dinner</Button>')
add('field','Labeled controlled text input','Names, titles and editable text with optional help or errors','Checkboxes, radio groups or unlabeled icon inputs',['form','input','field','label','text','edit'],['form','input'],[],'''function Field({id,label,value,onChange,hint,error,...props}) {
 return <div style={{display:'grid',gap:8,minWidth:0}}><label htmlFor={id}>{label}</label><input {...props} id={id} value={value} onChange={onChange} aria-invalid={!!error} aria-describedby={error || hint ? id+'-help' : undefined} style={{width:'100%',minWidth:0,padding:12,border:'1px solid #e7eaee',borderRadius:10}}/>{(error || hint) && <p id={id+'-help'} role={error ? 'alert' : undefined} style={{margin:0,color:error ? '#9e302b' : '#69727e'}}>{error || hint}</p>}</div>;
}''','<Field id="name" label="Name" value="" onChange={()=>{}} hint="Give your plan a name."/>')
add('card-list','Padded content with consistently spaced list rows','Collections of choices, chores, plans or records','Wrapping every heading in another nested card',['card','list','options','choices','chores','plans','records'],['list','surface'],[],'''function CardList({items,renderItem,empty='Nothing here yet.'}) {
 return <div className="surface" style={{padding:20,minWidth:0}}>{items.length ? <ul style={{listStyle:'none',padding:0,margin:0,display:'grid',gap:16}}>{items.map(item=><li key={item.id} style={{minWidth:0}}>{renderItem(item)}</li>)}</ul> : <p style={{margin:0,color:'#69727e'}}>{empty}</p>}</div>;
}''','<CardList items={[{id:"one",title:"Picnic"}]} renderItem={item=><span>{item.title}</span>}/>')
add('feedback','Loading, empty and error feedback with recovery actions','Explain loading, no records, validation or failed saves','Permanent success banners for every action',['loading','empty','error','notice','retry','recovery','status'],['feedback','loading','error','empty'],[],'''function Feedback({kind='empty',title,children,actions}) {
 return <div role={kind === 'error' ? 'alert' : 'status'} style={{display:'grid',gap:12,padding:'20px 0',borderTop:'1px solid #e7eaee',minWidth:0}}><strong>{title}</strong>{children && <div style={{color:'#69727e',lineHeight:1.6}}>{children}</div>}{actions && <div style={{display:'flex',gap:12,flexWrap:'wrap'}}>{actions}</div>}</div>;
}''','<Feedback kind="empty" title="Add your first idea">Everyone can help choose.</Feedback>')
add('disclosure','Expandable supporting information','Optional details, instructions or error reports','Hiding the primary task or essential recovery action',['details','disclosure','expand','help','error'],['disclosure'],[],'''function Disclosure({title,children}) {
 return <details style={{borderTop:'1px solid #e7eaee',paddingTop:16,minWidth:0}}><summary style={{cursor:'pointer',color:'#69727e'}}>{title}</summary><div style={{marginTop:12,overflowWrap:'anywhere'}}>{children}</div></details>;
}''','<Disclosure title="How this works"><p>Your family chooses together.</p></Disclosure>')
add('persistent-records','Live saved list with explicit add, loading and failed write handling','Apps that save records and share them across family members','Atomic counters, transactions or per-user permissions',['save','persist','records','database','list','add','form'],['persistence','list','form','feedback'],['section-actions','button','field','card-list','feedback'],'''// Include these imports once in the final module.
import {useState} from 'react';
import {useAppData} from '@kin/app';
function SavedIdeas() {
 const {records,loading,error,setRecord}=useAppData();
 const [title,setTitle]=useState(''),[saving,setSaving]=useState(false),[failure,setFailure]=useState('');
 async function add(event) {event.preventDefault();if(!title.trim() || loading || saving)return;setSaving(true);setFailure('');try{await setRecord(crypto.randomUUID(),{title:title.trim()});setTitle('');}catch(e){setFailure(e instanceof Error ? e.message : String(e));}finally{setSaving(false);}}
 return <Section title="Family ideas">{error || failure ? <Feedback kind="error" title="Could not save or load ideas">{error || failure}</Feedback> : null}<form onSubmit={add} style={{display:'grid',gap:16}}><Field id="idea" label="Your idea" value={title} onChange={e=>setTitle(e.target.value)}/><div><Button type="submit" busy={saving} disabled={loading || !!error || !title.trim()}>{saving ? 'Saving…' : 'Add idea'}</Button></div></form>{loading ? <Feedback kind="loading" title="Loading ideas…"/> : <CardList items={records} renderItem={item=><span>{String(item.title ?? '')}</span>} empty="Add your first idea."/>}</Section>;
}''','<SavedIdeas/>')
p=Path(__file__).resolve().parent.parent/'seed.json'
seed=json.loads(p.read_text()); docs=seed['firestore']['firestore']
for e in entries: docs['families/parkers/uiKits/kin-v1/entries/'+e['id']]=e
p.write_text(json.dumps(seed,indent=2)+'\n')
# Static deployment migration payload, installed into Firestore before consumption.
asset=p.parent/'public/ui-kit/kin-v1.json'
asset.parent.mkdir(parents=True,exist_ok=True)
asset.write_text(json.dumps(dict(version='kin-v1',entries=entries),indent=2)+'\n')
