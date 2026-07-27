/* ============================================================
   予定帳 — Firebase (Authentication + Firestore) を使う
   夫婦・家族共有スケジュール & 日記アプリ
   - Firebaseプロジェクトの設定はこの端末の localStorage に保存
   - ログインは Firebase Authentication（メール/パスワード）
   - 予定・日記データは Firestore に保存し、onSnapshot でリアルタイム同期
   ============================================================ */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, doc, addDoc, updateDoc, deleteDoc,
  onSnapshot, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const FIREBASE_CONFIG_KEY = 'schedule_app_firebase_config_v1';
const PERSON_KEY = 'schedule_app_person_v1'; // 端末ごとのローカル設定
const WEEKDAYS = ['日','月','火','水','木','金','土'];
const PERSON_COLORS = ['var(--person-0)','var(--person-1)','var(--person-2)','var(--person-3)'];
const EVENTS_COLLECTION = 'schedule_events';
const DIARY_COLLECTION = 'schedule_diary';

let firebaseApp = null;
let auth = null;
let db = null;
let unsubEvents = null;
let unsubDiary = null;

let events = [];         // [{id,date:'YYYY-MM-DD',time,title,person,memo}]
let diary = [];          // [{id,date:'YYYY-MM-DD',person,title,body}]
let viewYear, viewMonth; // 表示中の年月（monthは0-11）
let selectedDate = todayStr();
let editingEventId = null;
let editingDiaryId = null;
let currentView = 'calendar';

const els = {
  year: document.getElementById('rulerYear'),
  month: document.getElementById('rulerMonth'),
  weekdayRow: document.getElementById('weekdayRow'),
  grid: document.getElementById('calendarGrid'),
  dayTitle: document.getElementById('dayPanelTitle'),
  eventList: document.getElementById('eventList'),
  emptyMsg: document.getElementById('emptyMsg'),
  sync: document.getElementById('syncStatus'),
};

/* ---------- ユーティリティ ---------- */
function todayStr(){
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}
function pad(n){ return String(n).padStart(2,'0'); }
function uid(){ return Date.now().toString(36) + Math.random().toString(36).slice(2,7); }

function getMyName(){ return localStorage.getItem(PERSON_KEY) || ''; }
function setMyName(name){ localStorage.setItem(PERSON_KEY, name || ''); }

function loadFirebaseConfig(){
  try{ return JSON.parse(localStorage.getItem(FIREBASE_CONFIG_KEY)) || null; }
  catch{ return null; }
}
function saveFirebaseConfig(cfg){ localStorage.setItem(FIREBASE_CONFIG_KEY, JSON.stringify(cfg)); }
function clearFirebaseConfig(){ localStorage.removeItem(FIREBASE_CONFIG_KEY); }

/* 名前の文字列から安定した色を割り当てる */
function colorForPerson(name){
  if(!name) return 'var(--ink-soft)';
  let h = 0;
  for(let i=0;i<name.length;i++) h = (h*31 + name.charCodeAt(i)) >>> 0;
  return PERSON_COLORS[h % PERSON_COLORS.length];
}

function knownPeople(){
  const set = new Set();
  events.forEach(e=>{ if(e.person) set.add(e.person); });
  diary.forEach(d=>{ if(d.person) set.add(d.person); });
  if(getMyName()) set.add(getMyName());
  return Array.from(set);
}

function setStatus(msg, type=''){
  els.sync.textContent = msg;
  els.sync.className = 'sync-status' + (type ? ' '+type : '');
}

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

/* ---------- 画面の出し分け ---------- */
const setupScreen = document.getElementById('setupScreen');
const loginScreen = document.getElementById('loginScreen');
const appRoot = document.getElementById('app');

function showSetup(){
  setupScreen.classList.remove('hidden');
  loginScreen.classList.add('hidden');
  appRoot.classList.add('hidden');
}
function showLogin(){
  setupScreen.classList.add('hidden');
  loginScreen.classList.remove('hidden');
  appRoot.classList.add('hidden');
}
function showApp(){
  setupScreen.classList.add('hidden');
  loginScreen.classList.add('hidden');
  appRoot.classList.remove('hidden');
}

/* ---------- Firebase 初期化 ---------- */
function initFirebase(cfg){
  firebaseApp = initializeApp(cfg);
  auth = getAuth(firebaseApp);
  db = getFirestore(firebaseApp);

  onAuthStateChanged(auth, (user)=>{
    if(user){
      document.getElementById('settingsAccountLabel').textContent = `ログイン中：${user.email}`;
      showApp();
      startListeners();
    } else {
      stopListeners();
      showLogin();
    }
  }, (err)=>{
    console.error(err);
    showLogin();
    document.getElementById('loginError').textContent = friendlyAuthError(err);
  });
}

function startListeners(){
  setStatus('同期中…');
  unsubEvents = onSnapshot(collection(db, EVENTS_COLLECTION), (snap)=>{
    events = snap.docs.map(d=>({ id:d.id, ...d.data() }));
    setStatus('同期済み', 'ok');
    render();
  }, (err)=>{
    console.error(err);
    setStatus('予定の読み込みエラー：' + err.message, 'error');
  });
  unsubDiary = onSnapshot(collection(db, DIARY_COLLECTION), (snap)=>{
    diary = snap.docs.map(d=>({ id:d.id, ...d.data() }));
    render();
  }, (err)=>{
    console.error(err);
    setStatus('日記の読み込みエラー：' + err.message, 'error');
  });
}
function stopListeners(){
  if(unsubEvents){ unsubEvents(); unsubEvents=null; }
  if(unsubDiary){ unsubDiary(); unsubDiary=null; }
  events = []; diary = [];
}

/* ---------- 初回セットアップ画面 ---------- */
document.getElementById('btnSetupSave').addEventListener('click', ()=>{
  const raw = document.getElementById('setupConfig').value.trim();
  const errEl = document.getElementById('setupError');
  errEl.textContent = '';
  if(!raw){ errEl.textContent = 'firebaseConfig を貼り付けてください。'; return; }
  let cfg;
  try{
    // Firebaseコンソールのスニペットはキーが引用符なしのJSっぽい形式なので緩めに評価する
    cfg = Function('"use strict"; return (' + raw + ')')();
  }catch(e){
    errEl.textContent = '内容を読み取れませんでした。firebaseConfig の中身（{ }を含む）をそのまま貼り付けてください。';
    return;
  }
  if(!cfg || !cfg.apiKey || !cfg.projectId){
    errEl.textContent = 'apiKey / projectId が見つかりません。貼り付け内容を確認してください。';
    return;
  }
  saveFirebaseConfig(cfg);
  initFirebase(cfg);
  showLogin();
});

document.getElementById('btnSetupAgain').addEventListener('click', ()=>{
  clearFirebaseConfig();
  document.getElementById('setupConfig').value='';
  showSetup();
});

/* ---------- ログイン画面 ---------- */
document.getElementById('loginForm').addEventListener('submit', async (e)=>{
  e.preventDefault();
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  const errEl = document.getElementById('loginError');
  errEl.textContent = '';
  try{
    await signInWithEmailAndPassword(auth, email, password);
  }catch(err){
    console.error(err);
    errEl.textContent = friendlyAuthError(err);
  }
});

function friendlyAuthError(err){
  const code = err && err.code ? err.code : '';
  const map = {
    'auth/invalid-api-key': 'Firebase設定(apiKey)が正しくありません。「Firebase設定を変更する」からコピーし直してください。',
    'auth/api-key-not-valid': 'Firebase設定(apiKey)が正しくありません。「Firebase設定を変更する」からコピーし直してください。',
    'auth/invalid-credential': 'メールアドレスかパスワードが違います。',
    'auth/wrong-password': 'パスワードが違います。',
    'auth/user-not-found': 'そのメールアドレスは登録されていません。Firebaseコンソールの Authentication → Users を確認してください。',
    'auth/invalid-email': 'メールアドレスの形式が正しくありません。',
    'auth/too-many-requests': '試行回数が多すぎます。しばらく待ってから再度お試しください。',
    'auth/network-request-failed': 'ネットワークエラーです。通信状況を確認してください。',
    'auth/configuration-not-found': 'Firebaseコンソールで「メール/パスワード」ログインが有効になっているか確認してください。',
  };
  if(map[code]) return map[code];
  return `ログインできませんでした（${code || err.message || '不明なエラー'}）`;
}

document.getElementById('btnLogout').addEventListener('click', async ()=>{
  await signOut(auth);
  document.getElementById('settingsModal').classList.add('hidden');
});

/* ---------- カレンダー描画 ---------- */
function initWeekdayRow(){
  els.weekdayRow.innerHTML = WEEKDAYS.map(w=>`<span>${w}</span>`).join('');
}

function renderLegend(){
  const people = knownPeople();
  const legend = document.getElementById('legendRow');
  if(!people.length){ legend.innerHTML=''; return; }
  legend.innerHTML = people.map(p=>`
    <span class="legend-item"><span class="legend-dot" style="background:${colorForPerson(p)}"></span>${escapeHtml(p)}</span>
  `).join('');
}

function render(){
  if(currentView === 'diary'){ renderDiary(); return; }
  renderCalendar();
}

function renderCalendar(){
  els.year.textContent = viewYear;
  els.month.textContent = pad(viewMonth+1);
  renderLegend();

  const firstOfMonth = new Date(viewYear, viewMonth, 1);
  const startOffset = firstOfMonth.getDay(); // 0=Sun
  const gridStart = new Date(viewYear, viewMonth, 1 - startOffset);

  const cells = [];
  for(let i=0;i<42;i++){
    const d = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate()+i);
    cells.push({
      day: d.getDate(),
      other: d.getMonth() !== viewMonth,
      dateStr: `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`
    });
  }
  const weeks = [];
  for(let i=0;i<42;i+=7) weeks.push(cells.slice(i,i+7));

  const multiDayEvents = events.filter(e=> e.endDate && e.endDate !== e.date);
  const t = todayStr();

  els.grid.innerHTML = weeks.map(week=>{
    const weekStart = week[0].dateStr, weekEnd = week[6].dateStr;

    // この週にかかる複数日イベントを抽出し、列(1-7)とレーンを割り当てる
    const bars = multiDayEvents
      .filter(e=> e.date <= weekEnd && e.endDate >= weekStart)
      .map(e=>{
        const clipStart = e.date > weekStart ? e.date : weekStart;
        const clipEnd = e.endDate < weekEnd ? e.endDate : weekEnd;
        return {
          e,
          startCol: week.findIndex(c=>c.dateStr===clipStart) + 1,
          endCol: week.findIndex(c=>c.dateStr===clipEnd) + 1,
          isStart: e.date === clipStart,
          isEnd: e.endDate === clipEnd,
        };
      })
      .sort((a,b)=> a.startCol-b.startCol || a.endCol-b.endCol);

    const laneEnds = [];
    bars.forEach(b=>{
      let lane = laneEnds.findIndex(end=> end < b.startCol);
      if(lane === -1){ lane = laneEnds.length; laneEnds.push(b.endCol); }
      else { laneEnds[lane] = b.endCol; }
      b.lane = lane;
    });
    const maxLanes = laneEnds.length;

    const barLayerHtml = bars.map(b=>{
      const cls = ['bar'];
      if(b.isStart) cls.push('bar-start');
      if(b.isEnd) cls.push('bar-end');
      return `<div class="${cls.join(' ')}" data-id="${b.e.id}"
        style="grid-column:${b.startCol} / ${b.endCol+1}; grid-row:${b.lane+1}; border-left-color:${colorForPerson(b.e.person)};">${escapeHtml(b.e.title)}</div>`;
    }).join('');

    const dayCellsHtml = week.map((c,col)=>{
      const classes = ['day-cell'];
      if(c.other) classes.push('other-month');
      if(col===0) classes.push('is-sun');
      if(col===6) classes.push('is-sat');
      if(c.dateStr === t) classes.push('is-today');
      if(c.dateStr === selectedDate) classes.push('is-selected');

      const dayEvents = eventsOn(c.dateStr).filter(e=> !(e.endDate && e.endDate !== e.date));
      const shown = dayEvents.slice(0,2);
      const chips = `<div class="event-dot-row">` +
        shown.map(e=>`<div class="event-chip" style="border-left-color:${colorForPerson(e.person)}">${escapeHtml(e.time?e.time+' ':'')}${escapeHtml(e.title)}</div>`).join('') +
        (dayEvents.length>2 ? `<div class="event-more">+${dayEvents.length-2}</div>` : '') +
        `</div>`;
      const spacer = maxLanes>0 ? `<div class="bar-spacer" style="height:${maxLanes*16}px"></div>` : '';

      return `<button type="button" class="${classes.join(' ')}" data-date="${c.dateStr}" ${c.other?'tabindex="-1"':''}>
        <span class="num">${c.day}</span>
        ${spacer}
        ${chips}
      </button>`;
    }).join('');

    const barLayer = maxLanes>0
      ? `<div class="bar-layer" style="grid-auto-rows:14px;">${barLayerHtml}</div>`
      : '';

    return `<div class="week-row">${barLayer}${dayCellsHtml}</div>`;
  }).join('');

  els.grid.querySelectorAll('.day-cell:not(.other-month)').forEach(btn=>{
    btn.addEventListener('click', ()=>{ selectedDate = btn.dataset.date; render(); });
  });
  els.grid.querySelectorAll('.bar').forEach(bar=>{
    bar.addEventListener('click', (ev)=>{ ev.stopPropagation(); openEventModal(bar.dataset.id); });
  });

  renderDayPanel();
}

function eventsOn(dateStr){
  return events.filter(e=> dateStr >= e.date && dateStr <= (e.endDate || e.date))
    .sort((a,b)=> (a.time||'99:99').localeCompare(b.time||'99:99'));
}

function timeLabel(e){
  if(e.time && e.endTime) return `${e.time}〜${e.endTime}`;
  if(e.time) return `${e.time}〜`;
  return '終日';
}

function rangeLabel(e){
  if(!e.endDate || e.endDate === e.date) return '';
  return `${formatDateShort(e.date)}〜${formatDateShort(e.endDate)}`;
}

function renderDayPanel(){
  const label = formatDateLabel(selectedDate);
  els.dayTitle.textContent = label;
  const list = eventsOn(selectedDate);
  els.eventList.innerHTML = list.map(e=>`
    <li class="event-item" data-id="${e.id}" style="border-left-color:${colorForPerson(e.person)}">
      <span class="event-time">${escapeHtml(timeLabel(e))}</span>
      <span class="event-body">
        <strong>${escapeHtml(e.title)}</strong>
        <span class="person-tag" style="color:${colorForPerson(e.person)}">${escapeHtml(e.person||'')}</span>
        ${rangeLabel(e)?`<span class="range-tag">${escapeHtml(rangeLabel(e))}</span>`:''}
        ${e.memo?`<span>${escapeHtml(e.memo)}</span>`:''}
      </span>
    </li>
  `).join('');
  els.emptyMsg.classList.toggle('hidden', list.length>0);

  els.eventList.querySelectorAll('.event-item').forEach(li=>{
    li.addEventListener('click', ()=> openEventModal(li.dataset.id));
  });
}

function formatDateLabel(dateStr){
  const [y,m,d] = dateStr.split('-').map(Number);
  const dt = new Date(y,m-1,d);
  return `${y}年${m}月${d}日（${WEEKDAYS[dt.getDay()]}）`;
}

function formatDateShort(dateStr){
  const [y,m,d] = dateStr.split('-').map(Number);
  const dt = new Date(y,m-1,d);
  return `${m}/${d}（${WEEKDAYS[dt.getDay()]}）`;
}

function renderDiaryLegend(){
  const people = knownPeople();
  const legend = document.getElementById('diaryLegendRow');
  if(!people.length){ legend.innerHTML=''; return; }
  legend.innerHTML = people.map(p=>`
    <span class="legend-item"><span class="legend-dot" style="background:${colorForPerson(p)}"></span>${escapeHtml(p)}</span>
  `).join('');
}

function renderDiary(){
  renderDiaryLegend();
  const list = [...diary].sort((a,b)=> b.date.localeCompare(a.date) || (b.id||'').localeCompare(a.id||''));
  const listEl = document.getElementById('diaryList');
  listEl.innerHTML = list.map(d=>`
    <li class="event-item" data-id="${d.id}" style="border-left-color:${colorForPerson(d.person)}">
      <div class="diary-entry-head">
        <span class="diary-date">${escapeHtml(formatDateShort(d.date))}</span>
        <span class="diary-author" style="color:${colorForPerson(d.person)}">${escapeHtml(d.person||'')}</span>
      </div>
      ${d.title?`<p class="diary-title">${escapeHtml(d.title)}</p>`:''}
      <p class="diary-body">${escapeHtml(d.body||'')}</p>
    </li>
  `).join('');
  document.getElementById('diaryEmptyMsg').classList.toggle('hidden', list.length>0);
  listEl.querySelectorAll('.event-item').forEach(li=>{
    li.addEventListener('click', ()=> openDiaryModal(li.dataset.id));
  });
}

/* ---------- 月移動 ---------- */
document.getElementById('btnPrevMonth').addEventListener('click', ()=>{
  viewMonth--; if(viewMonth<0){ viewMonth=11; viewYear--; }
  render();
});
document.getElementById('btnNextMonth').addEventListener('click', ()=>{
  viewMonth++; if(viewMonth>11){ viewMonth=0; viewYear++; }
  render();
});

/* ---------- 画面切り替え（カレンダー / 日記） ---------- */
const calendarView = document.getElementById('calendarView');
const diaryView = document.getElementById('diaryView');
const calendarNav = document.getElementById('calendarNav');
const viewTitle = document.getElementById('viewTitle');
const tabCalendar = document.getElementById('tabCalendar');
const tabDiary = document.getElementById('tabDiary');

function switchView(view){
  currentView = view;
  const isCal = view === 'calendar';
  calendarView.classList.toggle('hidden', !isCal);
  diaryView.classList.toggle('hidden', isCal);
  calendarNav.classList.toggle('hidden', !isCal);
  document.querySelector('.ruler-ticks').classList.toggle('hidden', !isCal);
  viewTitle.textContent = isCal ? '予定帳' : '日記';
  tabCalendar.classList.toggle('active', isCal);
  tabDiary.classList.toggle('active', !isCal);
  render();
}
tabCalendar.addEventListener('click', ()=> switchView('calendar'));
tabDiary.addEventListener('click', ()=> switchView('diary'));

/* ---------- 予定モーダル ---------- */
const eventModal = document.getElementById('eventModal');
const eventForm = document.getElementById('eventForm');
const fDate = document.getElementById('fDate');
const fEndDate = document.getElementById('fEndDate');
const fTime = document.getElementById('fTime');
const fEndTime = document.getElementById('fEndTime');
const fTitle = document.getElementById('fTitle');
const fPerson = document.getElementById('fPerson');
const fMemo = document.getElementById('fMemo');
const btnDeleteEvent = document.getElementById('btnDeleteEvent');

fDate.addEventListener('change', ()=>{
  fEndDate.min = fDate.value;
  if(fEndDate.value && fEndDate.value < fDate.value) fEndDate.value = '';
});

function refreshPersonSuggestions(){
  const dl = document.getElementById('personSuggestions');
  dl.innerHTML = knownPeople().map(p=>`<option value="${escapeHtml(p)}">`).join('');
}

function openEventModal(id){
  editingEventId = id || null;
  const ev = id ? events.find(e=>e.id===id) : null;
  document.getElementById('eventModalTitle').textContent = ev ? '予定を編集' : '予定を追加';
  refreshPersonSuggestions();
  fDate.value = ev ? ev.date : selectedDate;
  fEndDate.min = fDate.value;
  fEndDate.value = ev && ev.endDate && ev.endDate !== ev.date ? ev.endDate : '';
  fTime.value = ev ? (ev.time||'') : '';
  fEndTime.value = ev ? (ev.endTime||'') : '';
  fTitle.value = ev ? ev.title : '';
  fPerson.value = ev ? (ev.person||'') : getMyName();
  fMemo.value = ev ? (ev.memo||'') : '';
  btnDeleteEvent.classList.toggle('hidden', !ev);
  eventModal.classList.remove('hidden');
  setTimeout(()=>fTitle.focus(), 50);
}
function closeEventModal(){ eventModal.classList.add('hidden'); editingEventId=null; }

document.getElementById('btnAddEvent').addEventListener('click', ()=> openEventModal(null));
document.getElementById('btnCancelEvent').addEventListener('click', closeEventModal);
eventModal.addEventListener('click', e=>{ if(e.target===eventModal) closeEventModal(); });

eventForm.addEventListener('submit', async (e)=>{
  e.preventDefault();
  const startDate = fDate.value;
  const endDate = (fEndDate.value && fEndDate.value >= startDate) ? fEndDate.value : startDate;
  const data = {
    date: startDate, endDate: endDate,
    time: fTime.value, endTime: fEndTime.value,
    title: fTitle.value.trim(),
    person: fPerson.value.trim(), memo: fMemo.value.trim()
  };
  if(!data.title || !data.person) return;
  closeEventModal();
  try{
    if(editingEventId){
      await updateDoc(doc(db, EVENTS_COLLECTION, editingEventId), data);
    } else {
      await addDoc(collection(db, EVENTS_COLLECTION), { ...data, createdAt: serverTimestamp() });
    }
    selectedDate = data.date;
    setStatus('保存しました — ' + nowTimeLabel(), 'ok');
  }catch(err){
    console.error(err);
    setStatus('保存エラー：' + err.message, 'error');
  }
});

btnDeleteEvent.addEventListener('click', async ()=>{
  if(!editingEventId) return;
  const id = editingEventId;
  closeEventModal();
  try{
    await deleteDoc(doc(db, EVENTS_COLLECTION, id));
  }catch(err){
    console.error(err);
    setStatus('削除エラー：' + err.message, 'error');
  }
});

/* ---------- 日記モーダル ---------- */
const diaryModal = document.getElementById('diaryModal');
const diaryForm = document.getElementById('diaryForm');
const dDate = document.getElementById('dDate');
const dPerson = document.getElementById('dPerson');
const dTitle = document.getElementById('dTitle');
const dBody = document.getElementById('dBody');
const btnDeleteDiary = document.getElementById('btnDeleteDiary');

function refreshDiaryPersonSuggestions(){
  const dl = document.getElementById('personSuggestionsDiary');
  dl.innerHTML = knownPeople().map(p=>`<option value="${escapeHtml(p)}">`).join('');
}

function openDiaryModal(id){
  editingDiaryId = id || null;
  const d = id ? diary.find(x=>x.id===id) : null;
  document.getElementById('diaryModalTitle').textContent = d ? '日記を編集' : '日記を書く';
  refreshDiaryPersonSuggestions();
  dDate.value = d ? d.date : todayStr();
  dPerson.value = d ? (d.person||'') : getMyName();
  dTitle.value = d ? (d.title||'') : '';
  dBody.value = d ? d.body : '';
  btnDeleteDiary.classList.toggle('hidden', !d);
  diaryModal.classList.remove('hidden');
  setTimeout(()=>dBody.focus(), 50);
}
function closeDiaryModal(){ diaryModal.classList.add('hidden'); editingDiaryId=null; }

document.getElementById('btnAddDiary').addEventListener('click', ()=> openDiaryModal(null));
document.getElementById('btnCancelDiary').addEventListener('click', closeDiaryModal);
diaryModal.addEventListener('click', e=>{ if(e.target===diaryModal) closeDiaryModal(); });

diaryForm.addEventListener('submit', async (e)=>{
  e.preventDefault();
  const data = {
    date: dDate.value, person: dPerson.value.trim(),
    title: dTitle.value.trim(), body: dBody.value.trim()
  };
  if(!data.body || !data.person) return;
  closeDiaryModal();
  try{
    if(editingDiaryId){
      await updateDoc(doc(db, DIARY_COLLECTION, editingDiaryId), data);
    } else {
      await addDoc(collection(db, DIARY_COLLECTION), { ...data, createdAt: serverTimestamp() });
    }
    setStatus('保存しました — ' + nowTimeLabel(), 'ok');
  }catch(err){
    console.error(err);
    setStatus('保存エラー：' + err.message, 'error');
  }
});

btnDeleteDiary.addEventListener('click', async ()=>{
  if(!editingDiaryId) return;
  const id = editingDiaryId;
  closeDiaryModal();
  try{
    await deleteDoc(doc(db, DIARY_COLLECTION, id));
  }catch(err){
    console.error(err);
    setStatus('削除エラー：' + err.message, 'error');
  }
});

function nowTimeLabel(){
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* ---------- 設定モーダル ---------- */
const settingsModal = document.getElementById('settingsModal');
const settingsForm = document.getElementById('settingsForm');

function openSettingsModal(){
  document.getElementById('sPerson').value = getMyName();
  settingsModal.classList.remove('hidden');
}
document.getElementById('btnSettings').addEventListener('click', openSettingsModal);
document.getElementById('btnCancelSettings').addEventListener('click', ()=> settingsModal.classList.add('hidden'));
settingsModal.addEventListener('click', e=>{ if(e.target===settingsModal) settingsModal.classList.add('hidden'); });

settingsForm.addEventListener('submit', (e)=>{
  e.preventDefault();
  setMyName(document.getElementById('sPerson').value.trim());
  settingsModal.classList.add('hidden');
  render();
});

/* ---------- 初期化 ---------- */
(function init(){
  const now = new Date();
  viewYear = now.getFullYear();
  viewMonth = now.getMonth();
  initWeekdayRow();

  const cfg = loadFirebaseConfig();
  if(cfg){
    try{
      initFirebase(cfg);
    }catch(e){
      console.error(e);
      showSetup();
    }
  } else {
    showSetup();
  }

  if('serviceWorker' in navigator){
    navigator.serviceWorker.register('sw.js').catch(()=>{});
  }
})();
