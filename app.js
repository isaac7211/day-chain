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

  // ---------- data model ----------
  // Every routine lives in the `routines` array (one Firestore field on the
  // single per-user doc): { id, name, targetLabel, targetTime, tasks, today, days }.
  // `tasks`/`settings`/`routineName`/`today` below are a "working copy" of
  // whichever routine is currently open (activeRoutineId) — kept in sync with
  // its entry in `routines` on load/save. This lets renderSetup/renderActive/
  // renderSummary/markDone/finishRoutine read/write them exactly as before;
  // only the load/save/navigation layer needed to change for multi-routine
  // support.
  let routines = [];
  let activeRoutineId = null;
  let tasks = [];
  let settings = { targetTime: '', targetLabel: '' };
  let routineName = '';
  let today = null; // active routine state
  let tickHandle = null;
  let deleteRoutineState = 'idle'; // 'idle' | 'confirm'

  // ---------- storage helpers (Firestore, one doc per signed-in user) ----------
  // docRef/docCache are only ever set after auth resolves (see the
  // onAuthStateChanged handler at the bottom), so nothing here can run before
  // sign-in completes — the app UI itself stays hidden until then too.
  let docRef = null;
  let docCache = null;

  function getActiveRoutine(){
    return routines.find(r => r.id === activeRoutineId) || null;
  }

  function loadWorkingStateFrom(r){
    activeRoutineId = r.id;
    tasks = r.tasks;
    settings = { targetTime: r.targetTime, targetLabel: r.targetLabel };
    routineName = r.name;
    today = r.today;
  }

  async function persistRoutines(){
    if(!docRef) return;
    docCache.routines = routines;
    try{ await docRef.set({ routines }, { merge: true }); }
    catch(e){ console.error('firestore set failed', 'routines', e); }
  }
  async function persistActiveRoutineId(){
    if(!docRef) return;
    docCache.activeRoutineId = activeRoutineId;
    try{ await docRef.set({ activeRoutineId }, { merge: true }); }
    catch(e){ console.error('firestore set failed', 'activeRoutineId', e); }
  }
  // Writes the working copy (tasks/settings/name/today) back into the open
  // routine's entry in `routines`, then persists the whole array.
  async function saveActiveRoutine(){
    const r = getActiveRoutine();
    if(!r) return;
    r.tasks = tasks;
    r.targetTime = settings.targetTime;
    r.targetLabel = settings.targetLabel;
    r.name = routineName;
    r.today = today;
    await persistRoutines();
  }

  // iOS Safari won't apply :active styles on a quick tap unless some element
  // on the page has a touchstart listener — this is that listener. It does
  // nothing itself; its only job is to make CSS :active (tap feedback on
  // buttons) actually show up on iPhone.
  document.addEventListener('touchstart', function(){}, { passive: true });

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
    const [hh,mm] = (settings.targetTime || '09:00').split(':').map(Number);
    // Anchor to the calendar day the active routine started, not "right
    // now" — a routine can still be running past midnight, and its target
    // belongs to the evening/morning it began, not to the new date.
    const base = (today && today.startTime) ? new Date(today.startTime) : new Date();
    const d = new Date(base);
    d.setHours(hh, mm, 0, 0);
    return d.getTime();
  }
  function escapeAttr(s){ return String(s).replace(/"/g,'&quot;'); }
  // Compact "Np" annotation for a step's paused time, wherever its actual
  // time is already shown — blank when there was no pause, so unpaused
  // steps look exactly as they always have.
  function pauseSuffix(pausedMin){
    const m = Math.round(pausedMin || 0);
    return m > 0 ? ` · ${m}p` : '';
  }
  function updateDateLabel(){
    document.getElementById('dateLabel').textContent =
      new Date().toLocaleDateString(undefined, {weekday:'long', month:'short', day:'numeric'});
  }

  // ---------- ONE-TIME MIGRATION ----------
  // Pre-multi-routine data lived as flat fields on the doc: tasks/settings/
  // today/days for the old "morning" routine, night_tasks/night_settings/
  // night_today/night_days for "night", plus activeRoutine ('morning'|
  // 'night'). If `routines` doesn't exist yet, build it from whatever of
  // those fields are present. Old fields are left in place, untouched —
  // this only ever reads them, never deletes them.
  function buildRoutineFromLegacyFields(prefix, name, targetLabel, defaultTargetTime){
    const legacyTasks = docCache[prefix + 'tasks'];
    const legacySettings = docCache[prefix + 'settings'];
    const legacyToday = docCache[prefix + 'today'];
    const legacyDays = docCache[prefix + 'days'] || [];
    const hasLegacyData = !!(legacyTasks || legacySettings || legacyToday || legacyDays.length);
    if(!hasLegacyData) return null;
    const id = uid();
    const days = legacyDays.map(d => ({ ...d, routineId: id, routineName: name }));
    return {
      id, name, targetLabel,
      targetTime: (legacySettings && legacySettings.targetTime) || defaultTargetTime,
      tasks: legacyTasks || [],
      today: legacyToday || null,
      days
    };
  }

  function migrateLegacyDataIfNeeded(){
    if(docCache.routines) return false; // already migrated (or a fresh routines list)
    const built = [];
    const morning = buildRoutineFromLegacyFields('', 'Morning Workout Routine', 'Work start', '11:00');
    if(morning) built.push(morning);
    const night = buildRoutineFromLegacyFields('night_', 'Evening Routine', 'Lights out', '22:30');
    if(night) built.push(night);
    routines = built;
    const preferred = docCache.activeRoutine === 'night' ? night : morning;
    activeRoutineId = (preferred || routines[0] || {}).id || null;
    docCache.routines = routines;
    docCache.activeRoutineId = activeRoutineId;
    return true; // caller needs to write this back
  }

  // ---------- KEEP AWAKE (Wake Lock API, silent-video fallback for iOS) ----------
  // The previous version only called navigator.wakeLock.request() from
  // inside renderAll(), reached via `await persistTasks(); renderAll();` in
  // the Start button's handler. By the time that ran, the await had already
  // broken the "user gesture" context WebKit checks for this API, so the
  // request silently failed every time (confirmed via console: NotAllowedError).
  //
  // Fix: both mechanisms below are invoked SYNCHRONOUSLY, as literally the
  // first thing the Start button's click handler does, before any other
  // await — that's what a gesture-gated API actually needs. Native Wake
  // Lock is tried first; a silent looping <video> (muted, loop, playsinline
  // — all required or iOS silently no-ops or fullscreens it) is started in
  // parallel as a fallback and paused if the native lock succeeds. Both
  // read/write the same `keepAwakeMode` so the UI can report which one is
  // actually holding the screen open.
  let wakeLock = null;
  let keepAwakeVideo = null;
  let keepAwakeMode = null; // 'wakelock' | 'video' | 'failed' | null

  function ensureKeepAwakeVideoEl(){
    if(keepAwakeVideo) return keepAwakeVideo;
    const v = document.createElement('video');
    v.src = 'keepawake.mp4';
    v.setAttribute('playsinline', '');
    v.setAttribute('webkit-playsinline', '');
    v.muted = true;
    v.defaultMuted = true;
    v.loop = true;
    v.setAttribute('aria-hidden', 'true');
    v.style.cssText = 'position:fixed; top:0; left:0; width:1px; height:1px; opacity:0; pointer-events:none;';
    document.body.appendChild(v);
    keepAwakeVideo = v;
    return v;
  }

  function updateKeepAwakeIndicator(){
    const el = document.getElementById('keepAwakeStatus');
    if(!el) return;
    if(keepAwakeMode === 'wakelock'){
      el.textContent = 'Screen staying awake · Wake Lock API';
      el.hidden = false;
    } else if(keepAwakeMode === 'video'){
      el.textContent = 'Screen staying awake · video fallback';
      el.hidden = false;
    } else if(keepAwakeMode === 'failed'){
      el.textContent = 'Couldn’t keep the screen awake on this device';
      el.hidden = false;
    } else {
      el.hidden = true;
    }
  }

  // Call this SYNCHRONOUSLY from inside a click handler, before any await —
  // that's the only way iOS reliably grants either mechanism below.
  function engageKeepAwakeFromGesture(){
    let wakeLockPromise = null;
    if('wakeLock' in navigator){
      try{ wakeLockPromise = navigator.wakeLock.request('screen'); }
      catch(e){ wakeLockPromise = Promise.reject(e); }
    }

    const video = ensureKeepAwakeVideoEl();
    const videoPlayPromise = Promise.resolve(video.play()).then(
      () => true,
      e => { console.warn('[keep-awake] video fallback failed to start', e); return false; }
    );

    if(wakeLockPromise){
      wakeLockPromise.then(lock=>{
        wakeLock = lock;
        keepAwakeMode = 'wakelock';
        wakeLock.addEventListener('release', ()=>{
          wakeLock = null;
          if(keepAwakeMode === 'wakelock') keepAwakeMode = null;
          updateKeepAwakeIndicator();
        });
        console.log('[keep-awake] engaged via native Wake Lock API');
        video.pause(); // native lock is enough; the fallback isn't needed
        updateKeepAwakeIndicator();
      }).catch(async e=>{
        console.warn('[keep-awake] native Wake Lock unavailable/denied — falling back to video', e);
        const playing = await videoPlayPromise;
        keepAwakeMode = playing ? 'video' : 'failed';
        if(keepAwakeMode === 'video') console.log('[keep-awake] engaged via silent video fallback');
        else console.error('[keep-awake] both mechanisms failed — screen may still auto-lock');
        updateKeepAwakeIndicator();
      });
    } else {
      console.log('[keep-awake] Wake Lock API not supported here — using video fallback');
      videoPlayPromise.then(playing=>{
        keepAwakeMode = playing ? 'video' : 'failed';
        if(keepAwakeMode === 'video') console.log('[keep-awake] engaged via silent video fallback');
        else console.error('[keep-awake] video fallback failed too — screen may still auto-lock');
        updateKeepAwakeIndicator();
      });
    }
  }

  async function releaseKeepAwake(){
    if(wakeLock){
      const lock = wakeLock;
      wakeLock = null;
      try{ await lock.release(); }catch(e){}
    }
    if(keepAwakeVideo && !keepAwakeVideo.paused){
      keepAwakeVideo.pause();
    }
    keepAwakeMode = null;
    updateKeepAwakeIndicator();
  }

  // Both mechanisms are force-stopped by the OS whenever the tab is
  // backgrounded (wake locks are always released; video playback is
  // paused). Re-engage whichever is relevant once the tab is visible again
  // — this does NOT need a fresh user gesture: re-acquiring a wake lock on
  // visibilitychange is the documented pattern for this API, and resuming
  // a video that already played once from a real gesture earlier in the
  // page's lifetime is allowed without another gesture.
  document.addEventListener('visibilitychange', ()=>{
    if(document.visibilityState !== 'visible') return;
    if(!(today && today.status === 'active')) return;
    if('wakeLock' in navigator){
      navigator.wakeLock.request('screen').then(lock=>{
        wakeLock = lock;
        keepAwakeMode = 'wakelock';
        wakeLock.addEventListener('release', ()=>{
          wakeLock = null;
          if(keepAwakeMode === 'wakelock') keepAwakeMode = null;
          updateKeepAwakeIndicator();
        });
        if(keepAwakeVideo && !keepAwakeVideo.paused) keepAwakeVideo.pause();
        updateKeepAwakeIndicator();
      }).catch(()=>{
        if(keepAwakeVideo && keepAwakeVideo.paused){
          keepAwakeVideo.play().then(()=>{
            keepAwakeMode = 'video';
            updateKeepAwakeIndicator();
          }).catch(e=>console.warn('[keep-awake] resume video failed', e));
        }
      });
    } else if(keepAwakeVideo && keepAwakeVideo.paused){
      keepAwakeVideo.play().then(()=>{
        keepAwakeMode = 'video';
        updateKeepAwakeIndicator();
      }).catch(e=>console.warn('[keep-awake] resume video failed', e));
    }
  });

  // ---------- render router ----------
  function showScreen(id){
    ['screen-routines','screen-setup','screen-active','screen-summary','screen-history'].forEach(s=>{
      document.getElementById(s).hidden = (s !== id);
    });
    // The header's "Edit" pill only makes sense once a specific routine is
    // open and not already being edited.
    document.getElementById('settingsBtn').hidden = (id === 'screen-routines' || id === 'screen-setup');
  }

  function renderAll(){
    if(!activeRoutineId){ showRoutineList(); return; }
    applyRoutineHeroCopy();
    if(today && today.status === 'active'){
      renderActive();
      showScreen('screen-active');
      if(!tickHandle) tickHandle = setInterval(renderActive, 1000);
      // Deliberately NOT engaging keep-awake here: this branch also runs on
      // page load/resume, which isn't a user gesture, so the request would
      // just fail. Engagement happens once, synchronously, from the Start
      // button's own click handler — see engageKeepAwakeFromGesture().
    } else if(today && today.status === 'summary'){
      renderSummary();
      showScreen('screen-summary');
      if(tickHandle){ clearInterval(tickHandle); tickHandle = null; }
      releaseKeepAwake();
    } else {
      renderSetup();
      showScreen('screen-setup');
      if(tickHandle){ clearInterval(tickHandle); tickHandle = null; }
      releaseKeepAwake();
    }
  }

  function applyRoutineHeroCopy(){
    document.getElementById('heroEyebrow').textContent = `Projected ${settings.targetLabel || 'target'}`;
    document.getElementById('summaryLabel').textContent = routineName || 'Summary';
  }

  // ---------- ROUTINE LIST screen ----------
  function routineSortKey(r){
    if(r.today && r.today.startTime) return r.today.startTime;
    if(r.days && r.days.length) return r.days[0].startTime;
    return 0;
  }

  function showRoutineList(){
    if(tickHandle){ clearInterval(tickHandle); tickHandle = null; }
    releaseKeepAwake();
    activeRoutineId = null;
    document.getElementById('newRoutineChooser').hidden = true;
    renderRoutineList();
    showScreen('screen-routines');
  }

  function renderRoutineList(){
    const list = document.getElementById('routineList');
    list.innerHTML = '';
    const sorted = [...routines].sort((a,b) => routineSortKey(b) - routineSortKey(a));
    if(sorted.length === 0){
      const li = document.createElement('li');
      li.className = 'hist-empty';
      li.textContent = 'No routines yet — create your first one below.';
      list.appendChild(li);
    }
    sorted.forEach(r => {
      const total = r.tasks.reduce((s,t) => s + t.baseEst, 0);
      const li = document.createElement('li');
      li.className = 'routine-list-item';
      li.innerHTML = `<span class="name">${escapeAttr(r.name)}</span><span class="time">${Math.round(total)} min</span>`;
      li.addEventListener('click', () => openRoutine(r.id));
      list.appendChild(li);
    });
    renderDuplicateChooserList();
  }

  function duplicateRoutineObj(src){
    return {
      id: uid(),
      name: src.name + ' copy',
      targetLabel: src.targetLabel,
      targetTime: src.targetTime,
      tasks: src.tasks.map(t => ({ id: uid(), name: t.name, baseEst: t.baseEst })),
      today: null,
      days: []
    };
  }
  function createBlankRoutineObj(){
    return { id: uid(), name: 'New routine', targetLabel: 'Target time', targetTime: '09:00', tasks: [], today: null, days: [] };
  }
  async function addRoutineAndOpen(r){
    routines.push(r);
    await persistRoutines();
    openRoutine(r.id);
  }

  function renderDuplicateChooserList(){
    const list = document.getElementById('duplicateChooserList');
    list.innerHTML = '';
    routines.forEach(r => {
      const li = document.createElement('li');
      li.className = 'routine-list-item';
      li.innerHTML = `<span class="name">${escapeAttr(r.name)}</span>`;
      li.addEventListener('click', () => addRoutineAndOpen(duplicateRoutineObj(r)));
      list.appendChild(li);
    });
  }

  document.getElementById('newRoutineBtn').addEventListener('click', () => {
    const chooser = document.getElementById('newRoutineChooser');
    chooser.hidden = !chooser.hidden;
  });
  document.getElementById('newRoutineBlankBtn').addEventListener('click', () => {
    addRoutineAndOpen(createBlankRoutineObj());
  });

  function openRoutine(id){
    const r = routines.find(x => x.id === id);
    if(!r) return;
    loadWorkingStateFrom(r);
    deleteRoutineState = 'idle';
    persistActiveRoutineId();
    renderAll();
  }
  document.getElementById('backToRoutinesBtn').addEventListener('click', () => {
    showRoutineList();
  });

  // ---------- SETUP screen ----------
  function renderSetup(){
    document.getElementById('routineNameInput').value = routineName;
    document.getElementById('targetLabelInput').value = settings.targetLabel;

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
    renderDeleteRoutineSection();
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

  async function persistTasks(){ await saveActiveRoutine(); }

  document.getElementById('routineNameInput').addEventListener('input', e=>{
    routineName = e.target.value;
  });
  document.getElementById('routineNameInput').addEventListener('blur', persistTasks);
  document.getElementById('targetLabelInput').addEventListener('input', e=>{
    settings.targetLabel = e.target.value;
  });
  document.getElementById('targetLabelInput').addEventListener('blur', persistTasks);

  document.getElementById('addTaskBtn').addEventListener('click', ()=>{
    tasks.push({id: uid(), name:'New step', baseEst:10});
    persistTasks(); renderSetup();
  });
  document.getElementById('targetTimeInput').addEventListener('change', e=>{
    settings.targetTime = e.target.value;
    persistTasks(); updateSetupPreview();
  });
  document.getElementById('startBtn').addEventListener('click', async ()=>{
    if(tasks.length === 0){ alert('Add at least one step before starting.'); return; }
    // Must happen synchronously, right here, before any await below — this
    // click is the only user gesture we get, and both keep-awake mechanisms
    // need to be invoked while it's still "live" or iOS silently denies them.
    engageKeepAwakeFromGesture();
    const now = Date.now();
    const baselineFinish = now + tasks.reduce((s,t)=>s+plannedMinFor(t),0)*60000;
    today = {
      dateStr: todayStr(),
      status: 'active',
      startTime: now,
      currentIndex: 0,
      currentTaskStart: now,
      pausedAt: null,
      pausedMsTotal: 0,
      baselineFinish: baselineFinish,
      completedLog: []
    };
    await persistTasks();
    renderAll();
  });

  // ---------- ROUTINE MANAGEMENT (duplicate/delete) ----------
  document.getElementById('duplicateRoutineBtn').addEventListener('click', () => {
    const src = getActiveRoutine();
    if(src) addRoutineAndOpen(duplicateRoutineObj(src));
  });
  document.getElementById('deleteRoutineBtn').addEventListener('click', () => {
    deleteRoutineState = 'confirm';
    renderDeleteRoutineSection();
  });
  function renderDeleteRoutineSection(){
    const section = document.getElementById('deleteRoutineConfirm');
    section.innerHTML = '';
    if(deleteRoutineState !== 'confirm'){
      section.hidden = true;
      return;
    }
    section.hidden = false;
    const warning = document.createElement('div');
    warning.className = 'delete-warning';
    warning.textContent = `Delete "${routineName}" and all its history? This can't be undone.`;
    section.appendChild(warning);

    const row = document.createElement('div');
    row.className = 'btn-row';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn-ghost';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', ()=>{ deleteRoutineState = 'idle'; renderDeleteRoutineSection(); });
    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'btn-primary danger-btn';
    confirmBtn.textContent = 'Delete routine';
    confirmBtn.addEventListener('click', deleteActiveRoutine);
    row.appendChild(cancelBtn);
    row.appendChild(confirmBtn);
    section.appendChild(row);
  }
  async function deleteActiveRoutine(){
    const id = activeRoutineId;
    routines = routines.filter(r => r.id !== id);
    deleteRoutineState = 'idle';
    await persistRoutines();
    showRoutineList();
  }

  // Total ms the CURRENT step has been paused, including an in-progress
  // pause (pausedAt set but not yet resumed). Resets to 0 whenever the step
  // changes — see markDone().
  function currentStepPausedMs(){
    let total = (today && today.pausedMsTotal) || 0;
    if(today && today.pausedAt) total += (Date.now() - today.pausedAt);
    return total;
  }

  // ---------- ACTIVE screen ----------
  function renderActive(){
    const now = Date.now();
    const idx = today.currentIndex;

    // build projections
    const inRoutine = idx < tasks.length;
    const currentTask = inRoutine ? tasks[idx] : null;
    // Wall-clock elapsed on the current step — deliberately includes any
    // paused time, and feeds the projection below unchanged. A pause
    // genuinely delays the rest of the day, so the projected finish should
    // keep climbing exactly as if the step were simply running long.
    const currentElapsedMs = inRoutine ? (now - today.currentTaskStart) : 0;
    // Active-only elapsed — wall-clock minus accumulated pause time. This is
    // what the step's OWN displayed timer and pace comparison use, so they
    // freeze while paused instead of racking up "over plan" time that isn't
    // really the step's fault.
    const activeElapsedMs = inRoutine ? Math.max(0, currentElapsedMs - currentStepPausedMs()) : 0;
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
      const isPaused = !!today.pausedAt;
      document.getElementById('currentTaskName').textContent = currentTask.name;
      const elapsedEl = document.getElementById('currentElapsed');
      elapsedEl.textContent = fmtMMSS(activeElapsedMs);
      elapsedEl.classList.toggle('paused', isPaused);
      const plannedMin = plannedMinFor(currentTask);
      document.getElementById('currentPlanned').textContent = `/ ${fmtMMSS(plannedMin*60000)} planned`;
      const noteEl = document.getElementById('paceNote');
      if(isPaused){
        noteEl.textContent = `Paused — ${fmtMMSS(activeElapsedMs)} active so far.`;
        noteEl.className = 'pace-note paused';
      } else {
        const over = activeElapsedMs - plannedMin*60000;
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
      const pauseBtn = document.getElementById('pauseBtn');
      pauseBtn.textContent = isPaused ? 'Resume' : 'Pause';
      pauseBtn.classList.toggle('is-paused', isPaused);
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
          li.innerHTML = `<span class="name">${escapeAttr(e.name)}</span><span class="diff ${cls}">${diffText}${pauseSuffix(e.pausedMin)}</span>`;
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
    const pausedMin = currentStepPausedMs()/60000;
    // Active minutes only — wall-clock time minus whatever was paused, so a
    // 40-minute step with a 10-minute pause logs 30 actual minutes toward
    // this step's rolling average, not 40.
    const actualMin = Math.max(0, (now - today.currentTaskStart)/60000 - pausedMin);
    const plannedMin = plannedMinFor(task);

    if(!skip){
      today.completedLog.push({ taskId: task.id, name: task.name, actualMin, plannedMin, pausedMin, skipped:false });
    } else {
      today.completedLog.push({ taskId: task.id, name: task.name, actualMin: 0, plannedMin, pausedMin: 0, skipped:true });
    }

    today.currentIndex += 1;
    today.currentTaskStart = now;
    today.pausedAt = null;
    today.pausedMsTotal = 0;
    await saveActiveRoutine();
    renderActive();
    // Only flash if there's still a next step showing — renderActive() above
    // may have already moved us on to the summary screen (routine finished),
    // in which case the current-task card isn't visible anymore.
    if(today.status === 'active'){
      const card = document.querySelector('.current-task');
      card.classList.remove('step-advance');
      void card.offsetWidth; // restart the animation even if it's already running
      card.classList.add('step-advance');
    }
  }

  document.getElementById('doneBtn').addEventListener('click', ()=> markDone(false));
  document.getElementById('skipBtn').addEventListener('click', ()=> markDone(true));
  document.getElementById('pauseBtn').addEventListener('click', async ()=>{
    if(!today || today.status !== 'active') return;
    const now = Date.now();
    if(today.pausedAt){
      // Resuming: fold the just-finished pause into the running total.
      today.pausedMsTotal = (today.pausedMsTotal || 0) + (now - today.pausedAt);
      today.pausedAt = null;
    } else {
      today.pausedAt = now;
    }
    await saveActiveRoutine();
    renderActive();
  });
  document.getElementById('endBtn').addEventListener('click', ()=>{
    const ok = confirm('End this routine now? Steps not marked done will be left incomplete.');
    if(!ok) return;
    finishRoutine();
  });
  document.getElementById('settingsBtn').addEventListener('click', async ()=>{
    if(today && today.status === 'active'){
      const ok = confirm('Editing your steps will end the current routine. Continue?');
      if(!ok) return;
    }
    today = null;
    await saveActiveRoutine();
    renderAll();
  });

  async function finishRoutine(){
    if(!today || today.status !== 'active') return;
    today.status = 'summary';
    today.finishTime = Date.now();

    const r = getActiveRoutine();
    const days = r.days || [];
    days.unshift({
      dateStr: today.dateStr,
      startTime: today.startTime,
      finishTime: today.finishTime,
      routineId: r.id,
      routineName: r.name,
      entries: today.completedLog.map(e => ({
        taskId: e.taskId, name: e.name, plannedMin: e.plannedMin,
        actualMin: e.actualMin, pausedMin: e.pausedMin || 0, skipped: !!e.skipped
      }))
    });
    if(days.length > 60) days.length = 60;
    r.days = days;

    await saveActiveRoutine();
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
        row.innerHTML = `<td>${escapeAttr(e.name)}</td><td>${Math.round(e.actualMin)}m actual · ${Math.round(e.plannedMin)}m planned · ${diffText}${pauseSuffix(e.pausedMin)}</td>`;
      }
      table.appendChild(row);
    });
  }

  document.getElementById('newDayBtn').addEventListener('click', async ()=>{
    today = null;
    await saveActiveRoutine();
    renderAll();
  });

  // ---------- HISTORY screen ----------
  const MAX_HISTORY_COLUMNS = 14;

  function routinesWithHistory(){
    return routines.filter(r => r.days && r.days.length > 0);
  }

  function populateHistoryRoutineSelect(){
    const sel = document.getElementById('historyRoutineSelect');
    const withHistory = routinesWithHistory();
    sel.innerHTML = '';
    if(withHistory.length === 0){ sel.hidden = true; return null; }
    sel.hidden = false;
    withHistory.forEach(r=>{
      const opt = document.createElement('option');
      opt.value = r.id;
      opt.textContent = r.name;
      sel.appendChild(opt);
    });
    const preferred = withHistory.find(r => r.id === activeRoutineId) ? activeRoutineId : withHistory[0].id;
    sel.value = preferred;
    return preferred;
  }

  document.getElementById('historyBtn').addEventListener('click', ()=>{
    const routineId = populateHistoryRoutineSelect();
    renderHistoryTable(routineId);
    showScreen('screen-history');
  });
  document.getElementById('historyRoutineSelect').addEventListener('change', e=>{
    renderHistoryTable(e.target.value);
  });
  document.getElementById('historyBackBtn').addEventListener('click', ()=>{
    renderAll();
  });

  function renderHistoryTable(routineId){
    const container = document.getElementById('historyContent');
    const r = routines.find(x => x.id === routineId);
    const allDays = (r && r.days) || [];

    if(!r || allDays.length === 0){
      container.innerHTML = `<div class="hist-empty">No finished routines yet — this fills in after you complete your first one.</div>`;
      return;
    }

    const days = allDays.slice(0, MAX_HISTORY_COLUMNS);

    // Build row order: current tasks first (in their current order), then any
    // historical steps that no longer exist in the current list, in the order
    // they were first encountered. Scanned across ALL stored days (not just
    // the displayed columns) so low/high/avg reflect full history.
    const rowKeys = r.tasks.map(t => ({ taskId: t.id, label: t.name }));
    const knownIds = new Set(rowKeys.map(x => x.taskId));
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
      html += `<th>${escapeAttr(label)} <button class="del-day-btn" data-starttime="${day.startTime}" title="Delete this day">✕</button></th>`;
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
          html += `<td class="hist-cell ${cls}">${Math.round(entry.actualMin)}/${Math.round(entry.plannedMin)}${pauseSuffix(entry.pausedMin)}</td>`;
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
    html += `<div class="hist-note">Each cell reads actual&nbsp;/&nbsp;planned minutes — red means over, green means under. Low/High/Avg are actual minutes across this routine's full stored history (up to 60 days), not just the days shown here. Most recent day on the left.</div>`;
    container.innerHTML = html;

    container.querySelectorAll('.del-day-btn').forEach(btn=>{
      btn.addEventListener('click', async (e)=>{
        e.stopPropagation();
        const ok = confirm("Delete this day's record? This can't be undone.");
        if(!ok) return;
        const st = Number(btn.dataset.starttime);
        r.days = (r.days || []).filter(d => d.startTime !== st);
        await persistRoutines();
        const stillHasHistory = populateHistoryRoutineSelect();
        renderHistoryTable(stillHasHistory);
      });
    });
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

  function findResumeRoutine(){
    const candidates = routines.filter(r => r.today && (r.today.status === 'active' || r.today.status === 'summary'));
    if(!candidates.length) return null;
    candidates.sort((a,b) => (b.today.startTime||0) - (a.today.startTime||0));
    return candidates[0];
  }

  auth.onAuthStateChanged(async (user)=>{
    if(user){
      docRef = db.collection('users').doc(user.uid).collection('appdata').doc('daychain');
      const snap = await docRef.get();
      docCache = snap.exists ? snap.data() : {};

      const needsMigrationWrite = migrateLegacyDataIfNeeded();
      if(!needsMigrationWrite){
        routines = docCache.routines || [];
        activeRoutineId = docCache.activeRoutineId || null;
        if(activeRoutineId && !routines.find(r => r.id === activeRoutineId)) activeRoutineId = null;
      }
      if(needsMigrationWrite){
        await docRef.set({ routines, activeRoutineId }, { merge: true })
          .catch(e => console.error('migration write failed', e));
      }

      document.getElementById('screen-signin').hidden = true;
      document.getElementById('appShell').hidden = false;
      updateDateLabel();

      const resumeTarget = findResumeRoutine();
      if(resumeTarget){
        loadWorkingStateFrom(resumeTarget);
        persistActiveRoutineId();
        renderAll();
      } else {
        showRoutineList();
      }
    } else {
      docRef = null;
      docCache = null;
      routines = [];
      activeRoutineId = null;
      if(tickHandle){ clearInterval(tickHandle); tickHandle = null; }
      releaseKeepAwake();

      document.getElementById('appShell').hidden = true;
      document.getElementById('screen-signin').hidden = false;
    }
  });

})();
