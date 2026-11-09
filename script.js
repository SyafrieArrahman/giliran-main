const STORAGE_KEY = 'giliran-main-session';
let state = null;
let draftFormat = 'doubles';

const SKIP_CAP = 2;       // kali di-skip demi kombinasi baru sebelum wajib main
const POOL_EXTRA = 4;     // kandidat ekstra di luar minimum slot, buat cari variasi

function keyPair(a,b){ return [a,b].sort().join('__'); }
function slotsNeeded(){ return state.format === 'singles' ? 2 : 4; }
function findPlayer(id){ return state.players.find(p=>p.id===id); }

// Angka yang dipakai cuma buat urutan antrian. gamesPlayed tetap jumlah main yang asli.
function qg(p){ return p.queueGames ?? p.gamesPlayed; }

// Tingkat urutan buat pemain yang telat / balik dari istirahat: sama dengan pemain
// yang lagi nunggu dengan tingkat terendah, tapi masuk di belakang mereka.
// Kalau tidak ada yang nunggu, pakai tingkat terendah di antara yang lagi main.
function baseLevel(excludeId){
  const others = state.players.filter(p => !p.left && !p.resting && p.id !== excludeId);
  const waiting = others.filter(p => p.status === 'waiting');
  const pool = waiting.length ? waiting : others;
  return pool.length ? Math.min(...pool.map(qg)) : 0;
}

function esc(s){
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function sortedQueue(){
  return state.players
    .filter(p=>p.status==='waiting' && !p.resting && !p.left)
    .sort((a,b)=> qg(a) - qg(b) || a.waitingSince - b.waitingSince);
}

function kCombinations(arr, k){
  const results = [];
  function helper(start, combo){
    if(combo.length === k){ results.push([...combo]); return; }
    for(let i=start;i<arr.length;i++){
      combo.push(arr[i]);
      helper(i+1, combo);
      combo.pop();
    }
  }
  helper(0, []);
  return results;
}

function evalCombo(combo, need, ctx){
  if(need === 2){
    return { score: (ctx.opponentHistory[keyPair(combo[0].id, combo[1].id)]||0), split: null };
  }
  const [p0,p1,p2,p3] = combo;
  const splits = [
    [[p0,p1],[p2,p3]],
    [[p0,p2],[p1,p3]],
    [[p0,p3],[p1,p2]],
  ];
  let best = splits[0], bestScore = Infinity;
  splits.forEach(s => {
    const score = (ctx.partnerHistory[keyPair(s[0][0].id,s[0][1].id)]||0) + (ctx.partnerHistory[keyPair(s[1][0].id,s[1][1].id)]||0)
      + s[0].reduce((sum,a)=> sum + s[1].reduce((s2,b)=> s2+(ctx.opponentHistory[keyPair(a.id,b.id)]||0),0), 0);
    if(score < bestScore){ bestScore = score; best = s; }
  });
  return { score: bestScore, split: best };
}

// Picks the next match from a queue against a given history/skip context.
// Mutates ctx (skipCount/partnerHistory/opponentHistory) so callers can chain
// picks for several courts in a row (real assignment, or a preview pass).
function pickFromQueue(queue, need, ctx){
  if(queue.length < need) return null;
  const pool = queue.slice(0, Math.min(queue.length, need + POOL_EXTRA));

  let forced = pool.filter(p => (ctx.skipCount[p.id]||0) >= SKIP_CAP);
  if(forced.length > need){
    forced = [...forced].sort((a,b) => (ctx.skipCount[b.id]||0) - (ctx.skipCount[a.id]||0)).slice(0, need);
  }
  const remainingSlots = need - forced.length;
  const others = pool.filter(p => !forced.includes(p));

  let bestCombo, bestScore = Infinity, bestSplit = null;
  if(remainingSlots === 0){
    const res = evalCombo(forced, need, ctx);
    bestCombo = forced; bestSplit = res.split;
  } else {
    kCombinations(others, remainingSlots).forEach(extra => {
      const combo = forced.concat(extra);
      const res = evalCombo(combo, need, ctx);
      if(res.score < bestScore){ bestScore = res.score; bestCombo = combo; bestSplit = res.split; }
    });
  }

  pool.forEach(p => {
    ctx.skipCount[p.id] = bestCombo.includes(p) ? 0 : (ctx.skipCount[p.id]||0) + 1;
  });

  if(need === 4){
    const kA = keyPair(bestSplit[0][0].id, bestSplit[0][1].id);
    const kB = keyPair(bestSplit[1][0].id, bestSplit[1][1].id);
    ctx.partnerHistory[kA] = (ctx.partnerHistory[kA]||0) + 1;
    ctx.partnerHistory[kB] = (ctx.partnerHistory[kB]||0) + 1;
    bestSplit[0].forEach(a => bestSplit[1].forEach(b => {
      const k = keyPair(a.id, b.id);
      ctx.opponentHistory[k] = (ctx.opponentHistory[k]||0) + 1;
    }));
  } else {
    const k = keyPair(bestCombo[0].id, bestCombo[1].id);
    ctx.opponentHistory[k] = (ctx.opponentHistory[k]||0) + 1;
  }

  return { combo: bestCombo, split: bestSplit };
}

function assignCourt(courtId){
  const court = state.courts.find(c=>c.id===courtId);
  if(!court || court.status==='playing') return;
  const need = slotsNeeded();
  const result = pickFromQueue(sortedQueue(), need, state);
  if(!result){ court.status='empty'; court.players=[]; court.teams=null; return; }
  const { combo, split } = result;
  if(need === 4){
    court.teams = split.map(team => team.map(p=>p.id));
  } else {
    court.teams = [[combo[0].id],[combo[1].id]];
  }
  combo.forEach(p=>{ p.status='playing'; });
  court.players = combo.map(p=>p.id);
  court.status='playing';
}

// Simulates, without touching real state, what the next match on each
// currently-occupied court would be if it were freed up right now — in
// court order, so two courts freeing up together don't preview the same players.
function previewNextMatches(){
  const need = slotsNeeded();
  const ctx = {
    partnerHistory: {...state.partnerHistory},
    opponentHistory: {...state.opponentHistory},
    skipCount: {...state.skipCount}
  };
  let workingQueue = sortedQueue();
  const previews = {};
  state.courts.filter(c => c.status === 'playing').forEach(court => {
    const result = pickFromQueue(workingQueue, need, ctx);
    previews[court.id] = result;
    if(result){
      const chosenIds = new Set(result.combo.map(p=>p.id));
      workingQueue = workingQueue.filter(p => !chosenIds.has(p.id));
    }
  });
  return previews;
}

function tryFillAll(){ state.courts.forEach(c=>{ if(c.status!=='playing') assignCourt(c.id); }); }

// --- Undo ---
function snapshot(){ const { undo, ...rest } = state; return JSON.stringify(rest); }
function pushUndo(label){
  state.undo = state.undo || [];
  state.undo.push({ label, data: snapshot() });
  if(state.undo.length > 10) state.undo.shift();
}
function undoLast(){
  const u = state.undo && state.undo.pop();
  if(!u) return;
  const prev = JSON.parse(u.data);
  prev.undo = state.undo;
  state = prev;
  saveAndRender();
}

// --- Aksi pemain ---
function finishCourt(courtId){
  const idx = state.courts.findIndex(c=>c.id===courtId);
  const court = state.courts[idx];
  if(!court || court.status!=='playing') return;
  pushUndo(`Lapangan ${idx+1} selesai`);
  court.players.forEach(pid=>{
    const p = findPlayer(pid);
    p.gamesPlayed += 1;
    p.queueGames = qg(p) + 1;
    p.status='waiting';
    p.waitingSince = state.clock++;
  });
  court.players=[]; court.teams=null; court.status='empty';
  assignCourt(courtId);
  saveAndRender();
}

function toggleRest(playerId){
  const p = findPlayer(playerId);
  if(!p || p.status==='playing' || p.left) return;
  pushUndo(p.resting ? `${p.name} main lagi` : `${p.name} istirahat`);
  p.resting = !p.resting;
  if(!p.resting){
    // balik dari istirahat: tidak dikompensasi, masuk di belakang antrian
    p.queueGames = Math.max(qg(p), baseLevel(p.id));
    p.waitingSince = state.clock++;
  }
  tryFillAll();
  saveAndRender();
}

function leavePlayer(playerId){
  const p = findPlayer(playerId);
  if(!p || p.status==='playing' || p.left) return;
  pushUndo(`${p.name} pulang`);
  p.left = true;
  p.resting = false;
  saveAndRender();
}

function returnPlayer(playerId){
  const p = findPlayer(playerId);
  if(!p || !p.left) return;
  pushUndo(`${p.name} kembali`);
  p.left = false;
  p.resting = false;
  p.status = 'waiting';
  p.queueGames = Math.max(qg(p), baseLevel(p.id));
  p.waitingSince = state.clock++;
  tryFillAll();
  saveAndRender();
}

function addLatePlayer(name){
  pushUndo(`${name} ditambah`);
  const id = 'p'+(++state.idCounter);
  // pemain telat tidak dikompensasi: mulai di tingkat terendah, di belakang yang sudah nunggu
  state.players.push({id, name, gamesPlayed:0, queueGames: baseLevel(null), waitingSince: state.clock++, resting:false, left:false, status:'waiting'});
  tryFillAll();
  saveAndRender();
}

// outcome: 'wait' (antri lagi) | 'rest' | 'leave'
function swapPlayer(courtId, outId, inId, outcome){
  const idx = state.courts.findIndex(c=>c.id===courtId);
  const court = state.courts[idx];
  const pout = findPlayer(outId), pin = findPlayer(inId);
  if(!court || court.status!=='playing' || !pout || !pin || pin.status!=='waiting' || pin.resting || pin.left) return;
  pushUndo(`Ganti ${pout.name} di lapangan ${idx+1}`);
  court.players = court.players.map(id => id===outId ? inId : id);
  court.teams = court.teams.map(team => team.map(id => id===outId ? inId : id));
  pin.status = 'playing';
  pout.status = 'waiting';
  pout.waitingSince = state.clock++;
  if(outcome === 'rest') pout.resting = true;
  if(outcome === 'leave'){ pout.left = true; pout.resting = false; }
  saveAndRender();
}

function newSessionState(){
  return {players:[], courts:[], partnerHistory:{}, opponentHistory:{}, skipCount:{}, clock:0, idCounter:0, format:'doubles', started:false, undo:[]};
}

function saveState(){
  try{ localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  catch(e){ console.error('Gagal menyimpan sesi', e); }
}
function saveAndRender(){ saveState(); render(); }

// --- Layar tetap menyala selama sesi ---
let wakeLock = null;
async function requestWakeLock(){
  if(!('wakeLock' in navigator) || wakeLock) return;
  try{
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  }catch(e){ wakeLock = null; }
}
function releaseWakeLock(){ if(wakeLock){ wakeLock.release().catch(()=>{}); wakeLock = null; } }
document.addEventListener('visibilitychange', () => {
  if(document.visibilityState === 'visible' && state && state.started) requestWakeLock();
});

// --- Render ---
function render(){
  document.getElementById('loadingNote').classList.add('hidden');
  const hasSession = state.started;
  document.getElementById('setupSection').classList.toggle('hidden', hasSession || state.rosterDraft);
  document.getElementById('rosterSection').classList.toggle('hidden', !state.rosterDraft || hasSession);
  document.getElementById('liveSection').classList.toggle('hidden', !hasSession);
  document.getElementById('resetBtn').classList.toggle('hidden', !hasSession && !state.rosterDraft);

  if(hasSession){
    const formatLabel = state.format === 'singles' ? 'Tunggal' : 'Ganda';
    const activeCount = state.players.filter(p => !p.left).length;
    document.getElementById('sessionMeta').textContent =
      `${activeCount} pemain · ${state.courts.length} lapangan · ${formatLabel}`;
    renderUndo();
    renderCourts();
    renderQueue();
    renderStats();
    requestWakeLock();
  } else {
    document.getElementById('sessionMeta').textContent = '';
  }
}

function nameFor(id){ const p = findPlayer(id); return p ? p.name : '?'; }

function renderUndo(){
  const btn = document.getElementById('undoBtn');
  const last = state.undo && state.undo[state.undo.length - 1];
  btn.disabled = !last;
  btn.textContent = last ? `Urungkan: ${last.label}` : 'Urungkan';
}

function teamHtml(ids, courtId){
  return ids.map(id =>
    `<button type="button" class="chip" data-court="${courtId}" data-pid="${id}" aria-label="Ganti ${esc(nameFor(id))}">${esc(nameFor(id))}</button>`
  ).join('<span class="amp"> &amp; </span>');
}

function renderCourts(){
  const row = document.getElementById('courtsRow');
  row.innerHTML = '';
  const previews = previewNextMatches();
  state.courts.forEach((court, i) => {
    const div = document.createElement('div');
    div.className = 'court' + (court.status==='playing' ? '' : ' empty');
    if(court.status === 'playing'){
      const preview = previews[court.id];
      let previewText = 'Belum cukup pemain nunggu';
      if(preview){
        const names = team => team.map(p => esc(nameFor(p.id))).join(' &amp; ');
        previewText = state.format === 'singles'
          ? `${esc(nameFor(preview.combo[0].id))} vs ${esc(nameFor(preview.combo[1].id))}`
          : `${names(preview.split[0])} vs ${names(preview.split[1])}`;
      }
      div.innerHTML = `
        <div class="court-head">
          <span class="court-num">Lapangan ${i+1}</span>
          <span class="court-live">Sedang main</span>
        </div>
        <div class="court-surface">
          <div class="team">${teamHtml(court.teams[0], court.id)}</div>
          <div class="net"><span>vs</span></div>
          <div class="team">${teamHtml(court.teams[1], court.id)}</div>
        </div>
        <button class="btn-primary" data-court="${court.id}">Selesai</button>
        <div class="next-preview">Berikutnya: ${previewText}</div>
      `;
      div.querySelector('.btn-primary').addEventListener('click', () => finishCourt(court.id));
      div.querySelectorAll('.chip').forEach(chip =>
        chip.addEventListener('click', () => openSwapDialog(court.id, chip.dataset.pid)));
    } else {
      div.innerHTML = `
        <div class="court-head"><span class="court-num">Lapangan ${i+1}</span></div>
        <div>Menunggu pemain...</div>
      `;
    }
    row.appendChild(div);
  });
}

function renderQueue(){
  const list = document.getElementById('queueList');
  const queue = sortedQueue();
  list.innerHTML = '';
  if(queue.length === 0){
    list.innerHTML = '<div class="empty-note">Semua pemain sedang main.</div>';
  }
  queue.forEach((p, i) => {
    const li = document.createElement('li');
    li.innerHTML = `
      <div class="q-left">
        <span class="q-rank">${i+1}</span>
        <span class="q-name">${esc(p.name)}</span>
      </div>
      <div class="q-right">
        <span class="pill">${p.gamesPlayed} main</span>
        <button class="btn-ghost btn-small" data-act="rest">Istirahat</button>
        <button class="btn-ghost btn-small btn-quiet" data-act="leave">Pulang</button>
      </div>
    `;
    li.querySelector('[data-act="rest"]').addEventListener('click', () => toggleRest(p.id));
    li.querySelector('[data-act="leave"]').addEventListener('click', () => leavePlayer(p.id));
    list.appendChild(li);
  });

  const resting = state.players.filter(p => p.resting && !p.left && p.status==='waiting');
  const wrap = document.getElementById('restingWrap');
  wrap.innerHTML = '';
  if(resting.length){
    const header = document.createElement('div');
    header.className = 'rest-divider';
    header.textContent = 'Istirahat';
    wrap.appendChild(header);
    const ol = document.createElement('ol');
    ol.className = 'queue-list';
    resting.forEach(p => {
      const li = document.createElement('li');
      li.innerHTML = `
        <div class="q-left"><span class="q-name">${esc(p.name)}</span></div>
        <div class="q-right">
          <span class="pill">${p.gamesPlayed} main</span>
          <button class="btn-ghost btn-small btn-resume" data-act="resume">Main lagi</button>
          <button class="btn-ghost btn-small btn-quiet" data-act="leave">Pulang</button>
        </div>
      `;
      li.querySelector('[data-act="resume"]').addEventListener('click', () => toggleRest(p.id));
      li.querySelector('[data-act="leave"]').addEventListener('click', () => leavePlayer(p.id));
      ol.appendChild(li);
    });
    wrap.appendChild(ol);
  }
}

function renderStats(){
  const body = document.getElementById('statsBody');
  const rows = [...state.players].sort((a,b) => b.gamesPlayed - a.gamesPlayed || a.name.localeCompare(b.name));
  body.innerHTML = rows.map(p => {
    let statusText = 'Menunggu', cls='', extra='';
    if(p.left){ statusText = 'Pulang'; cls='left'; extra = `<button class="btn-ghost btn-small" data-return="${p.id}">Kembali</button>`; }
    else if(p.status === 'playing'){ statusText = 'Main'; cls='playing'; }
    else if(p.resting){ statusText = 'Istirahat'; cls='resting'; }
    return `<tr><td>${esc(p.name)}</td><td>${p.gamesPlayed}</td><td class="status-cell"><span class="status-tag ${cls}">${statusText}</span>${extra}</td></tr>`;
  }).join('');
  body.querySelectorAll('[data-return]').forEach(btn =>
    btn.addEventListener('click', () => returnPlayer(btn.dataset.return)));
}

// --- Ringkasan sesi (disalin ke clipboard) ---
function buildSummary(){
  const need = slotsNeeded();
  const total = state.players.reduce((sum,p) => sum + p.gamesPlayed, 0);
  const matches = Math.floor(total / need);
  const date = new Date().toLocaleDateString('id-ID', { day:'numeric', month:'long', year:'numeric' });
  const formatLabel = state.format === 'singles' ? 'Tunggal' : 'Ganda';
  const rows = [...state.players]
    .sort((a,b) => b.gamesPlayed - a.gamesPlayed || a.name.localeCompare(b.name))
    .map((p,i) => `${i+1}. ${p.name}: ${p.gamesPlayed}${p.left ? ' (pulang)' : ''}`);
  return [
    `Pukul Kok 599 - ${date}`,
    `${formatLabel}, ${state.courts.length} lapangan, ${matches} match selesai`,
    '',
    'Jumlah main:',
    ...rows
  ].join('\n');
}

async function copySummary(){
  const text = buildSummary();
  const btn = document.getElementById('copySummaryBtn');
  let ok = false;
  try{ await navigator.clipboard.writeText(text); ok = true; }
  catch(e){
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try{ ok = document.execCommand('copy'); }catch(err){ ok = false; }
    ta.remove();
  }
  btn.textContent = ok ? 'Tersalin' : 'Gagal menyalin';
  setTimeout(() => { btn.textContent = 'Salin ringkasan'; }, 1800);
}

// --- Dialog ---
function bindDialog(dlg){
  // klik di luar kartu (backdrop) = tutup; Esc sudah ditangani bawaan <dialog>
  dlg.addEventListener('click', e => { if(e.target === dlg) dlg.close(); });
}
const confirmDialog = document.getElementById('confirmDialog');
const swapDialog = document.getElementById('swapDialog');
bindDialog(confirmDialog);
bindDialog(swapDialog);

let swapCtx = null; // { courtId, outId, outcome }

function openSwapDialog(courtId, outId){
  swapCtx = { courtId, outId, outcome: 'wait' };
  document.getElementById('swapTitle').textContent = `Ganti ${nameFor(outId)}`;
  document.getElementById('swapOutLabel').textContent = `Setelah diganti, ${nameFor(outId)}:`;
  swapDialog.querySelectorAll('.format-btn').forEach(b => b.classList.toggle('active', b.dataset.outcome === 'wait'));
  const list = document.getElementById('swapList');
  list.innerHTML = '';
  const candidates = sortedQueue();
  if(candidates.length === 0){
    list.innerHTML = '<div class="empty-note">Tidak ada pemain yang lagi nunggu.</div>';
  }
  candidates.forEach(p => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'swap-option';
    btn.innerHTML = `<span class="q-name">${esc(p.name)}</span><span class="pill">${p.gamesPlayed} main</span>`;
    btn.addEventListener('click', () => {
      swapPlayer(swapCtx.courtId, swapCtx.outId, p.id, swapCtx.outcome);
      swapDialog.close();
    });
    list.appendChild(btn);
  });
  swapDialog.showModal();
}

swapDialog.querySelectorAll('.format-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    swapDialog.querySelectorAll('.format-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    swapCtx.outcome = btn.dataset.outcome;
  });
});
document.getElementById('swapCancel').addEventListener('click', () => swapDialog.close());

// --- Setup flow ---
document.querySelectorAll('#setupSection .format-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#setupSection .format-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    draftFormat = btn.dataset.format;
  });
});

document.getElementById('generateRosterBtn').addEventListener('click', () => {
  const numPlayers = Math.max(2, parseInt(document.getElementById('numPlayersInput').value) || 0);
  const numCourts = Math.max(1, parseInt(document.getElementById('numCourtsInput').value) || 0);
  const need = draftFormat === 'singles' ? 2 : 4;
  const errEl = document.getElementById('setupError');
  if(numPlayers < need){
    errEl.textContent = `Minimal ${need} pemain untuk format ini.`;
    errEl.classList.remove('hidden');
    return;
  }
  errEl.classList.add('hidden');
  state.rosterDraft = { numPlayers, numCourts, format: draftFormat };
  render();
  const grid = document.getElementById('rosterGrid');
  grid.innerHTML = '';
  for(let i=1; i<=numPlayers; i++){
    const input = document.createElement('input');
    input.type = 'text';
    input.value = `Pemain ${i}`;
    input.dataset.idx = i;
    grid.appendChild(input);
  }
});

document.getElementById('startSessionBtn').addEventListener('click', () => {
  const draft = state.rosterDraft;
  const inputs = document.querySelectorAll('#rosterGrid input');
  const players = [];
  inputs.forEach((inp, i) => {
    players.push({
      id: 'p'+(i+1),
      name: inp.value.trim() || `Pemain ${i+1}`,
      gamesPlayed: 0,
      queueGames: 0,
      waitingSince: i,
      resting: false,
      left: false,
      status: 'waiting'
    });
  });
  state.players = players;
  state.idCounter = players.length;
  state.clock = players.length;
  state.format = draft.format;
  state.courts = Array.from({length: draft.numCourts}, (_, i) => ({id:'c'+(i+1), players:[], teams:null, status:'empty'}));
  state.partnerHistory = {};
  state.opponentHistory = {};
  state.skipCount = {};
  state.undo = [];
  state.started = true;
  state.rosterDraft = null;
  tryFillAll();
  saveAndRender();
});

document.getElementById('addLateBtn').addEventListener('click', () => {
  const form = document.getElementById('addLateForm');
  form.classList.toggle('hidden');
  if(!form.classList.contains('hidden')) document.getElementById('addLateInput').focus();
});
document.getElementById('addLateConfirm').addEventListener('click', () => {
  const input = document.getElementById('addLateInput');
  const name = input.value.trim();
  if(name){
    addLatePlayer(name);
    input.value = '';
    document.getElementById('addLateForm').classList.add('hidden');
  }
});
document.getElementById('addLateInput').addEventListener('keydown', (e) => {
  if(e.key === 'Enter') document.getElementById('addLateConfirm').click();
});
document.getElementById('addLateCancel').addEventListener('click', () => {
  document.getElementById('addLateInput').value = '';
  document.getElementById('addLateForm').classList.add('hidden');
});

document.getElementById('undoBtn').addEventListener('click', undoLast);
document.getElementById('copySummaryBtn').addEventListener('click', copySummary);

// --- Sesi baru (alert box) ---
document.getElementById('resetBtn').addEventListener('click', () => confirmDialog.showModal());
document.getElementById('confirmCancel').addEventListener('click', () => confirmDialog.close());
document.getElementById('confirmOk').addEventListener('click', () => {
  confirmDialog.close();
  releaseWakeLock();
  state = newSessionState();
  document.getElementById('numPlayersInput').value = 10;
  document.getElementById('numCourtsInput').value = 2;
  document.querySelectorAll('#setupSection .format-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('#setupSection .format-btn[data-format="doubles"]').classList.add('active');
  draftFormat = 'doubles';
  saveAndRender();
});

// --- Init ---
(function init(){
  try{
    const saved = localStorage.getItem(STORAGE_KEY);
    state = saved ? JSON.parse(saved) : newSessionState();
  }catch(e){
    state = newSessionState();
  }
  if(!state.undo) state.undo = [];
  render();
})();
