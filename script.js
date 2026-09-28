const STORAGE_KEY = 'giliran-main-session';
let state = null;
let draftFormat = 'doubles';

const SKIP_CAP = 2;       // kali di-skip demi kombinasi baru sebelum wajib main
const POOL_EXTRA = 4;     // kandidat ekstra di luar minimum slot, buat cari variasi

function keyPair(a,b){ return [a,b].sort().join('__'); }
function slotsNeeded(){ return state.format === 'singles' ? 2 : 4; }
function findPlayer(id){ return state.players.find(p=>p.id===id); }

function sortedQueue(){
  return state.players
    .filter(p=>p.status==='waiting' && !p.resting)
    .sort((a,b)=> a.gamesPlayed - b.gamesPlayed || a.waitingSince - b.waitingSince);
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

function finishCourt(courtId){
  const court = state.courts.find(c=>c.id===courtId);
  if(!court || court.status!=='playing') return;
  court.players.forEach(pid=>{
    const p = findPlayer(pid);
    p.gamesPlayed += 1;
    p.status='waiting';
    p.waitingSince = state.clock++;
  });
  court.players=[]; court.teams=null; court.status='empty';
  assignCourt(courtId);
  saveAndRender();
}

function toggleRest(playerId){
  const p = findPlayer(playerId);
  if(!p || p.status==='playing') return;
  p.resting = !p.resting;
  if(!p.resting){ p.waitingSince = state.clock++; }
  tryFillAll();
  saveAndRender();
}

function addLatePlayer(name){
  const id = 'p'+(++state.idCounter);
  state.players.push({id, name, gamesPlayed:0, waitingSince: state.clock++, resting:false, status:'waiting'});
  tryFillAll();
  saveAndRender();
}

function newSessionState(){
  return {players:[], courts:[], partnerHistory:{}, opponentHistory:{}, skipCount:{}, clock:0, idCounter:0, format:'doubles', started:false};
}

function saveState(){
  try{ localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  catch(e){ console.error('Gagal menyimpan sesi', e); }
}
function saveAndRender(){ saveState(); render(); }

function render(){
  document.getElementById('loadingNote').classList.add('hidden');
  const hasSession = state.started;
  document.getElementById('setupSection').classList.toggle('hidden', hasSession || state.rosterDraft);
  document.getElementById('rosterSection').classList.toggle('hidden', !state.rosterDraft || hasSession);
  document.getElementById('liveSection').classList.toggle('hidden', !hasSession);
  document.getElementById('resetBtn').classList.toggle('hidden', !hasSession && !state.rosterDraft);

  if(hasSession){
    const formatLabel = state.format === 'singles' ? 'Tunggal' : 'Ganda';
    document.getElementById('sessionMeta').textContent =
      `${state.players.length} pemain · ${state.courts.length} lapangan · ${formatLabel}`;
    renderCourts();
    renderQueue();
    renderStats();
  }
}

function nameFor(id){ const p = findPlayer(id); return p ? p.name : '?'; }

function renderCourts(){
  const row = document.getElementById('courtsRow');
  row.innerHTML = '';
  const previews = previewNextMatches();
  state.courts.forEach((court, i) => {
    const div = document.createElement('div');
    div.className = 'court' + (court.status==='playing' ? '' : ' empty');
    if(court.status === 'playing'){
      const teamA = court.teams[0].map(nameFor).join(' & ');
      const teamB = court.teams[1].map(nameFor).join(' & ');
      const preview = previews[court.id];
      let previewText = 'Belum cukup pemain nunggu';
      if(preview){
        previewText = state.format === 'singles'
          ? `${nameFor(preview.combo[0].id)} vs ${nameFor(preview.combo[1].id)}`
          : `${preview.split[0].map(p=>nameFor(p.id)).join(' & ')} vs ${preview.split[1].map(p=>nameFor(p.id)).join(' & ')}`;
      }
      div.innerHTML = `
        <div class="court-label"><span class="court-num">Lapangan ${i+1}</span></div>
        <div class="team">${teamA}</div>
        <div class="vs">vs</div>
        <div class="team">${teamB}</div>
        <button class="btn-primary" data-court="${court.id}">Selesai</button>
        <div class="next-preview">Berikutnya: ${previewText}</div>
      `;
      div.querySelector('button').addEventListener('click', () => finishCourt(court.id));
    } else {
      div.innerHTML = `
        <div class="court-label"><span class="court-num">Lapangan ${i+1}</span></div>
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
        <span class="q-name">${p.name}</span>
      </div>
      <div class="q-right">
        <span class="pill">${p.gamesPlayed} main</span>
        <button class="btn-ghost btn-small" data-id="${p.id}">Istirahat</button>
      </div>
    `;
    li.querySelector('button').addEventListener('click', () => toggleRest(p.id));
    list.appendChild(li);
  });

  const resting = state.players.filter(p => p.resting && p.status==='waiting');
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
        <div class="q-left"><span class="q-name">${p.name}</span></div>
        <div class="q-right">
          <span class="pill">${p.gamesPlayed} main</span>
          <button class="btn-ghost btn-small btn-green" data-id="${p.id}">Main lagi</button>
        </div>
      `;
      li.querySelector('button').addEventListener('click', () => toggleRest(p.id));
      ol.appendChild(li);
    });
    wrap.appendChild(ol);
  }
}

function renderStats(){
  const body = document.getElementById('statsBody');
  const rows = [...state.players].sort((a,b) => b.gamesPlayed - a.gamesPlayed || a.name.localeCompare(b.name));
  body.innerHTML = rows.map(p => {
    let statusText = 'Menunggu', cls='';
    if(p.status === 'playing'){ statusText = 'Main'; cls='playing'; }
    else if(p.resting){ statusText = 'Istirahat'; cls='resting'; }
    return `<tr><td>${p.name}</td><td>${p.gamesPlayed}</td><td class="status-tag ${cls}">${statusText}</td></tr>`;
  }).join('');
}

// --- Setup flow ---
document.querySelectorAll('.format-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.format-btn').forEach(b => b.classList.remove('active'));
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
      waitingSince: i,
      resting: false,
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

let resetArmed = false;
let resetTimer = null;
document.getElementById('resetBtn').addEventListener('click', () => {
  const btn = document.getElementById('resetBtn');
  if(!resetArmed){
    resetArmed = true;
    btn.textContent = 'Yakin? Klik lagi';
    resetTimer = setTimeout(() => { resetArmed = false; btn.textContent = 'Sesi baru'; }, 3000);
    return;
  }
  clearTimeout(resetTimer);
  resetArmed = false;
  const btnLabel = document.getElementById('resetBtn');
  btnLabel.textContent = 'Sesi baru';
  state = newSessionState();
  document.getElementById('numPlayersInput').value = 10;
  document.getElementById('numCourtsInput').value = 2;
  document.querySelectorAll('.format-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('.format-btn[data-format="doubles"]').classList.add('active');
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
  render();
})();
