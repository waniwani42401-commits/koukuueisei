'use strict';

const APP_VERSION = '3.0.0';
const STORAGE_KEY = 'oralHygieneStudyApp_v3';
const LEGACY_KEYS = ['oralHygieneStudyApp_v2','oralHygieneStudyApp_v1','oralHygieneApp_v2','oralHygieneApp_v1'];
const DB_NAME = 'oralHygieneEditorDB_v3';
const DB_VERSION = 1;
const BASE_QUESTIONS = Array.isArray(window.BASE_QUESTIONS) ? window.BASE_QUESTIONS : [];
const $ = id => document.getElementById(id);

let db;
let records = [];
let allQuestions = [];
let activeQuestions = [];
let filtered = [];
let cursor = 0;
let answerVisible = false;
let figureVisible = false;
let imageUrlCache = new Map();
let editorFigures = [];
let editorOriginalUid = '';
let deferredInstallPrompt = null;
let searchTimer;
let manageTimer;
let toastTimer;

function uidForBase(id){ return `base:${id}`; }
function newUid(){
  if (crypto && typeof crypto.randomUUID === 'function') return `custom:${crypto.randomUUID()}`;
  return `custom:${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
function nowIso(){ return new Date().toISOString(); }
function safeParse(text){ try{return JSON.parse(text);}catch(_e){return null;} }
function escapeText(value){ return String(value ?? ''); }
function normalizeTags(value){
  if (Array.isArray(value)) return [...new Set(value.map(v=>String(v).trim()).filter(Boolean))];
  return [...new Set(String(value||'').split(/[、,\n]/).map(v=>v.trim()).filter(Boolean))];
}
function normalizeFigure(f){
  if (!f || typeof f !== 'object') return null;
  if (f.kind === 'idb' && f.imageId) return {kind:'idb',imageId:String(f.imageId),caption:String(f.caption||'添付画像')};
  if (f.kind === 'pending' && f.blob) return f;
  if (f.src) return {kind:'static',src:String(f.src),caption:String(f.caption||'図・表')};
  return null;
}
function cloneFigure(f){ return {...f}; }
function cloneQuestion(q){
  return {...q, tags:[...(q.tags||[])], figures:(q.figures||[]).map(cloneFigure)};
}

function openDatabase(){
  return new Promise((resolve,reject)=>{
    const req=indexedDB.open(DB_NAME,DB_VERSION);
    req.onupgradeneeded=()=>{
      const database=req.result;
      if(!database.objectStoreNames.contains('questionRecords')) database.createObjectStore('questionRecords',{keyPath:'uid'});
      if(!database.objectStoreNames.contains('images')) database.createObjectStore('images',{keyPath:'id'});
    };
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error || new Error('IndexedDBを開けませんでした'));
  });
}
function txRequest(storeName,mode,action){
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(storeName,mode);
    const store=tx.objectStore(storeName);
    let req;
    try{ req=action(store); }catch(e){ reject(e); return; }
    tx.oncomplete=()=>resolve(req && 'result' in req ? req.result : undefined);
    tx.onerror=()=>reject(tx.error || (req && req.error) || new Error('データベース操作に失敗しました'));
    tx.onabort=()=>reject(tx.error || new Error('データベース操作が中断されました'));
  });
}
const getAllRecords=()=>txRequest('questionRecords','readonly',s=>s.getAll());
const putRecord=record=>txRequest('questionRecords','readwrite',s=>s.put(record));
const deleteRecord=uid=>txRequest('questionRecords','readwrite',s=>s.delete(uid));
const clearRecords=()=>txRequest('questionRecords','readwrite',s=>s.clear());
const putImage=record=>txRequest('images','readwrite',s=>s.put(record));
const getImage=id=>txRequest('images','readonly',s=>s.get(id));
const getAllImages=()=>txRequest('images','readonly',s=>s.getAll());
const deleteImage=id=>txRequest('images','readwrite',s=>s.delete(id));
const clearImages=()=>txRequest('images','readwrite',s=>s.clear());

function defaultState(){
  return {unknownIds:[],reviewedIds:[],lastUid:uidForBase(1),mode:'all',category:'all',sourceFilter:'all',order:'number',search:'',shuffledUids:[],theme:'system',updatedAt:null};
}
function migrateIds(list){
  if(!Array.isArray(list)) return [];
  return [...new Set(list.map(v=>typeof v==='number'||/^\d+$/.test(String(v))?uidForBase(Number(v)):String(v)).filter(Boolean))];
}
function loadState(){
  let raw=null;
  try{raw=localStorage.getItem(STORAGE_KEY);}catch(_e){}
  if(!raw){
    for(const key of LEGACY_KEYS){
      try{const legacy=localStorage.getItem(key);if(legacy){raw=legacy;break;}}catch(_e){}
    }
  }
  const incoming=safeParse(raw)||{};
  const out=Object.assign(defaultState(),incoming);
  out.unknownIds=migrateIds(out.unknownIds);
  out.reviewedIds=migrateIds(out.reviewedIds);
  out.shuffledUids=migrateIds(out.shuffledUids || out.shuffledIds);
  if(!out.lastUid && out.lastQuestionId) out.lastUid=uidForBase(out.lastQuestionId);
  out.lastUid=String(out.lastUid||uidForBase(1));
  out.mode=['all','unlearned','unknown','known'].includes(out.mode)?out.mode:'all';
  out.sourceFilter=['all','base','custom','edited'].includes(out.sourceFilter)?out.sourceFilter:'all';
  out.order=['number','shuffle'].includes(out.order)?out.order:'number';
  out.theme=['system','light','dark'].includes(out.theme)?out.theme:'system';
  out.category=String(out.category||'all');
  out.search=String(out.search||'');
  return out;
}
const state=loadState();
function saveState(message=''){
  state.updatedAt=nowIso();
  let ok=true;
  try{localStorage.setItem(STORAGE_KEY,JSON.stringify(state));}catch(_e){ok=false;}
  updateStorageNotice(ok);
  updateStats();
  if(message) toast(message);
}
function updateStorageNotice(ok=true){
  const notice=$('storageNotice');
  const pill=$('savedAt');
  if(ok){
    pill.textContent=state.updatedAt?`自動保存 ${new Date(state.updatedAt).toLocaleString('ja-JP',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})}`:'自動保存ON';
    pill.classList.remove('warn');
    notice.hidden=true;
  }else{
    pill.textContent='保存できません';pill.classList.add('warn');
    notice.textContent='この表示環境では端末保存が制限されています。SafariでGitHub Pagesの公開URLを開いてください。';
    notice.hidden=false;
  }
}
function setFromState(name){ return new Set((state[name]||[]).map(String)); }
function saveSet(name,set){ state[name]=[...set]; }

function buildQuestions(){
  const recordMap=new Map(records.map(r=>[r.uid,r]));
  const result=[];
  for(const base of BASE_QUESTIONS){
    const uid=uidForBase(base.id);
    const override=recordMap.get(uid);
    const normalizedBase={
      ...base,uid,source:'base',baseId:base.id,customNumber:null,edited:false,deleted:false,tags:normalizeTags(base.tags||[]),
      figures:(base.figures||[]).map(normalizeFigure).filter(Boolean)
    };
    if(override){
      result.push({
        ...normalizedBase,
        category:String(override.category??normalizedBase.category),
        question:String(override.question??normalizedBase.question),
        answer:String(override.answer??normalizedBase.answer),
        note:String(override.note??normalizedBase.note??''),
        tags:normalizeTags(override.tags||[]),
        figures:Array.isArray(override.figures)?override.figures.map(normalizeFigure).filter(Boolean):normalizedBase.figures,
        edited:true,deleted:Boolean(override.deleted),updatedAt:override.updatedAt
      });
    }else result.push(normalizedBase);
  }
  for(const r of records.filter(r=>r.source==='custom')){
    result.push({
      uid:r.uid,source:'custom',baseId:null,customNumber:Number(r.customNumber)||999999,sectionNumber:Number(r.sectionNumber)||999,
      category:String(r.category||'自作問題'),question:String(r.question||''),answer:String(r.answer||''),note:String(r.note||''),
      tags:normalizeTags(r.tags||[]),figures:(r.figures||[]).map(normalizeFigure).filter(Boolean),edited:true,deleted:Boolean(r.deleted),createdAt:r.createdAt,updatedAt:r.updatedAt
    });
  }
  result.sort((a,b)=>{
    if(a.source==='base'&&b.source==='base') return a.baseId-b.baseId;
    if(a.source==='base') return -1;
    if(b.source==='base') return 1;
    return (a.customNumber||0)-(b.customNumber||0);
  });
  allQuestions=result;
  activeQuestions=result.filter(q=>!q.deleted);
  sanitizeStateAgainstQuestions();
  rebuildCategoryControls();
}
function sanitizeStateAgainstQuestions(){
  const valid=new Set(activeQuestions.map(q=>q.uid));
  state.unknownIds=migrateIds(state.unknownIds).filter(id=>valid.has(id));
  state.reviewedIds=migrateIds(state.reviewedIds).filter(id=>valid.has(id));
  state.shuffledUids=migrateIds(state.shuffledUids).filter(id=>valid.has(id));
  if(!valid.has(state.lastUid)) state.lastUid=activeQuestions[0]?.uid||'';
}
function categories(){ return [...new Set(activeQuestions.map(q=>q.category).filter(Boolean))]; }
function rebuildCategoryControls(){
  const names=categories();
  const select=$('category');
  const current=state.category;
  select.innerHTML='<option value="all">すべての単元</option>';
  const data=$('categoryList');data.innerHTML='';
  for(const name of names){
    const op=document.createElement('option');op.value=name;op.textContent=name;select.appendChild(op);
    const dop=document.createElement('option');dop.value=name;data.appendChild(dop);
  }
  if(current==='all'||names.includes(current)) select.value=current;
  else{state.category='all';select.value='all';}
}
function currentQuestion(){ return filtered[cursor]||null; }
function displayNumber(q){ return q.source==='base'?`問${q.baseId}`:`自作${q.customNumber}`; }
function searchBlob(q){ return [q.question,q.answer,q.category,q.note,(q.tags||[]).join(' ')].join(' ').toLocaleLowerCase('ja-JP'); }
function shuffleArray(arr){
  const out=[...arr];
  for(let i=out.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[out[i],out[j]]=[out[j],out[i]];}
  return out;
}
function refreshFiltered(keepUid=true){
  const before=currentQuestion();
  const preferred=keepUid&&before?before.uid:state.lastUid;
  const unknown=setFromState('unknownIds');
  const reviewed=setFromState('reviewedIds');
  const term=state.search.trim().toLocaleLowerCase('ja-JP');
  filtered=activeQuestions.filter(q=>{
    if(state.mode==='unlearned'&&reviewed.has(q.uid)) return false;
    if(state.mode==='unknown'&&!unknown.has(q.uid)) return false;
    if(state.mode==='known'&&(!reviewed.has(q.uid)||unknown.has(q.uid))) return false;
    if(state.category!=='all'&&q.category!==state.category) return false;
    if(state.sourceFilter==='base'&&q.source!=='base') return false;
    if(state.sourceFilter==='custom'&&q.source!=='custom') return false;
    if(state.sourceFilter==='edited'&&!(q.source==='base'&&q.edited)) return false;
    if(term&&!searchBlob(q).includes(term)) return false;
    return true;
  });
  if(state.order==='shuffle'){
    const filteredSet=new Set(filtered.map(q=>q.uid));
    let order=state.shuffledUids.filter(uid=>filteredSet.has(uid));
    const missing=filtered.map(q=>q.uid).filter(uid=>!order.includes(uid));
    if(!order.length||missing.length) order=[...order,...shuffleArray(missing)];
    state.shuffledUids=order;
    const map=new Map(filtered.map(q=>[q.uid,q]));
    filtered=order.map(uid=>map.get(uid)).filter(Boolean);
  }else{
    filtered.sort((a,b)=>a.source===b.source?(a.source==='base'?a.baseId-b.baseId:a.customNumber-b.customNumber):(a.source==='base'?-1:1));
  }
  const idx=filtered.findIndex(q=>q.uid===preferred);
  cursor=idx>=0?idx:Math.min(cursor,Math.max(0,filtered.length-1));
  answerVisible=false;figureVisible=false;
  render();saveState('');
}

function render(){
  const q=currentQuestion();
  $('studyCard').hidden=!q;
  $('emptyCard').hidden=Boolean(q);
  $('prevButton').disabled=!q||filtered.length<2;
  $('nextButton').disabled=!q||filtered.length<2;
  if(!q){$('position').textContent='0 / 0';updateStats();return;}
  state.lastUid=q.uid;
  $('questionNumber').textContent=`${displayNumber(q)} ・ ${cursor+1} / ${filtered.length}`;
  $('questionText').textContent=q.question;
  $('answerText').textContent=q.answer;
  const note=String(q.note||'').trim();
  $('questionNote').textContent=note;
  $('questionNote').hidden=!answerVisible||!note;
  $('revealWrap').hidden=answerVisible;
  $('answerArea').hidden=!answerVisible;
  renderBadges(q);
  renderFigures(q);
  $('position').textContent=`${cursor+1} / ${filtered.length}`;
  updateStats();
}
function renderBadges(q){
  const box=$('badges');box.innerHTML='';
  const items=[{text:q.category,cls:''}];
  if(q.source==='custom') items.push({text:'自作',cls:'custom'});
  else if(q.edited) items.push({text:'編集済み',cls:'edited'});
  for(const tag of q.tags||[]) items.push({text:`#${tag}`,cls:''});
  for(const item of items){const span=document.createElement('span');span.className=`badge ${item.cls}`.trim();span.textContent=item.text;box.appendChild(span);}
}
function clearImageUrls(){
  for(const url of imageUrlCache.values()) URL.revokeObjectURL(url);
  imageUrlCache.clear();
}
async function urlForFigure(fig){
  if(fig.kind==='static') return fig.src;
  if(fig.kind==='pending') return fig.tempUrl;
  if(fig.kind==='idb'){
    if(imageUrlCache.has(fig.imageId)) return imageUrlCache.get(fig.imageId);
    const rec=await getImage(fig.imageId);
    if(!rec||!rec.blob) throw new Error(`画像 ${fig.imageId} が見つかりません`);
    const url=URL.createObjectURL(rec.blob);imageUrlCache.set(fig.imageId,url);return url;
  }
  throw new Error('画像形式が不明です');
}
function renderFigures(q){
  const figs=q.figures||[];
  const toggle=$('toggleFigures');
  const panel=$('figurePanel');
  toggle.hidden=figs.length===0;
  toggle.textContent=figureVisible?`図・表を隠す`:`図・表を表示（${figs.length}）`;
  panel.hidden=!figureVisible||figs.length===0;
  if(!figureVisible||!figs.length){$('figureList').innerHTML='';return;}
  const token=q.uid+'-'+Date.now();panel.dataset.token=token;
  const list=$('figureList');list.innerHTML='';
  figs.forEach(async(fig,index)=>{
    const wrap=document.createElement('figure');wrap.className='figure-item';
    const loading=document.createElement('div');loading.textContent='画像を読み込み中…';loading.className='image-error';wrap.appendChild(loading);list.appendChild(wrap);
    try{
      const src=await urlForFigure(fig);
      if(panel.dataset.token!==token) return;
      const img=document.createElement('img');img.alt=fig.caption||`図表${index+1}`;img.loading='eager';img.src=src;
      img.addEventListener('click',()=>openImage(src,fig.caption||''));
      img.addEventListener('error',()=>{wrap.innerHTML=`<div class="image-error">画像を表示できません：${escapeText(src)}</div>`;});
      const cap=document.createElement('figcaption');cap.textContent=fig.caption||`図表${index+1}`;
      wrap.innerHTML='';wrap.append(img,cap);
    }catch(e){wrap.innerHTML='';const err=document.createElement('div');err.className='image-error';err.textContent=e.message;wrap.appendChild(err);}
  });
}
function revealAnswer(){answerVisible=true;render();}
function move(step){
  if(!filtered.length)return;
  cursor=(cursor+step+filtered.length)%filtered.length;
  answerVisible=false;figureVisible=false;render();saveState('');window.scrollTo({top:0,behavior:'smooth'});
}
function markUnknown(isUnknown){
  const q=currentQuestion();if(!q)return;
  const unknown=setFromState('unknownIds'),reviewed=setFromState('reviewedIds');
  reviewed.add(q.uid);if(isUnknown)unknown.add(q.uid);else unknown.delete(q.uid);
  saveSet('unknownIds',unknown);saveSet('reviewedIds',reviewed);
  saveState(isUnknown?'復習対象に保存しました':'「わかった」に更新しました');
  if((state.mode==='unknown'&&!isUnknown)||(state.mode==='unlearned')||(state.mode==='known'&&isUnknown)) refreshFiltered(false); else move(1);
}
function updateStats(){
  const activeSet=new Set(activeQuestions.map(q=>q.uid));
  const reviewed=new Set(state.reviewedIds.filter(id=>activeSet.has(id)));
  const unknown=new Set(state.unknownIds.filter(id=>activeSet.has(id)));
  $('totalCount').textContent=activeQuestions.length;
  $('customCount').textContent=activeQuestions.filter(q=>q.source==='custom').length;
  $('reviewedCount').textContent=reviewed.size;
  $('unknownCount').textContent=unknown.size;
  $('knownCount').textContent=[...reviewed].filter(id=>!unknown.has(id)).length;
  const pct=activeQuestions.length?Math.round(reviewed.size/activeQuestions.length*100):0;
  $('progressBar').style.width=`${pct}%`;$('progressLabel').textContent=`学習済み ${pct}%`;
  $('filterCount').textContent=`${filtered.length}問を表示`;
}
function setControl(key,value){
  state[key]=value;
  if(key==='order'&&value==='shuffle') state.shuffledUids=[];
  if(key==='theme') applyTheme(value);
  saveState('設定を保存しました');refreshFiltered(false);
}
function applyTheme(value){document.documentElement.dataset.theme=value;}
function reshuffle(){state.shuffledUids=shuffleArray(filtered.map(q=>q.uid));state.order='shuffle';$('order').value='shuffle';refreshFiltered(false);toast('出題順をシャッフルしました');}
function clearSearch(){state.search='';$('search').value='';refreshFiltered(false);}
function showAll(){Object.assign(state,{mode:'all',category:'all',sourceFilter:'all',search:''});$('mode').value='all';$('category').value='all';$('sourceFilter').value='all';$('search').value='';refreshFiltered(false);}

function initControls(){
  rebuildCategoryControls();
  $('mode').value=state.mode;$('category').value=state.category;$('sourceFilter').value=state.sourceFilter;$('order').value=state.order;$('theme').value=state.theme;$('search').value=state.search;
  applyTheme(state.theme);
}

function nextCustomNumber(){
  return Math.max(0,...records.filter(r=>r.source==='custom').map(r=>Number(r.customNumber)||0))+1;
}
function recordForQuestion(q){
  return records.find(r=>r.uid===q.uid)||null;
}
function baseQuestionByUid(uid){
  const id=Number(String(uid).split(':')[1]);return BASE_QUESTIONS.find(q=>q.id===id)||null;
}
function currentEditorQuestion(){return allQuestions.find(q=>q.uid===editorOriginalUid)||null;}

function openCreateEditor(prefill=null){
  editorOriginalUid='';
  $('editingUid').value='';$('editorKind').textContent='自作問題';$('editorTitle').textContent=prefill?'問題を複製':'問題を作成';
  $('editCategory').value=prefill?.category||((state.category!=='all'&&state.category)||'');
  $('editTags').value=(prefill?.tags||[]).join(', ');
  $('editQuestion').value=prefill?.question||'';$('editAnswer').value=prefill?.answer||'';$('editNote').value=prefill?.note||'';
  editorFigures=(prefill?.figures||[]).map(cloneFigure);
  $('deleteQuestionButton').hidden=true;$('restoreQuestionButton').hidden=true;
  renderEditorFigures();$('editorDialog').showModal();
}
function openEditEditor(uid){
  const q=allQuestions.find(item=>item.uid===uid);if(!q)return;
  editorOriginalUid=uid;$('editingUid').value=uid;
  $('editorKind').textContent=q.source==='base'?'既存問題':'自作問題';$('editorTitle').textContent=`${displayNumber(q)}を編集`;
  $('editCategory').value=q.category;$('editTags').value=(q.tags||[]).join(', ');$('editQuestion').value=q.question;$('editAnswer').value=q.answer;$('editNote').value=q.note||'';
  editorFigures=(q.figures||[]).map(cloneFigure);
  $('deleteQuestionButton').hidden=q.deleted;
  $('restoreQuestionButton').hidden=!(q.source==='base'&&q.edited);
  $('restoreQuestionButton').textContent='元の問題・解答に戻す';
  renderEditorFigures();$('editorDialog').showModal();
}
function closeEditor(){
  for(const f of editorFigures){if(f.kind==='pending'&&f.tempUrl)URL.revokeObjectURL(f.tempUrl);}
  editorFigures=[];editorOriginalUid='';$('editorDialog').close();
}
async function renderEditorFigures(){
  const box=$('editorFigureList');box.innerHTML='';
  if(!editorFigures.length){const p=document.createElement('p');p.className='manage-count';p.textContent='図・写真はありません。';box.appendChild(p);return;}
  editorFigures.forEach(async(fig,index)=>{
    const card=document.createElement('div');card.className='editor-figure';card.dataset.index=String(index);
    const remove=document.createElement('button');remove.type='button';remove.className='remove-figure';remove.textContent='×';remove.title='画像を外す';remove.addEventListener('click',()=>{const [removed]=editorFigures.splice(index,1);if(removed?.kind==='pending'&&removed.tempUrl)URL.revokeObjectURL(removed.tempUrl);renderEditorFigures();});
    const img=document.createElement('img');img.alt=fig.caption||'図・写真';
    const cap=document.createElement('input');cap.type='text';cap.value=fig.caption||'';cap.placeholder='画像の説明';cap.addEventListener('input',e=>{editorFigures[index].caption=e.target.value;});
    card.append(remove,img,cap);box.appendChild(card);
    try{img.src=await urlForFigure(fig);}catch(_e){img.alt='画像を読み込めません';}
  });
}
async function compressImage(file){
  if(!file.type.startsWith('image/')) throw new Error(`${file.name}は画像ではありません`);
  const dataUrl=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(r.error);r.readAsDataURL(file);});
  const img=await new Promise((resolve,reject)=>{const im=new Image();im.onload=()=>resolve(im);im.onerror=()=>reject(new Error(`${file.name}を読み込めません`));im.src=dataUrl;});
  const max=1800;let w=img.naturalWidth,h=img.naturalHeight;const scale=Math.min(1,max/Math.max(w,h));w=Math.max(1,Math.round(w*scale));h=Math.max(1,Math.round(h*scale));
  const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,w,h);ctx.drawImage(img,0,0,w,h);
  const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',0.84));
  if(!blob) throw new Error('画像の圧縮に失敗しました');
  return blob;
}
async function addEditorImages(files){
  for(const file of [...files]){
    try{const blob=await compressImage(file);const tempUrl=URL.createObjectURL(blob);editorFigures.push({kind:'pending',blob,tempUrl,caption:file.name.replace(/\.[^.]+$/,'')});}
    catch(e){alert(e.message);}
  }
  $('editImageInput').value='';renderEditorFigures();
}
async function persistPendingFigures(figures){
  const result=[];
  for(const fig of figures){
    if(fig.kind==='pending'){
      const imageId=`img:${Date.now()}-${Math.random().toString(36).slice(2)}`;
      await putImage({id:imageId,blob:fig.blob,name:fig.caption||'添付画像',createdAt:nowIso()});
      result.push({kind:'idb',imageId,caption:fig.caption||'添付画像'});
    }else result.push(normalizeFigure(fig));
  }
  return result.filter(Boolean);
}
async function saveEditor(e){
  e.preventDefault();
  const category=$('editCategory').value.trim(),question=$('editQuestion').value.trim(),answer=$('editAnswer').value.trim();
  if(!category||!question||!answer){alert('単元・問題文・解答を入力してください。');return;}
  const savedFigures=await persistPendingFigures(editorFigures);
  const existingUid=$('editingUid').value;
  let savedUid=existingUid;
  if(existingUid){
    const q=allQuestions.find(x=>x.uid===existingUid);if(!q)return;
    const old=recordForQuestion(q);
    const record={
      uid:q.uid,source:q.source,baseId:q.baseId||null,customNumber:q.customNumber||null,sectionNumber:q.sectionNumber||null,
      category,question,answer,note:$('editNote').value.trim(),tags:normalizeTags($('editTags').value),figures:savedFigures,
      deleted:Boolean(old?.deleted),createdAt:old?.createdAt||q.createdAt||nowIso(),updatedAt:nowIso()
    };
    await putRecord(record);
  }else{
    const record={uid:newUid(),source:'custom',customNumber:nextCustomNumber(),sectionNumber:999,category,question,answer,note:$('editNote').value.trim(),tags:normalizeTags($('editTags').value),figures:savedFigures,deleted:false,createdAt:nowIso(),updatedAt:nowIso()};
    await putRecord(record);savedUid=record.uid;
  }
  await reloadRecords();closeEditor();
  Object.assign(state,{lastUid:savedUid,mode:'all',category:'all',sourceFilter:'all',order:'number',search:''});
  $('mode').value='all';$('category').value='all';$('sourceFilter').value='all';$('order').value='number';$('search').value='';
  refreshFiltered(false);renderManageList();toast(existingUid?'問題を更新しました':'問題を追加しました');
}
async function softDeleteQuestion(uid){
  const q=allQuestions.find(x=>x.uid===uid);if(!q)return;
  if(!confirm(`${displayNumber(q)}を削除しますか？\n後から「問題を管理」で復元できます。`))return;
  const old=recordForQuestion(q);
  const rec={uid:q.uid,source:q.source,baseId:q.baseId||null,customNumber:q.customNumber||null,sectionNumber:q.sectionNumber||null,category:q.category,question:q.question,answer:q.answer,note:q.note||'',tags:q.tags||[],figures:q.figures||[],deleted:true,createdAt:old?.createdAt||q.createdAt||nowIso(),updatedAt:nowIso()};
  await putRecord(rec);await reloadRecords();if($('editorDialog').open)closeEditor();refreshFiltered(false);renderManageList();toast('問題を削除しました');
}
async function restoreQuestion(uid){
  const q=allQuestions.find(x=>x.uid===uid);if(!q)return;
  if(q.source==='base'){
    if(!confirm('この問題文・解答・単元・画像への編集をすべて取り消し、最初の状態に戻しますか？'))return;
    await deleteRecord(uid);
  }else{
    const rec=recordForQuestion(q);if(!rec)return;rec.deleted=false;rec.updatedAt=nowIso();await putRecord(rec);
  }
  await reloadRecords();if($('editorDialog').open)closeEditor();refreshFiltered(false);renderManageList();toast(q.source==='base'?'元の問題に戻しました':'問題を復元しました');
}
async function duplicateQuestion(uid){
  const q=allQuestions.find(x=>x.uid===uid);if(q)openCreateEditor(q);
}
async function reloadRecords(){records=await getAllRecords();buildQuestions();await cleanupOrphanImages();}
async function cleanupOrphanImages(){
  const used=new Set();for(const r of records)for(const f of r.figures||[])if(f.kind==='idb'&&f.imageId)used.add(f.imageId);
  const images=await getAllImages();for(const img of images)if(!used.has(img.id)){await deleteImage(img.id);if(imageUrlCache.has(img.id)){URL.revokeObjectURL(imageUrlCache.get(img.id));imageUrlCache.delete(img.id);}}
}

function openManage(){renderManageList();$('manageDialog').showModal();}
function renderManageList(){
  if(!$('manageDialog').open&&document.activeElement!==$('manageQuestionsButton')){}
  const term=$('manageSearch').value.trim().toLocaleLowerCase('ja-JP');const showDeleted=$('showDeleted').checked;
  const rows=allQuestions.filter(q=>(showDeleted||!q.deleted)&&(!term||[displayNumber(q),q.question,q.answer,q.category,q.note,(q.tags||[]).join(' ')].join(' ').toLocaleLowerCase('ja-JP').includes(term)));
  $('manageCount').textContent=`${rows.length}件を表示（既存 ${rows.filter(q=>q.source==='base').length}／自作 ${rows.filter(q=>q.source==='custom').length}）`;
  const box=$('manageList');box.innerHTML='';
  for(const q of rows){
    const row=document.createElement('article');row.className=`manage-row${q.deleted?' is-deleted':''}`;
    const main=document.createElement('div');main.className='manage-main';
    const meta=document.createElement('div');meta.className='manage-meta';
    const labels=[{t:displayNumber(q),c:''},{t:q.category,c:''},{t:q.source==='custom'?'自作':q.edited?'編集済み':'既存',c:q.source==='custom'?'custom':q.edited?'edited':''}];if(q.deleted)labels.push({t:'削除済み',c:'deleted'});
    labels.forEach(x=>{const s=document.createElement('span');s.className=`badge ${x.c}`.trim();s.textContent=x.t;meta.appendChild(s);});
    const qt=document.createElement('p');qt.className='manage-question';qt.textContent=q.question;const ans=document.createElement('p');ans.className='manage-answer';ans.textContent=`答え：${q.answer}`;main.append(meta,qt,ans);
    const actions=document.createElement('div');actions.className='manage-actions';
    if(!q.deleted){
      const edit=document.createElement('button');edit.textContent='編集';edit.addEventListener('click',()=>{ $('manageDialog').close();openEditEditor(q.uid);});
      const dup=document.createElement('button');dup.textContent='複製';dup.addEventListener('click',()=>{ $('manageDialog').close();duplicateQuestion(q.uid);});
      const del=document.createElement('button');del.textContent='削除';del.addEventListener('click',()=>softDeleteQuestion(q.uid));actions.append(edit,dup,del);
      if(q.source==='base'&&q.edited){const restore=document.createElement('button');restore.textContent='初期状態';restore.addEventListener('click',()=>restoreQuestion(q.uid));actions.appendChild(restore);}
    }else{
      const restore=document.createElement('button');restore.textContent=q.source==='base'?'初期状態で復元':'復元';restore.addEventListener('click',()=>restoreQuestion(q.uid));actions.appendChild(restore);
    }
    row.append(main,actions);box.appendChild(row);
  }
}

function blobToDataUrl(blob){return new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(r.error);r.readAsDataURL(blob);});}
function dataUrlToBlob(dataUrl){
  const [head,data]=String(dataUrl).split(',');const type=(head.match(/data:([^;]+)/)||[])[1]||'application/octet-stream';const bytes=atob(data);const arr=new Uint8Array(bytes.length);for(let i=0;i<bytes.length;i++)arr[i]=bytes.charCodeAt(i);return new Blob([arr],{type});
}
async function exportBackup(){
  const images=await getAllImages();const imagePayload=[];for(const img of images)imagePayload.push({id:img.id,name:img.name,createdAt:img.createdAt,dataUrl:await blobToDataUrl(img.blob)});
  const payload={app:'口腔衛生学暗記アプリ',version:APP_VERSION,exportedAt:nowIso(),baseQuestionCount:BASE_QUESTIONS.length,state,questionRecords:records,images:imagePayload};
  const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`口腔衛生学_完全バックアップ_${new Date().toISOString().slice(0,10)}.json`;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1200);toast('完全バックアップを書き出しました');
}
async function importBackup(file){
  if(!file)return;
  try{
    const text=await file.text();const payload=JSON.parse(text);if(!payload||!Array.isArray(payload.questionRecords))throw new Error('対応するバックアップではありません');
    if(!confirm('現在の自作問題・編集内容・学習記録を、読み込むバックアップで置き換えますか？'))return;
    await clearRecords();await clearImages();
    for(const rec of payload.questionRecords)await putRecord(rec);
    for(const img of payload.images||[])if(img.id&&img.dataUrl)await putImage({id:img.id,name:img.name||'添付画像',createdAt:img.createdAt||nowIso(),blob:dataUrlToBlob(img.dataUrl)});
    Object.assign(state,defaultState(),payload.state||{});state.unknownIds=migrateIds(state.unknownIds);state.reviewedIds=migrateIds(state.reviewedIds);state.shuffledUids=migrateIds(state.shuffledUids||state.shuffledIds);saveState('');
    clearImageUrls();await reloadRecords();initControls();refreshFiltered(false);toast('バックアップを読み込みました');
  }catch(e){alert(`読み込みに失敗しました。\n${e.message}`);}finally{$('importFile').value='';}
}
function resetReview(){if(!confirm('「わかった／分からなかった」の学習記録をすべて消しますか？'))return;state.unknownIds=[];state.reviewedIds=[];saveState('復習記録をリセットしました');refreshFiltered(false);}
async function resetAll(){
  if(!confirm('自作問題・既存問題への編集・添付画像・学習記録をすべて消しますか？\n元の491問だけの状態に戻ります。この操作は元に戻せません。'))return;
  await clearRecords();await clearImages();clearImageUrls();Object.assign(state,defaultState());try{localStorage.removeItem(STORAGE_KEY);}catch(_e){}records=[];buildQuestions();initControls();refreshFiltered(false);renderManageList();toast('初期状態に戻しました');
}

function openImage(src,caption){$('imagePreview').src=src;$('imageCaption').textContent=caption;$('imageDialog').showModal();}
function closeImage(){$('imageDialog').close();$('imagePreview').src='';}
function toast(text){const el=$('toast');el.textContent=text;el.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('show'),1800);}
function fatal(error){console.error(error);$('fatal').hidden=false;$('fatal').textContent=`アプリの読み込みに失敗しました。\n${error?.message||error}`;$('app').hidden=true;}

function bindEvents(){
  $('revealButton').addEventListener('click',revealAnswer);$('knownButton').addEventListener('click',()=>markUnknown(false));$('unknownButton').addEventListener('click',()=>markUnknown(true));
  $('prevButton').addEventListener('click',()=>move(-1));$('nextButton').addEventListener('click',()=>move(1));
  $('toggleFigures').addEventListener('click',()=>{figureVisible=!figureVisible;renderFigures(currentQuestion());});
  $('editCurrentButton').addEventListener('click',()=>{const q=currentQuestion();if(q)openEditEditor(q.uid);});$('duplicateCurrentButton').addEventListener('click',()=>{const q=currentQuestion();if(q)duplicateQuestion(q.uid);});
  $('createQuestionButton').addEventListener('click',()=>openCreateEditor());$('manageQuestionsButton').addEventListener('click',openManage);$('createFromManageButton').addEventListener('click',()=>{$('manageDialog').close();openCreateEditor();});$('closeManageButton').addEventListener('click',()=>$('manageDialog').close());
  $('mode').addEventListener('change',e=>setControl('mode',e.target.value));$('category').addEventListener('change',e=>setControl('category',e.target.value));$('sourceFilter').addEventListener('change',e=>setControl('sourceFilter',e.target.value));$('order').addEventListener('change',e=>setControl('order',e.target.value));$('theme').addEventListener('change',e=>setControl('theme',e.target.value));
  $('search').addEventListener('input',e=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{state.search=e.target.value;saveState('');refreshFiltered(false);},180);});$('clearSearch').addEventListener('click',clearSearch);$('reshuffle').addEventListener('click',reshuffle);$('showAllButton').addEventListener('click',showAll);
  $('questionForm').addEventListener('submit',saveEditor);$('cancelEditButton').addEventListener('click',closeEditor);$('closeEditorButton').addEventListener('click',closeEditor);$('editorDialog').addEventListener('cancel',e=>{e.preventDefault();closeEditor();});$('editImageInput').addEventListener('change',e=>addEditorImages(e.target.files));
  $('deleteQuestionButton').addEventListener('click',()=>{if(editorOriginalUid)softDeleteQuestion(editorOriginalUid);});$('restoreQuestionButton').addEventListener('click',()=>{if(editorOriginalUid)restoreQuestion(editorOriginalUid);});
  $('manageSearch').addEventListener('input',()=>{clearTimeout(manageTimer);manageTimer=setTimeout(renderManageList,120);});$('showDeleted').addEventListener('change',renderManageList);
  $('exportButton').addEventListener('click',exportBackup);$('importFile').addEventListener('change',e=>importBackup(e.target.files[0]));$('resetUnknownButton').addEventListener('click',resetReview);$('resetAllButton').addEventListener('click',resetAll);
  $('imageClose').addEventListener('click',closeImage);$('imageDialog').addEventListener('click',e=>{if(e.target===$('imageDialog'))closeImage();});
  window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredInstallPrompt=e;$('installButton').hidden=false;});$('installButton').addEventListener('click',async()=>{if(!deferredInstallPrompt)return;deferredInstallPrompt.prompt();await deferredInstallPrompt.userChoice;deferredInstallPrompt=null;$('installButton').hidden=true;});
  document.addEventListener('keydown',e=>{if(['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)||$('editorDialog').open||$('manageDialog').open)return;if(e.key===' '&&!answerVisible){e.preventDefault();revealAnswer();}if(e.key==='ArrowRight')move(1);if(e.key==='ArrowLeft')move(-1);if(answerVisible&&e.key.toLowerCase()==='w')markUnknown(false);if(answerVisible&&e.key.toLowerCase()==='x')markUnknown(true);});
}

async function init(){
  try{
    if(!BASE_QUESTIONS.length)throw new Error('基本問題データが空です');
    db=await openDatabase();records=await getAllRecords();buildQuestions();initControls();bindEvents();updateStorageNotice(true);refreshFiltered(true);
    if('serviceWorker' in navigator&&location.protocol.startsWith('http')) navigator.serviceWorker.register('./sw.js').catch(console.warn);
  }catch(e){fatal(e);}
}
init();
