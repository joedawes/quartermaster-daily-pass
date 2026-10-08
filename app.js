'use strict';
// Quartermaster Daily Pass v1.5. All manuscript edits are user-confirmed.
const STORE = 'quartermaster_daily_pass_v1';
const CLOUD_STORE = 'quartermaster_daily_cloud_v1';
const SYNC_STORE = 'quartermaster_daily_sync_v1';
const blank = () => ({version:1, theme:'dark', activeId:null, chapters:[]});
const $ = id => document.getElementById(id);
const cleanText = s => String(s ?? '').replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n');
const id = () => crypto.randomUUID ? crypto.randomUUID() : 'id-'+Date.now()+'-'+Math.random().toString(36).slice(2);
const h = s => String(s ?? '').replace(/[&<>"']/g, v => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[v]));
const countWords = t => (t.trim().match(/\S+/g)||[]).length;
const timeString = t => new Date(t).toLocaleString(undefined,{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
const clone = x => JSON.parse(JSON.stringify(x));
const download = (name, content, mime='text/plain;charset=utf-8') => {const a=document.createElement('a'),u=URL.createObjectURL(new Blob([content],{type:mime}));a.href=u;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(u),1500);};
const filename = str => String(str).replace(/[^a-z\d ._-]/gi,'').trim().replace(/\s+/g,'_').slice(0,90)||'Chapter';
const notify = msg => { $('save-status').textContent = msg; };
let state;
try { state=JSON.parse(localStorage.getItem(STORE))||blank(); if(!state||!Array.isArray(state.chapters))state=blank(); }catch(_){state=blank();}
state.theme = state.theme==='light'?'light':'dark';
let homeVisible=true;
let undoStack=[], selectedSuggestion=null, editingSuggestion=null, noteSelectedText='', syncTimer=null, showingOriginal=false;
let syncMeta; try{syncMeta=JSON.parse(localStorage.getItem(SYNC_STORE))||{};}catch(_){syncMeta={};}
let dirty=!!syncMeta.dirty, cloudRev=syncMeta.revision??null, cloudUserId=syncMeta.userId||null;
let sb=null, user=null, syncing=false, conflictBusy=false;
const configuredCloud=window.QM_CLOUD_CONFIG||{};
let cloudCfg;try{cloudCfg=JSON.parse(localStorage.getItem(CLOUD_STORE))||{};}catch(_){cloudCfg={};}
if(!cloudCfg.url && configuredCloud.url)cloudCfg.url=configuredCloud.url;
if(!cloudCfg.key && configuredCloud.publishableKey)cloudCfg.key=configuredCloud.publishableKey;

function remember(){undoStack.push(clone(state));if(undoStack.length>30)undoStack.shift();}
function writeLocal(markDirty=true){
  try{localStorage.setItem(STORE,JSON.stringify(state));}catch(e){notify('Local save FAILED — export a backup now');console.error(e);return;}
  if(markDirty){dirty=true;persistSyncMeta();scheduleSync();}
  notify(markDirty && user?'Saved locally · cloud pending':'Saved locally');
  paintSync();
}
function persistSyncMeta(){localStorage.setItem(SYNC_STORE,JSON.stringify({dirty,revision:cloudRev,userId:cloudUserId}));}
function touch(){writeLocal(true);render();}
function current(){return state.chapters.find(c=>c.id===state.activeId)||null;}
function ensureChapter(c){c.suggestions??=[];c.originalText??=c.text||'';c.text??='';}
function addChapter(title,text){homeVisible=false;remember();const c={id:id(),title:title.trim()||`Chapter ${state.chapters.length+1}`,originalText:cleanText(text),text:cleanText(text),suggestions:[],createdAt:Date.now(),updatedAt:Date.now()};state.chapters.push(c);state.activeId=c.id;touch();}
function mutate(fn){const c=current();if(!c)return;remember();fn(c);c.updatedAt=Date.now();touch();}
function switchChapter(chId){homeVisible=false;closeEditor();showingOriginal=false;state.activeId=chId;selectedSuggestion=null;writeLocal(false);render();}

function resolveAnchor(s,c){
  const needle=s.original||'';
  if(!needle)return {position:-1,reason:'Note only'};
  if(Number.isInteger(s.position) && s.position>=0 && c.text.slice(s.position,s.position+needle.length)===needle)return {position:s.position};
  let found=[],from=0,p;
  while((p=c.text.indexOf(needle,from))!==-1){found.push(p);if(found.length>100)break;from=p+Math.max(needle.length,1);}
  if(found.length===1)return {position:found[0]};
  if(found.length>1 && Number.isInteger(s.occurrence) && found[s.occurrence]!=null)return {position:found[s.occurrence]};
  return {position:-1,reason:found.length?'Repeated passage — edit the anchor to make it unique':'Passage changed or not found — review manually'};
}
// Revert only when the exact accepted replacement can still be located safely.
// This remains conservative if the user has edited the passage since acceptance.
function resolveRevertAnchor(s,c){
  const value=s.replacement;
  if(typeof value!=='string'||!value.length||value===s.original)return -1;
  if(Number.isInteger(s.position)&&s.position>=0&&c.text.slice(s.position,s.position+value.length)===value)return s.position;
  const first=c.text.indexOf(value);
  return first>=0&&c.text.indexOf(value,first+value.length)===-1?first:-1;
}
function highlightedHTML(c){
  const ranges=[];
  for(const s of c.suggestions){if(s.status!=='pending'||!s.original)continue;const a=resolveAnchor(s,c);if(a.position>=0)ranges.push({...a,end:a.position+s.original.length,id:s.id,priority:s.priority});}
  ranges.sort((a,b)=>a.position-b.position||b.end-a.end);
  let cursor=0,output='';
  for(const r of ranges){if(r.position<cursor)continue;output+=h(c.text.slice(cursor,r.position));output+=`<mark data-sid="${h(r.id)}" data-kind="${h(r.priority)}" class="${selectedSuggestion===r.id?'selected':''}">${h(c.text.slice(r.position,r.end))}</mark>`;cursor=r.end;}
  return output+h(c.text.slice(cursor));
}
function renderChapters(){
  const html=state.chapters.map(c=>{ensureChapter(c);const total=c.suggestions.length,done=c.suggestions.filter(s=>s.status!=='pending').length;return `<button class="chapter-tab ${c.id===state.activeId?'current':''}" data-chapter="${h(c.id)}"><span class="chapter-name">${h(c.title)}</span><span class="small-count">${total?`${done}/${total}`:`${countWords(c.text)}w`}</span></button>`;}).join('');
  $('chapter-list').innerHTML=html || '<p class="muted fine" style="padding:0 10px">No chapters yet.</p>';
}
function render(){
  document.documentElement.dataset.theme=state.theme;
  renderChapters();
  const c=current();$('home-screen').hidden=!homeVisible;$('empty-state').hidden=homeVisible||!!c;$('chapter-workspace').hidden=homeVisible||!c;
  if(!c)return;
  ensureChapter(c);
  $('chapter-title').textContent=c.title;
  $('chapter-subtitle').textContent='Original kept safely · last worked '+timeString(c.updatedAt);
  $('word-count').textContent=countWords(c.text).toLocaleString()+' words';
  $('manuscript-view').innerHTML=showingOriginal?h(c.originalText):highlightedHTML(c);
  $('view-original').textContent=showingOriginal?'View working':'View original';
  $('add-selection-note').disabled=showingOriginal;
  $('edit-text').disabled=showingOriginal;
  const done=c.suggestions.filter(s=>s.status!=='pending').length,total=c.suggestions.length;
  $('progress-label').textContent=`${done} / ${total} reviewed`;
  $('progress-fill').style.width=total?(100*done/total)+'%':'0%';
  $('review-count').textContent=total+' note'+(total===1?'':'s');
  renderReviews(c);
  $('undo-btn').disabled=!undoStack.length;
}
function renderReviews(c){
  let notes=[...c.suggestions].sort((a,b)=>{const pa=resolveAnchor(a,c).position,pb=resolveAnchor(b,c).position;return (pa<0?Infinity:pa)-(pb<0?Infinity:pb)||(a.createdAt||0)-(b.createdAt||0);});const filter=$('review-filter').value;
  if(filter==='pending')notes=notes.filter(s=>s.status==='pending');
  if(filter==='later')notes=notes.filter(s=>s.status==='deferred'||(s.priority==='later'&&s.status==='pending'));
  if(filter==='done')notes=notes.filter(s=>s.status!=='pending');
  $('review-items').innerHTML=notes.map(s=>{
    const anchor=resolveAnchor(s,c);
    const actionable=s.status==='pending';
    const observation=!!s.original && s.replacement===s.original;
    const tag=s.status==='pending'?s.priority:s.status;
    const canRevert=s.status==='accepted' && s.original && s.replacement!==null && s.replacement!==undefined && resolveRevertAnchor(s,c)>=0;
    return `<article class="review-card ${selectedSuggestion===s.id?'selected':''}" data-card="${h(s.id)}" data-status="${h(s.status)}">
     <div class="review-top"><span class="tagline"><span class="tag ${h(tag)}">${h(tag==='clear'?'Mechanical':tag==='possible'?'Consider':tag==='later'?'Later':tag)}</span><span class="category">${h(s.type||'note')}</span></span><button class="btn tiny ghost" data-action="locate" data-id="${h(s.id)}" aria-label="Locate suggestion in manuscript">↗ Find</button></div>
     ${s.original?`<div class="snippet-label">Current / original</div><div class="edit-snippet before">${h(s.original)}</div>`:''}
     ${s.replacement!==null && s.replacement!==undefined && s.original && !observation?`<div class="snippet-label">Suggested</div><div class="edit-snippet after">${h(s.replacement)||'<em>(delete text)</em>'}</div>`:''}
     ${s.note?`<p class="review-note">${h(s.note)}</p>`:''}
     ${actionable && s.original && anchor.position<0?`<div class="anchor-warning">${h(anchor.reason)}. No automatic replacement.</div>`:''}
     <div class="review-buttons">${actionable?
       `${s.original && s.replacement!==null && s.replacement!==undefined && !observation?`<button class="btn tiny primary" data-action="accept" data-id="${h(s.id)}" ${anchor.position<0?'disabled':''}>Accept</button>`:`<button class="btn tiny primary" data-action="reviewed" data-id="${h(s.id)}">Mark reviewed</button>`}
         <button class="btn tiny outline" data-action="edit" data-id="${h(s.id)}">Edit</button>
         <button class="btn tiny ghost" data-action="skip" data-id="${h(s.id)}">Skip</button>
         ${s.priority==='later'?'':`<button class="btn tiny ghost" data-action="later" data-id="${h(s.id)}">Later</button>`}`:
       `<span class="fine muted">${h(s.status)} —</span>${canRevert?`<button class="btn tiny outline" data-action="revert" data-id="${h(s.id)}" title="Restore the exact original wording">↶ Revert</button>`:`<button class="btn tiny ghost" data-action="reopen" data-id="${h(s.id)}" title="Reopen the note without changing manuscript text">Reopen</button>`}`}
     </div></article>`;
  }).join('') || `<div class="no-notes">${filter==='pending'?'No pending suggestions. Import a review or add your own notes.':'Nothing to show in this filter.'}</div>`;
}
function selectSuggestion(sid){selectedSuggestion=sid;render();const card=document.querySelector(`[data-card="${CSS.escape(sid)}"]`);if(card)card.scrollIntoView({block:'nearest',behavior:'smooth'});const mark=document.querySelector(`mark[data-sid="${CSS.escape(sid)}"]`);if(mark)mark.scrollIntoView({block:'center',behavior:'smooth'});}
function advanceReview(previousId){
  const c=current();if(!c)return;
  const ordered=[...c.suggestions].sort((a,b)=>{const pa=resolveAnchor(a,c).position,pb=resolveAnchor(b,c).position;return (pa<0?Infinity:pa)-(pb<0?Infinity:pb)||(a.createdAt||0)-(b.createdAt||0);});
  const next=ordered.find(s=>s.status==='pending'&&s.id!==previousId);
  selectedSuggestion=null;if(next)selectSuggestion(next.id);else render();
}
function actOnSuggestion(sid,action){
  const c=current(),s=c?.suggestions.find(t=>t.id===sid);if(!s)return;
  if(action==='locate'){selectSuggestion(sid);return;}
  if(action==='edit'){openNote(s);return;}
  if(action==='revert'){
    const pos=resolveRevertAnchor(s,c);
    if(pos<0){alert('The accepted wording has changed or cannot be uniquely located. Compare with View original and restore it manually.');return;}
    mutate(ch=>{
      const t=ch.suggestions.find(t=>t.id===sid),at=resolveRevertAnchor(t,ch);
      if(at<0)return;
      ch.text=ch.text.slice(0,at)+t.original+ch.text.slice(at+t.replacement.length);
      t.status='pending';t.position=at;delete t.acceptedAt;
      const delta=t.original.length-t.replacement.length;
      for(const other of ch.suggestions){if(other.id!==sid&&other.status==='pending'&&Number.isInteger(other.position)&&other.position>=at+t.replacement.length)other.position+=delta;}
    });
    return;
  }
  if(action==='accept'){
    if(s.replacement===s.original){alert('This is an observation, not a correction. Use Edit, Skip or Later.');return;}
    const anchor=resolveAnchor(s,c);if(anchor.position<0||s.replacement===null||s.replacement===undefined){alert('This passage cannot be matched safely. Edit the anchor or change the chapter manually.');return;}
    mutate(ch=>{
      const t=ch.suggestions.find(t=>t.id===sid),pos=resolveAnchor(t,ch).position;
      if(pos<0)return;
      ch.text=ch.text.slice(0,pos)+t.replacement+ch.text.slice(pos+t.original.length);
      t.status='accepted';t.acceptedAt=Date.now();
      const delta=t.replacement.length-t.original.length;
      for(const other of ch.suggestions){if(other.id!==sid && other.status==='pending' && Number.isInteger(other.position) && other.position>=pos+t.original.length)other.position+=delta;}
    });
    advanceReview(sid);
    return;
  }
  if(action==='reviewed'||action==='skip'||action==='later'||action==='reopen')mutate(ch=>{const t=ch.suggestions.find(t=>t.id===sid);if(action==='reviewed')t.status='accepted';if(action==='skip')t.status='skipped';if(action==='later'){t.priority='later';t.status='deferred';}if(action==='reopen')t.status='pending';});
  if(['skip','later','reviewed'].includes(action))advanceReview(sid);
}
function openNote(s=null,fromSelection=''){
  if(!current())return;
  editingSuggestion=s?.id||null;
  $('note-dialog-title').textContent=s?'Edit suggestion':'Add a review note';
  $('note-original').value=s?.original??fromSelection??'';
  $('note-replacement').value=s?.replacement??s?.original??fromSelection??'';
  $('note-explanation').value=s?.note??'';
  $('note-category').value=Array.from($('note-category').options).some(o=>o.value===s?.type)?s.type:'other';
  $('note-priority').value=s?.priority||'possible';
  $('note-dialog').showModal();
}
function saveNote(){
  const original=cleanText($('note-original').value),replacement=cleanText($('note-replacement').value),note=$('note-explanation').value.trim();
  if(!original && !note){alert('Enter an exact passage or a note.');return false;}
  mutate(c=>{
    let s=c.suggestions.find(s=>s.id===editingSuggestion);
    if(!s){s={id:id(),status:'pending',createdAt:Date.now()};c.suggestions.push(s);}
    s.original=original;
    s.replacement=original&&replacement.length?replacement:null; // blank field is a note, not a destructive deletion
    s.note=note;
    s.type=$('note-category').value;s.priority=$('note-priority').value;
    s.position=original && c.text.indexOf(original)>=0?c.text.indexOf(original):-1;
    s.occurrence=null;
  });
  return true;
}
function parseReview(json){
  const data=JSON.parse(json.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''));
  const arr=Array.isArray(data)?data:(data.suggestions||data.edits||data.notes);
  if(!Array.isArray(arr))throw Error('Expected an array named "suggestions" (or "edits") in your JSON.');
  if(arr.length>500)throw Error('Maximum 500 suggestions per import.');
  const c=current();let unmatched=0,seen=new Set(),items=[];
  for(const raw of arr){if(!raw||typeof raw!=='object')continue;
    const original=cleanText(raw.original??raw.find??raw.quote??raw.anchor??'');
    let replacement=raw.replacement??raw.suggested??raw.suggestion;
    replacement=replacement===undefined||replacement===null?null:cleanText(replacement);
    const note=String(raw.note??raw.reason??raw.explanation??raw.description??'').trim();
    if(!original&&!note)continue;
    let priority=String(raw.priority??raw.severity??'possible').toLowerCase();priority=priority.includes('clear')?'clear':priority.includes('later')?'later':'possible';
    const type=String(raw.type??raw.category??'other').slice(0,50);
    const occurrence=Number.isInteger(raw.occurrence)?raw.occurrence:null;
    const key=JSON.stringify([original,replacement,note]);if(seen.has(key))continue;seen.add(key);
    let positions=[],p=-1,start=0;
    if(original){while((p=c.text.indexOf(original,start))!==-1){positions.push(p);start=p+Math.max(original.length,1);if(positions.length>101)break;}if(!positions.length||positions.length>1 && occurrence===null)unmatched++;}
    items.push({id:id(),original,replacement,note,type,priority,status:'pending',position:positions.length===1?positions[0]:(occurrence!==null?positions[occurrence]??-1:-1),occurrence,createdAt:Date.now()});
  }
  return {items,unmatched,chapterTitle:typeof data.chapter_title==='string'?data.chapter_title:null};
}
function importReview(text){
  const parsed=parseReview(text);
  if(parsed.chapterTitle && parsed.chapterTitle.trim().toLowerCase()!==current().title.trim().toLowerCase()){
    if(!confirm(`This review says “${parsed.chapterTitle}”, but your open chapter is “${current().title}”. Import into this chapter anyway?`))
      throw Error('Import cancelled: open the matching chapter, then import again.');
  }
  if(!parsed.items.length)throw Error('No valid suggestions or notes found.');
  mutate(c=>{const existing=new Set(c.suggestions.map(s=>JSON.stringify([s.original,s.replacement,s.note])));for(const s of parsed.items){const k=JSON.stringify([s.original,s.replacement,s.note]);if(!existing.has(k)){c.suggestions.push(s);existing.add(k);}}});
  return parsed;
}
function downloadBackup(){download('Quartermaster_Daily_Pass_Backup_'+new Date().toISOString().slice(0,10)+'.json',JSON.stringify({app:'quartermaster-daily-pass',exportedAt:new Date().toISOString(),state},null,2),'application/json');}
const reviewPrompt = c => `THE QUARTERMASTER — DAILY PASS: CONSERVATIVE FIRST-DRAFT REVIEW

You are reviewing a first-draft novel chapter for a personal review app. This request is self-contained; do not rely on earlier chats. Act as a restrained copyeditor and diagnostic reader, not a co-writer. Return review suggestions ONLY, not a rewritten chapter.

PRINCIPLE: Correct what is clearly wrong. Flag what might be wrong. Preserve everything else. A different sentence is not an improvement simply because it sounds smoother.

PROTECT THE AUTHOR'S VOICE:
- Use British English. Retain first-person POV and Toby's deliberately unusual comic voice.
- Do NOT standardise intentional fragments, digressions, comic constructions, or deliberate repetitions for rhythm.
- Do NOT automatically remove recurring commercial vocabulary: value, worth, profit, trade, margins, resources, scarcity. This is how Toby thinks.
- Preserve excessive politeness, self-justifications, strange observations, jokes and character dialogue.
- Do not tighten, shorten, modernise, or rewrite prose merely for elegance. Do not add scenes, dialogue, backstory, canon, solutions, or structural changes. When uncertain, FLAG rather than fix.

THREE PRIORITIES (use these exact JSON values):
- "clear" = MECHANICAL: objectively wrong spelling, grammar, punctuation, spacing, apostrophes, or formatting. Suggest the smallest possible replacement.
- "possible" = CONSIDER: ambiguous wording, *possibly* accidental repetition, or a local clarity issue. Explain the concern briefly; a replacement is optional. Never treat style preferences as errors.
- "later" = LATER: continuity, character, pacing, structure or larger stylistic observations. Flag genuine issues without imposing an arbitrary maximum; avoid repetition, speculation, or a barrage of minor opinions. DO NOT solve or rewrite.
- No quotas. If there is nothing material to flag, return an empty suggestions array.

KNOWN CONSISTENCY POINT: The senior female officer introduced in Chapter 1 is now a COLONEL, not a General. Watch for inconsistent rank references and accidents of global replacement (e.g. "in colonel"). If uncertain, use "possible" or "later"; do not silently rewrite canon.

STRICT OUTPUT: Return exactly ONE valid JSON object, with no Markdown, code fences, prefatory text or concluding explanation:
{"chapter_title":"${c.title}","suggestions":[{"original":"EXACT verbatim passage from manuscript (or empty string for a chapter-wide note)","replacement":"minimally changed version of same passage, or null for note-only","type":"punctuation|grammar|spelling|spacing|clarity|continuity|structure|other","priority":"clear|possible|later","note":"brief specific reason"}]}

MATCHING AND SAFETY:
- Each suggested replacement MUST quote its "original" passage *exactly* as it appears in the manuscript. Preserve whitespace, curly quotes, spelling and case in that original anchor. Prefer the shortest UNIQUE identifying span; enlarge it if repeated. Never invent or paraphrase an anchor.
- For a passage-specific observation without a definite correction, set "replacement" equal to the EXACT "original" passage. For chapter-wide observations without a passage, set "replacement":null. Use "original":"" only for chapter-wide observations with no single meaningful anchor.
- Change only the quoted passage, never adjacent text. Do not combine multiple unrelated edits in one replacement.
- Do not assume that this review is being applied to the newest Scrivener version: suggestions must match the exact provided manuscript. The author will decide what to accept.
- Escape quotation marks, backslashes and line breaks correctly for JSON. Match "chapter_title" exactly.

CHAPTER TITLE: ${c.title}
=== BEGIN MANUSCRIPT ===
${c.text}
=== END MANUSCRIPT ===`;

// ---- Cloud sync: private per-user Supabase row with optimistic revision checks. ----
function paintSync(){
  const pill=$('sync-pill');pill.className='pill';
  if(!sb){pill.textContent='Local only';return;}
  if(!user){pill.textContent='Sign in for sync';return;}
  if(conflictBusy){pill.textContent='Sync conflict';pill.classList.add('problem');return;}
  if(dirty||syncing){pill.textContent=syncing?'Syncing…':'Pending sync';pill.classList.add('problem');return;}
  pill.textContent='Cloud synced';pill.classList.add('online');
}
function scheduleSync(){if(!user||conflictBusy)return;clearTimeout(syncTimer);syncTimer=setTimeout(()=>syncToCloud(),1100);}
function setCloudMessage(text){$('cloud-message').textContent=text;}
async function initSupabase(){
  if(!cloudCfg.url||!cloudCfg.key){paintSync();return;}
  if(!window.supabase?.createClient){setCloudMessage('Supabase library unavailable (check internet or content blockers).');paintSync();return;}
  try{
    sb=window.supabase.createClient(cloudCfg.url,cloudCfg.key,{auth:{autoRefreshToken:true,persistSession:true,detectSessionInUrl:true}});
    sb.auth.onAuthStateChange((event,session)=>{
      // Defer database work outside the auth callback to avoid callback deadlocks.
      setTimeout(()=>handleAuth(session?.user||null),0);
    });
    const {data,error}=await sb.auth.getSession();if(error)throw error;
    await handleAuth(data.session?.user||null);
  }catch(e){sb=null;setCloudMessage('Could not connect: '+e.message);}
  paintSync();
}
async function handleAuth(nextUser){
  const was=user?.id||null,now=nextUser?.id||null;
  user=nextUser;$('auth-logged-out').hidden=!!user;$('auth-logged-in').hidden=!user;
  $('cloud-user').textContent=user?'Signed in as '+user.email:'';
  if(!user){paintSync();return;}
  if(was===now&&cloudUserId===now)return;
  if(cloudUserId && cloudUserId!==now){cloudRev=null;dirty=state.chapters.length>0;}
  cloudUserId=now;persistSyncMeta();paintSync();
  try{await pullFromCloud(true);}catch(e){setCloudMessage('Cloud loading failed: '+e.message);paintSync();}
}
async function fetchCloud(){const {data,error}=await sb.from('editor_workspace').select('document,revision,updated_at').eq('user_id',user.id).maybeSingle();if(error)throw error;return data;}
async function pullFromCloud(initial=false){
  if(!user||syncing||conflictBusy)return;
  const row=await fetchCloud();
  if(!row){cloudRev=null;if(state.chapters.length){dirty=true;persistSyncMeta();await syncToCloud();}else{dirty=false;persistSyncMeta();paintSync();}return;}
  if(cloudRev===row.revision && !initial)return;
  if(dirty && state.chapters.length && (cloudRev!==row.revision||initial)){
    conflictBusy=true;paintSync();setCloudMessage('Local and cloud versions both contain work. Choose a version; no changes were overwritten.');if(!$('conflict-dialog').open)$('conflict-dialog').showModal();return;
  }
  if(!row.document || !Array.isArray(row.document.chapters))throw Error('Unexpected cloud document format.');
  state=row.document;state.theme=state.theme==='light'?'light':'dark';
  cloudRev=row.revision;dirty=false;undoStack=[];
  persistSyncMeta();writeLocal(false);render();paintSync();setCloudMessage('Cloud version loaded.');
}
async function syncToCloud(){
  if(!user||!sb||syncing||conflictBusy||!dirty)return;
  syncing=true;paintSync();
  const snapshot=clone(state),saved=JSON.stringify(snapshot),fromRev=cloudRev;
  try{
    if(fromRev===null){
      const {data,error}=await sb.from('editor_workspace').insert({user_id:user.id,document:snapshot,revision:1}).select('revision').single();
      if(error){if(error.code==='23505'){syncing=false;await pullFromCloud(true);return;}throw error;}
      cloudRev=data.revision;
    }else{
      const {data,error}=await sb.from('editor_workspace').update({document:snapshot,revision:fromRev+1,updated_at:new Date().toISOString()}).eq('user_id',user.id).eq('revision',fromRev).select('revision').maybeSingle();
      if(error)throw error;
      if(!data){syncing=false;conflictBusy=true;paintSync();setCloudMessage('Sync conflict: another device changed the chapter.');$('conflict-dialog').showModal();return;}
      cloudRev=data.revision;
    }
    dirty=JSON.stringify(state)!==saved;
    persistSyncMeta();notify(dirty?'Saved locally · more changes pending':'Saved locally and in cloud');setCloudMessage('Last cloud save: '+new Date().toLocaleTimeString());
  }catch(e){dirty=true;persistSyncMeta();notify('Saved locally · cloud error');setCloudMessage('Sync failed: '+e.message);}
  finally{syncing=false;paintSync();if(dirty&&!conflictBusy)scheduleSync();}
}
async function chooseConflict(which){
  if(!sb||!user)return;
  try{
    const row=await fetchCloud();
    if(which==='cloud'){
      if(!row)throw Error('Cloud copy is missing.');
      state=row.document;cloudRev=row.revision;dirty=false;undoStack=[];persistSyncMeta();writeLocal(false);render();
    }else{
      if(row){const {data,error}=await sb.from('editor_workspace').update({document:state,revision:row.revision+1,updated_at:new Date().toISOString()}).eq('user_id',user.id).eq('revision',row.revision).select('revision').maybeSingle();if(error)throw error;if(!data)throw Error('Cloud changed again — retry after making a backup.');cloudRev=data.revision;}
      else{const {data,error}=await sb.from('editor_workspace').insert({user_id:user.id,document:state,revision:1}).select('revision').single();if(error)throw error;cloudRev=data.revision;}
      dirty=false;persistSyncMeta();
    }
    conflictBusy=false;$('conflict-dialog').close();paintSync();setCloudMessage('Version chosen and synchronised.');
  }catch(e){setCloudMessage('Could not resolve conflict: '+e.message);alert(e.message);}
}

// ---- Bind UI ----
$('new-chapter').onclick=$('empty-new').onclick=()=>{const dialog=$('chapter-dialog');$('chapter-name').value=`Chapter ${state.chapters.length+1}`;$('chapter-initial-text').value='';dialog.showModal();};
$('chapter-form').addEventListener('submit',e=>{e.preventDefault();if(e.submitter?.value==='cancel'){$('chapter-dialog').close();return;}addChapter($('chapter-name').value,$('chapter-initial-text').value);$('chapter-dialog').close();});
$('import-chapter').onclick=$('empty-import').onclick=()=>$('chapter-file').click();
$('chapter-file').onchange=async e=>{const file=e.target.files[0];if(!file)return;try{const text=cleanText(await file.text());addChapter(file.name.replace(/\.(txt|md)$/i,''),text);}catch(err){alert('Import failed: '+err.message);}e.target.value='';};
$('home-btn').onclick=()=>{closeEditor();homeVisible=true;render();};
$('home-open').onclick=()=>{homeVisible=false;render();};
$('home-import').onclick=()=> $('import-chapter').click();
$('home-new').onclick=()=> $('new-chapter').click();
$('chapter-list').addEventListener('click',e=>{const tab=e.target.closest('[data-chapter]');if(tab)switchChapter(tab.dataset.chapter);});
$('rename-btn').onclick=()=>{const c=current();if(!c)return;const value=prompt('Rename chapter',c.title);if(value&&value.trim())mutate(ch=>ch.title=value.trim());};
$('delete-chapter').onclick=()=>{const c=current();if(!c||!confirm(`Delete ${c.title}? This removes its working and original copies from the app. Download a backup first if you want to keep them.`))return;remember();state.chapters=state.chapters.filter(ch=>ch.id!==c.id);state.activeId=state.chapters[0]?.id||null;showingOriginal=false;touch();};
$('view-original').onclick=()=>{showingOriginal=!showingOriginal;render();};
$('export-txt').onclick=()=>{const c=current();if(c)download(filename(c.title)+'_Clean.txt',c.text);};
$('backup-btn').onclick=downloadBackup;
$('restore-btn').onclick=()=>$('backup-file').click();
$('backup-file').onchange=async e=>{try{const data=JSON.parse(await e.target.files[0].text());const incoming=data.state||data;if(!Array.isArray(incoming.chapters))throw Error('Not a valid Daily Pass backup');if(!confirm('Restore this backup? This replaces all chapters in the app. Download your current backup first.'))return;remember();state=incoming;state.version=1;touch();}catch(err){alert('Restore failed: '+err.message);}e.target.value='';};
$('theme-btn').onclick=()=>{state.theme=state.theme==='dark'?'light':'dark';writeLocal(true);render();};
function manuscriptOffsetFromSelection(){
  const view=$('manuscript-view'),selection=window.getSelection();
  if(!selection||!selection.rangeCount||!view.contains(selection.anchorNode))return null;
  const r=selection.getRangeAt(0).cloneRange();r.selectNodeContents(view);r.setEnd(selection.anchorNode,selection.anchorOffset);
  return r.toString().length;
}
let lastManuscriptOffset=null;
$('manuscript-view').addEventListener('pointerup',()=>{const offset=manuscriptOffsetFromSelection();if(offset!==null)lastManuscriptOffset=offset;});
$('edit-text').onclick=()=>{if(showingOriginal)return;
  const view=$('manuscript-view'),offset=lastManuscriptOffset;
  view.hidden=true;$('text-editor').hidden=false;$('working-text').value=current().text;$('edit-text').disabled=true;
  const textarea=$('working-text');textarea.focus();const at=Math.max(0,Math.min(offset??0,textarea.value.length));textarea.setSelectionRange(at,at);
  const lines=textarea.value.slice(0,at).split('\n').length;textarea.scrollTop=Math.max(0,(lines-4)*27);
};
function closeEditor(){$('text-editor').hidden=true;$('manuscript-view').hidden=false;$('edit-text').disabled=false;}
$('cancel-text').onclick=closeEditor;
$('save-text').onclick=()=>{const next=cleanText($('working-text').value);if(next!==current().text)mutate(c=>{c.text=next;for(const s of c.suggestions)if(s.status==='pending')s.position=-1;});closeEditor();};
$('review-filter').onchange=()=>renderReviews(current());
$('review-items').addEventListener('click',e=>{const btn=e.target.closest('button[data-action]');if(btn)actOnSuggestion(btn.dataset.id,btn.dataset.action);else {const card=e.target.closest('[data-card]');if(card)selectSuggestion(card.dataset.card);}});
$('manuscript-view').addEventListener('click',e=>{const m=e.target.closest('mark[data-sid]');if(m)selectSuggestion(m.dataset.sid);});
$('add-note').onclick=()=>openNote(null,'');
$('add-selection-note').onclick=()=>{const sel=window.getSelection(),text=sel?sel.toString():'';openNote(null,text);};
$('note-form').onsubmit=e=>{e.preventDefault();if(e.submitter?.value==='cancel'){$('note-dialog').close();return;}if(saveNote())$('note-dialog').close();};
$('undo-btn').onclick=()=>{if(!undoStack.length)return;const old=undoStack.pop();state=old;touch();};
$('import-review').onclick=()=>{$('review-json').value='';$('review-import-result').textContent='';$('review-dialog').showModal();};
$('review-cancel').onclick=()=>$('review-dialog').close();
$('review-file-btn').onclick=()=>$('review-file').click();
$('review-file').onchange=async e=>{const file=e.target.files[0];if(file)$('review-json').value=await file.text();e.target.value='';};
$('review-confirm').onclick=()=>{try{const r=importReview($('review-json').value);$('review-dialog').close();if(r.unmatched)alert(`${r.items.length} suggestions imported. ${r.unmatched} passage(s) are missing or ambiguous; these require manual attention.`);}catch(e){$('review-import-result').textContent=e.message;}};
$('copy-chapter').onclick=async()=>{try{await navigator.clipboard.writeText(current().text);notify('Full working chapter copied');}catch(e){alert('Could not copy text: '+e.message);}};
$('copy-prompt').onclick=async()=>{try{await navigator.clipboard.writeText(reviewPrompt(current()));notify('Review instructions and chapter copied to clipboard');}catch(e){alert('Clipboard unavailable. Open this app on HTTPS (GitHub Pages) to use this feature.');}};
$('cloud-btn').onclick=()=>{ $('cloud-url').value=cloudCfg.url||'';$('cloud-key').value=cloudCfg.key||'';$('cloud-dialog').showModal();};
$('cloud-close').onclick=()=>$('cloud-dialog').close();
$('cloud-connect').onclick=async()=>{const url=$('cloud-url').value.trim(),key=$('cloud-key').value.trim();if(!/^https:\/\/[a-z0-9.-]+\.supabase\.co\/?$/i.test(url)||!key){setCloudMessage('Enter a valid Supabase project URL and a publishable/anon key.');return;}cloudCfg={url:url.replace(/\/$/,''),key};localStorage.setItem(CLOUD_STORE,JSON.stringify(cloudCfg));sb=null;user=null;cloudUserId=null;cloudRev=null;dirty=state.chapters.length>0;persistSyncMeta();setCloudMessage('Configuration saved. Connect and sign in.');await initSupabase();};
$('cloud-signin').onclick=async()=>{const email=$('cloud-email').value.trim();if(!sb){setCloudMessage('Save a valid Supabase configuration first.');return;}if(!email){setCloudMessage('Enter your email address.');return;}try{const redirectTo=location.origin+location.pathname;const {error}=await sb.auth.signInWithOtp({email,options:{emailRedirectTo:redirectTo}});if(error)throw error;$('otp-entry').hidden=false;setCloudMessage('Check your email for the six-digit code and enter it here.');}catch(e){setCloudMessage('Sign-in failed: '+e.message);}};
$('cloud-verify').onclick=async()=>{const email=$('cloud-email').value.trim(),token=$('cloud-otp').value.trim();if(!sb||!email||!/^[0-9]{6}$/.test(token)){setCloudMessage('Enter your email and six-digit code.');return;}try{const {error}=await sb.auth.verifyOtp({email,token,type:'email'});if(error)throw error;$('otp-entry').hidden=true;setCloudMessage('Signed in successfully.');}catch(e){setCloudMessage('Code verification failed: '+e.message);}};
$('cloud-signout').onclick=async()=>{if(sb)await sb.auth.signOut();user=null;paintSync();};
$('cloud-sync-now').onclick=async()=>{if(dirty)await syncToCloud();else await pullFromCloud();};
$('conflict-backup').onclick=downloadBackup;
$('conflict-cloud').onclick=()=>chooseConflict('cloud');
$('conflict-local').onclick=()=>chooseConflict('local');
window.addEventListener('online',()=>{if(dirty)scheduleSync();else pullFromCloud().catch(()=>{});});
window.addEventListener('focus',()=>{if(user&&!dirty)pullFromCloud().catch(()=>{});});
setInterval(()=>{if(user&&!dirty&&!syncing&&!conflictBusy&&document.visibilityState==='visible')pullFromCloud().catch(()=>{});},25000);

// Initial rendering; never embed manuscript text in shipped HTML or repository.
render();paintSync();initSupabase();
