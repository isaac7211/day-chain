(function(){

  // Public web config — safe to expose client-side; access is enforced by
  // firestore.rules, not by keeping this secret.
  const firebaseConfig = {
    apiKey: "AIzaSyBG3JD5KPXzr4zSuTZMElD4jDulTxgCCzg",
    authDomain: "day-chain.firebaseapp.com",
    projectId: "day-chain",
    storageBucket: "day-chain.firebasestorage.app",
    messagingSenderId: "874734696407",
    appId: "1:874734696407:web:f1e7aacbaa89705a1a7d92"
  };
  firebase.initializeApp(firebaseConfig);
  const auth = firebase.auth();
  const db = firebase.firestore();

  // Two independent routines share this app: 'morning' (the original) and
  // 'night'. Morning keeps using the original unprefixed field names below
  // so existing data needs no migration; night's fields are prefixed.
  let currentRoutine = 'morning'; // 'morning' | 'night'

  const DEFAULT_TASKS_BY_ROUTINE = {
    morning: [
      {id:'t1', name:'Wake up', baseEst:10},
      {id:'t2', name:'Get out of bed', baseEst:20},
      {id:'t3', name:'Warm up stretch', baseEst:10},
      {id:'t4', name:'Exercise', baseEst:40},
      {id:'t5', name:'Cool down', baseEst:15},
      {id:'t6', name:'Make breakfast', baseEst:15},
      {id:'t7', name:'Eat breakfast', baseEst:30},
      {id:'t8', name:'Brush teeth & biz', baseEst:10},
      {id:'t9', name:'Shower', baseEst:40},
      {id:'t10', name:'Prep for work', baseEst:10},
    ],
    night: [], // no assumed steps — built from scratch via "+ Add step"
  };
  const DEFAULT_SETTINGS_BY_ROUTINE = {
    morning: { targetTime: '11:00' },
    night: { targetTime: '22:30' },
  };
  const ROUTINE_COPY = {
    morning: {
      targetLabel: 'Target work-start time',
      eyebrow: 'Projected work-start',
      startBtn: "I'm up — start the chain",
      summaryLabel: 'This morning',
    },
    night: {
      targetLabel: 'Target lights-out time',
      eyebrow: 'Projected lights-out',
      startBtn: 'Time to wind down — start the chain',
      summaryLabel: 'Tonight',
    },
  };

  let tasks = [];
  let settings = { ...DEFAULT_SETTINGS_BY_ROUTINE.morning };
  let today = null; // active routine state
  let tickHandle = null;

  // ---------- storage helpers (Firestore, one doc per signed-in user) ----------
  // docRef/docCache are only ever set after auth resolves (see the
  // onAuthStateChanged handler at the bottom), so sGet/sSet can't run before
  // sign-in completes — the app UI itself stays hidden until then too.
  let docRef = null;
  let docCache = null;

  // Storage keys used throughout the app are prefixed ("daychain:tasks"),
  // but they're stored as bare fields ("tasks") on the single Firestore doc —
  // "night_tasks" etc. when the night routine is active, so both routines'
  // data lives side by side without colliding.
  function fieldNameForKey(key){
    const bare = key.startsWith('daychain:') ? key.slice('daychain:'.length) : key;
    return currentRoutine === 'night' ? ('night_' + bare) : bare;
  }

  async function sGet(key){
    if(!docCache) return null;
    const field = fieldNameForKey(key);
    return (field in docCache) ? docCache[field] : null;
  }
  async function sSet(key, val){
    if(!docRef) return;
    const field = fieldNameForKey(key);
    docCache[field] = val;
    try{ await docRef.set({ [field]: val }, { merge: true }); }
    catch(e){ console.error('firestore set failed', field, e); }
  }

  function uid(){ return 't' + Math.random().toString(36).slice(2,9); }
  function todayStr(){ return new Date().toDateString(); }
  function fmtClock(ms){
    const d = new Date(ms);
    let h = d.getHours(); const m = d.getMinutes();
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12; if(h === 0) h = 12;
    return h + ':' + String(m).padStart(2,'0') + ' ' + ampm;
  }
  function fmtMMSS(ms){
    const totalSec = Math.max(0, Math.floor(ms/1000));
    const m = Math.floor(totalSec/60), s = totalSec%60;
    return m + ':' + String(s).padStart(2,'0');
  }
  function plannedMinFor(task){
    return task.baseEst;
  }
  function targetMsForToday(){
    const [hh,mm] = (settings.targetTime || '11:00').split(':').map(Number);
    // Anchor to the calendar day the active routine started, not "right
    // now" — a night routine can still be running past midnight, and its
    // target belongs to the evening it began, not to the new date.
    const base = (today && today.startTime) ? new Date(today.startTime) : new Date();
    const d = new Date(base);
    d.setHours(hh, mm, 0, 0);
    return d.getTime();
  }

  // ---------- load ----------
  async function load(){
    tasks = (await sGet('daychain:tasks')) || DEFAULT_TASKS_BY_ROUTINE[currentRoutine].map(t=>({...t}));
    settings = (await sGet('daychain:settings')) || {...DEFAULT_SETTINGS_BY_ROUTINE[currentRoutine]};
    const savedToday = await sGet('daychain:today');
    // The night routine stays "in progress" across midnight; morning still
    // only resumes if it was started earlier the same calendar day.
    const sameDayRequired = currentRoutine !== 'night';
    if(savedToday && savedToday.status === 'active' && (!sameDayRequired || savedToday.dateStr === todayStr())){
      today = savedToday;
    } else {
      today = null;
    }
    document.getElementById('dateLabel').textContent =
      new Date().toLocaleDateString(undefined, {weekday:'long', month:'short', day:'numeric'});
  }

  function applyRoutineCopy(){
    const copy = ROUTINE_COPY[currentRoutine];
    document.getElementById('targetTimeLabel').textContent = copy.targetLabel;
    document.getElementById('startBtn').textContent = copy.startBtn;
    document.getElementById('heroEyebrow').textContent = copy.eyebrow;
    document.getElementById('summaryLabel').textContent = copy.summaryLabel;
  }

  // ---------- WAKE LOCK ----------
  // Keeps the screen on while a routine is actively running, the same way a
  // video keeps the screen awake during playback. Only requested while the
  // active screen is showing, and released the moment it isn't — the browser
  // also force-releases it whenever the tab is hidden (app backgrounded,
  // screen locked), so it's re-requested on visibilitychange if a routine is
  // still active when the tab comes back.
  let wakeLock = null;

  async function requestWakeLock(){
    if(!('wakeLock' in navigator) || wakeLock) return;
    try{
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', ()=>{ wakeLock = null; });
    }catch(e){
      console.error('wake lock request failed', e);
    }
  }
  async function releaseWakeLock(){
    if(!wakeLock) return;
    const lock = wakeLock;
    wakeLock = null;
    try{ await lock.release(); }catch(e){}
  }
  document.addEventListener('visibilitychange', ()=>{
    if(document.visibilityState === 'visible' && today && today.status === 'active'){
      requestWakeLock();
    }
  });

  // ---------- render router ----------
  function showScreen(id){
    ['screen-setup','screen-active','screen-summary','screen-history'].forEach(s=>{
      document.getElementById(s).hidden = (s !== id);
    });
  }

  function renderAll(){
    applyRoutineCopy();
    if(today && today.status === 'active'){
      renderActive();
      showScreen('screen-active');
      if(!tickHandle) tickHandle = setInterval(renderActive, 1000);
      requestWakeLock();
    } else if(today && today.status === 'summary'){
      renderSummary();
      showScreen('screen-summary');
      if(tickHandle){ clearInterval(tickHandle); tickHandle = null; }
      releaseWakeLock();
    } else {
      renderSetup();
      showScreen('screen-setup');
      if(tickHandle){ clearInterval(tickHandle); tickHandle = null; }
      releaseWakeLock();
    }
  }

  // ---------- SETUP screen ----------
  function renderSetup(){
    const list = document.getElementById('taskEditList');
    list.innerHTML = '';
    tasks.forEach((t, idx) => {
      const li = document.createElement('li');
      li.className = 'task-row';
      li.innerHTML = `
        <input type="text" value="${escapeAttr(t.name)}" data-idx="${idx}" class="name-input">
        <input type="number" min="1" value="${t.baseEst}" data-idx="${idx}" class="min-input">
        <span class="unit">min</span>
        <button class="icon-btn up-btn" data-idx="${idx}" ${idx===0?'disabled style="opacity:.25"':''}>↑</button>
        <button class="icon-btn down-btn" data-idx="${idx}" ${idx===tasks.length-1?'disabled style="opacity:.25"':''}>↓</button>
        <button class="icon-btn remove-btn" data-idx="${idx}">✕</button>
      `;
      list.appendChild(li);
    });

    list.querySelectorAll('.name-input').forEach(inp=>{
      inp.addEventListener('input', e=>{
        tasks[+e.target.dataset.idx].name = e.target.value;
        updateSetupPreview();
      });
      inp.addEventListener('blur', persistTasks);
    });
    list.querySelectorAll('.min-input').forEach(inp=>{
      inp.addEventListener('input', e=>{
        const v = Math.max(1, parseInt(e.target.value)||1);
        tasks[+e.target.dataset.idx].baseEst = v;
        updateSetupPreview();
      });
      inp.addEventListener('blur', persistTasks);
    });
    list.querySelectorAll('.up-btn').forEach(b=>b.addEventListener('click', e=>{
      const i = +e.target.dataset.idx;
      if(i>0){ [tasks[i-1],tasks[i]] = [tasks[i],tasks[i-1]]; persistTasks(); renderSetup(); }
    }));
    list.querySelectorAll('.down-btn').forEach(b=>b.addEventListener('click', e=>{
      const i = +e.target.dataset.idx;
      if(i<tasks.length-1){ [tasks[i+1],tasks[i]] = [tasks[i],tasks[i+1]]; persistTasks(); renderSetup(); }
    }));
    list.querySelectorAll('.remove-btn').forEach(b=>b.addEventListener('click', e=>{
      const i = +e.target.dataset.idx;
      tasks.splice(i,1);
      persistTasks(); renderSetup();
    }));

    document.getElementById('targetTimeInput').value = settings.targetTime;
    updateSetupPreview();
  }

  function updateSetupPreview(){
    const totalMin = tasks.reduce((sum,t)=> sum + plannedMinFor(t), 0);
    const now = Date.now();
    const finish = now + totalMin*60000;
    document.getElementById('setupPreview').innerHTML =
      `If you start right now, you'd finish around <b>${fmtClock(finish)}</b>.`;
    document.getElementById('setupTotal').textContent =
      `Total routine: ${Math.round(totalMin)} min across ${tasks.length} step${tasks.length===1?'':'s'}`;

    const startByMs = targetMsForToday() - totalMin*60000;
    document.getElementById('startByPreview').innerHTML =
      `Start by <b>${fmtClock(startByMs)}</b> to hit your target.`;
  }

  function escapeAttr(s){ return String(s).replace(/"/g,'&quot;'); }

  async function persistTasks(){ await sSet('daychain:tasks', tasks); }
  async function persistSettings(){ await sSet('daychain:settings', settings); }
  async function persistToday(){ await sSet('daychain:today', today); }

  document.getElementById('addTaskBtn').addEventListener('click', ()=>{
    tasks.push({id: uid(), name:'New step', baseEst:10});
    persistTasks(); renderSetup();
  });
  document.getElementById('targetTimeInput').addEventListener('change', e=>{
    settings.targetTime = e.target.value;
    persistSettings(); updateSetupPreview();
  });
  document.getElementById('startBtn').addEventListener('click', async ()=>{
    if(tasks.length === 0){ alert('Add at least one step before starting.'); return; }
    const now = Date.now();
    const baselineFinish = now + tasks.reduce((s,t)=>s+plannedMinFor(t),0)*60000;
    today = {
      dateStr: todayStr(),
      status: 'active',
      startTime: now,
      currentIndex: 0,
      currentTaskStart: now,
      baselineFinish: baselineFinish,
      completedLog: []
    };
    await persistToday();
    renderAll();
  });

  // ---------- ACTIVE screen ----------
  function renderActive(){
    const now = Date.now();
    const idx = today.currentIndex;

    // build projections
    const inRoutine = idx < tasks.length;
    const currentTask = inRoutine ? tasks[idx] : null;
    const currentElapsedMs = inRoutine ? (now - today.currentTaskStart) : 0;
    const remaining = inRoutine ? tasks.slice(idx+1) : [];
    const remainingEstMs = remaining.reduce((s,t)=> s + plannedMinFor(t)*60000, 0);
    // Time still owed on the CURRENT step: its full planned duration until you've
    // actually used it up, then zero (at which point overrun shows up naturally
    // because "now" itself has moved past the plan).
    const currentRemainingMs = inRoutine
      ? Math.max(0, plannedMinFor(currentTask)*60000 - currentElapsedMs)
      : 0;
    const projectedFinishMs = now + currentRemainingMs + remainingEstMs;

    document.getElementById('projectedTime').textContent = fmtClock(projectedFinishMs);

    const target = targetMsForToday();
    const deltaMin = Math.round((projectedFinishMs - target)/60000);
    const badge = document.getElementById('deltaBadge');
    if(Math.abs(deltaMin) <= 1){
      badge.textContent = `Right on your ${settings.targetTime} target`;
      badge.className = 'delta-badge onpace';
    } else if(deltaMin > 0){
      badge.textContent = `${deltaMin} min after your ${settings.targetTime} target`;
      badge.className = 'delta-badge behind';
    } else {
      badge.textContent = `${Math.abs(deltaMin)} min ahead of your ${settings.targetTime} target`;
      badge.className = 'delta-badge ahead';
    }

    if(inRoutine){
      document.getElementById('currentTaskName').textContent = currentTask.name;
      document.getElementById('currentElapsed').textContent = fmtMMSS(currentElapsedMs);
      const plannedMin = plannedMinFor(currentTask);
      document.getElementById('currentPlanned').textContent = `/ ${fmtMMSS(plannedMin*60000)} planned`;
      const over = currentElapsedMs - plannedMin*60000;
      const noteEl = document.getElementById('paceNote');
      if(over > 60000){
        noteEl.textContent = `${Math.round(over/60000)} min over — the rest of your chain will shift.`;
        noteEl.className = 'pace-note over';
      } else if(over < -60000){
        noteEl.textContent = `${Math.round(-over/60000)} min ahead of plan on this step.`;
        noteEl.className = 'pace-note under';
      } else {
        noteEl.textContent = `On pace for this step.`;
        noteEl.className = 'pace-note';
      }
    }

    // upcoming list with live-computed clock times
    const upcomingList = document.getElementById('upcomingList');
    upcomingList.innerHTML = '';
    let cursor = now + currentRemainingMs;
    if(remaining.length === 0){
      const li = document.createElement('li');
      li.className = 'chain-item';
      li.innerHTML = `<span class="name">Nothing left — this is your last step</span>`;
      upcomingList.appendChild(li);
    } else {
      remaining.forEach(t=>{
        const est = plannedMinFor(t);
        const li = document.createElement('li');
        li.className = 'chain-item';
        li.innerHTML = `<span class="name">${escapeAttr(t.name)}</span><span class="time">~${Math.round(est)} min · by ${fmtClock(cursor+est*60000)}</span>`;
        upcomingList.appendChild(li);
        cursor += est*60000;
      });
    }

    // completed list
    const completedCard = document.getElementById('completedCard');
    const completedList = document.getElementById('completedList');
    if(today.completedLog.length){
      completedCard.hidden = false;
      completedList.innerHTML = '';
      today.completedLog.forEach(e=>{
        const li = document.createElement('li');
        li.className = 'completed-item';
        if(e.skipped){
          li.innerHTML = `<span class="name">${escapeAttr(e.name)}</span><span class="diff even" style="font-style:italic;">skipped</span>`;
        } else {
          const diff = Math.round(e.actualMin - e.plannedMin);
          const cls = diff > 0 ? 'over' : (diff < 0 ? 'under' : 'even');
          const diffText = diff === 0 ? 'on plan' : (diff > 0 ? `+${diff} min` : `${diff} min`);
          li.innerHTML = `<span class="name">${escapeAttr(e.name)}</span><span class="diff ${cls}">${diffText}</span>`;
        }
        completedList.appendChild(li);
      });
    } else {
      completedCard.hidden = true;
    }

    if(!inRoutine){
      finishRoutine();
    }
  }

  async function markDone(skip){
    const now = Date.now();
    const idx = today.currentIndex;
    if(idx >= tasks.length) return;
    const task = tasks[idx];
    const actualMin = Math.max(0, (now - today.currentTaskStart)/60000);
    const plannedMin = plannedMinFor(task);

    if(!skip){
      today.completedLog.push({ taskId: task.id, name: task.name, actualMin, plannedMin, skipped:false });
    } else {
      today.completedLog.push({ taskId: task.id, name: task.name, actualMin: 0, plannedMin, skipped:true });
    }

    today.currentIndex += 1;
    today.currentTaskStart = now;
    await persistToday();
    renderActive();
  }

  document.getElementById('doneBtn').addEventListener('click', ()=> markDone(false));
  document.getElementById('skipBtn').addEventListener('click', ()=> markDone(true));
  document.getElementById('endBtn').addEventListener('click', ()=> finishRoutine());
  document.getElementById('settingsBtn').addEventListener('click', async ()=>{
    if(today && today.status === 'active'){
      const ok = confirm('Editing your steps will end the current routine. Continue?');
      if(!ok) return;
      today.status = null;
      await sSet('daychain:today', null);
      today = null;
    }
    renderAll();
  });

  async function finishRoutine(){
    if(!today || today.status !== 'active') return;
    today.status = 'summary';
    today.finishTime = Date.now();
    await persistToday();

    const days = (await sGet('daychain:days')) || [];
    days.unshift({
      dateStr: today.dateStr,
      startTime: today.startTime,
      finishTime: today.finishTime,
      entries: today.completedLog.map(e => ({
        taskId: e.taskId, name: e.name, plannedMin: e.plannedMin,
        actualMin: e.actualMin, skipped: !!e.skipped
      }))
    });
    if(days.length > 60) days.length = 60;
    await sSet('daychain:days', days);

    renderAll();
  }

  // ---------- SUMMARY screen ----------
  function renderSummary(){
    const finish = today.finishTime || Date.now();
    document.getElementById('summaryFinish').textContent = fmtClock(finish);
    const target = targetMsForToday();
    const deltaMin = Math.round((finish - target)/60000);
    document.getElementById('summaryVsTarget').innerHTML =
      deltaMin === 0 ? `Right on your ${settings.targetTime} target.` :
      deltaMin > 0 ? `${deltaMin} min after your <b>${settings.targetTime}</b> target.` :
      `${Math.abs(deltaMin)} min ahead of your <b>${settings.targetTime}</b> target.`;

    const table = document.getElementById('summaryTable');
    table.innerHTML = '';
    today.completedLog.forEach(e=>{
      const row = document.createElement('tr');
      if(e.skipped){
        row.innerHTML = `<td>${escapeAttr(e.name)}</td><td style="font-style:italic;">skipped</td>`;
      } else {
        const diff = Math.round(e.actualMin - e.plannedMin);
        const diffText = diff === 0 ? 'on plan' : (diff > 0 ? `+${diff}m` : `${diff}m`);
        row.innerHTML = `<td>${escapeAttr(e.name)}</td><td>${Math.round(e.actualMin)}m actual · ${Math.round(e.plannedMin)}m planned · ${diffText}</td>`;
      }
      table.appendChild(row);
    });
  }

  document.getElementById('newDayBtn').addEventListener('click', async ()=>{
    today = null;
    await sSet('daychain:today', null);
    renderAll();
  });

  // ---------- HISTORY screen ----------
  document.getElementById('historyBtn').addEventListener('click', async ()=>{
    await renderHistory();
    showScreen('screen-history');
  });
  document.getElementById('historyBackBtn').addEventListener('click', ()=>{
    renderAll();
  });

  const MAX_HISTORY_COLUMNS = 14;

  async function renderHistory(){
    const allDays = (await sGet('daychain:days')) || [];
    const days = allDays.slice(0, MAX_HISTORY_COLUMNS);
    const container = document.getElementById('historyContent');

    if(allDays.length === 0){
      container.innerHTML = `<div class="hist-empty">No finished routines yet — this fills in after you complete your first one.</div>`;
      return;
    }

    // Build row order: current tasks first (in their current order), then any
    // historical steps that no longer exist in the current list, in the order
    // they were first encountered. Scanned across ALL stored days (not just
    // the displayed columns) so low/high/avg reflect full history.
    const rowKeys = tasks.map(t => ({ taskId: t.id, label: t.name }));
    const knownIds = new Set(rowKeys.map(r => r.taskId));
    allDays.forEach(day => {
      day.entries.forEach(e => {
        if(!knownIds.has(e.taskId)){
          knownIds.add(e.taskId);
          rowKeys.push({ taskId: e.taskId, label: e.name });
        }
      });
    });

    let html = `<div class="hist-wrap"><table class="hist-table"><thead><tr><th>Step</th>`;
    days.forEach(day => {
      const label = new Date(day.startTime).toLocaleDateString(undefined, {month:'short', day:'numeric'});
      html += `<th>${escapeAttr(label)}</th>`;
    });
    html += `<th class="stat-sep">Low</th><th>High</th><th>Avg</th>`;
    html += `</tr></thead><tbody>`;

    html += `<tr class="hist-meta-row"><td>Start</td>`;
    days.forEach(day => { html += `<td>${fmtClock(day.startTime)}</td>`; });
    html += `<td class="stat-sep"></td><td></td><td></td></tr>`;
    html += `<tr class="hist-meta-row"><td>Finish</td>`;
    days.forEach(day => { html += `<td>${fmtClock(day.finishTime)}</td>`; });
    html += `<td class="stat-sep"></td><td></td><td></td></tr>`;

    rowKeys.forEach(rk => {
      html += `<tr><td>${escapeAttr(rk.label)}</td>`;
      days.forEach(day => {
        const entry = day.entries.find(e => e.taskId === rk.taskId);
        if(!entry){
          html += `<td class="hist-cell na">–</td>`;
        } else if(entry.skipped){
          html += `<td class="hist-cell skip">skip</td>`;
        } else {
          const diff = Math.round(entry.actualMin - entry.plannedMin);
          const cls = diff > 0 ? 'over' : (diff < 0 ? 'under' : 'even');
          html += `<td class="hist-cell ${cls}">${Math.round(entry.actualMin)}/${Math.round(entry.plannedMin)}</td>`;
        }
      });

      const durations = allDays
        .map(day => day.entries.find(e => e.taskId === rk.taskId))
        .filter(e => e && !e.skipped)
        .map(e => e.actualMin);
      if(durations.length){
        const low = Math.round(Math.min(...durations));
        const high = Math.round(Math.max(...durations));
        const avg = Math.round(durations.reduce((a,b)=>a+b,0) / durations.length);
        html += `<td class="hist-cell stat-sep">${low}</td><td class="hist-cell">${high}</td><td class="hist-cell">${avg}</td>`;
      } else {
        html += `<td class="hist-cell na stat-sep">–</td><td class="hist-cell na">–</td><td class="hist-cell na">–</td>`;
      }
      html += `</tr>`;
    });

    html += `</tbody></table></div>`;
    html += `<div class="hist-note">Each cell reads actual&nbsp;/&nbsp;planned minutes — red means over, green means under. Low/High/Avg are actual minutes across your full stored history (up to 60 days), not just the days shown here. Most recent day on the left.</div>`;
    container.innerHTML = html;
  }

  // ---------- AUTH ----------
  function setSigninError(msg){
    const el = document.getElementById('signinError');
    if(msg){ el.textContent = msg; el.hidden = false; }
    else { el.hidden = true; el.textContent = ''; }
  }

  document.getElementById('googleSigninBtn').addEventListener('click', async ()=>{
    setSigninError(null);
    const provider = new firebase.auth.GoogleAuthProvider();
    try{
      // signInWithRedirect was tried here for mobile, but Safari's
      // cross-site-tracking protection blocks it from picking up the auth
      // result on return (our authDomain, day-chain.firebaseapp.com, is a
      // different origin than where this app is hosted). signInWithPopup
      // talks to the popup window directly while it's open instead of
      // relying on storage that survives a full-page redirect, so it works
      // on both desktop and mobile Safari here.
      await auth.signInWithPopup(provider);
    }catch(e){
      console.error('sign-in failed', e);
      setSigninError('Sign-in failed. Please try again.');
    }
  });

  // ---------- ROUTINE SWITCH ----------
  function updateRoutineSwitchUI(){
    document.getElementById('tabMorning').classList.toggle('active', currentRoutine === 'morning');
    document.getElementById('tabNight').classList.toggle('active', currentRoutine === 'night');
  }

  document.getElementById('routineSwitch').addEventListener('click', async (e)=>{
    const btn = e.target.closest('.routine-tab');
    if(!btn || btn.dataset.routine === currentRoutine) return;
    currentRoutine = btn.dataset.routine;
    updateRoutineSwitchUI();
    // "activeRoutine" is doc-level metadata (which routine to show), not
    // per-routine data, so it's written directly rather than through
    // sSet/fieldNameForKey.
    docCache.activeRoutine = currentRoutine;
    docRef.set({ activeRoutine: currentRoutine }, { merge: true }).catch(e=>console.error('save active routine failed', e));
    await load();
    renderAll();
  });

  auth.onAuthStateChanged(async (user)=>{
    if(user){
      docRef = db.collection('users').doc(user.uid).collection('appdata').doc('daychain');
      const snap = await docRef.get();
      docCache = snap.exists ? snap.data() : {};
      currentRoutine = (docCache.activeRoutine === 'night') ? 'night' : 'morning';
      updateRoutineSwitchUI();

      document.getElementById('screen-signin').hidden = true;
      document.getElementById('appShell').hidden = false;

      await load();
      renderAll();
    } else {
      docRef = null;
      docCache = null;
      if(tickHandle){ clearInterval(tickHandle); tickHandle = null; }
      releaseWakeLock();

      document.getElementById('appShell').hidden = true;
      document.getElementById('screen-signin').hidden = false;
    }
  });

})();
