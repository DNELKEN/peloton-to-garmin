import { PM5Device } from './pm5.js';
import { FtmsDevice } from './ftms.js';
import { HeartRateDevice } from './hr.js';
import { Simulator } from './simulator.js';
import { encodeFit, lapsToCsv, FIT_DEVICES } from './fit.js';
import { PLANS, planDays, planWorkout, nextDay, recordPlanResult } from './plans.js';
import {
  MACHINES, PRESETS, WorkoutEngine, buildIntervals, formatDistance, formatPace,
  formatTime, machineInfo, parseDuration,
} from './workout.js';

const $ = (sel) => document.querySelector(sel);
const HISTORY_KEY = 'erg-trainer.history';
const SETTINGS_KEY = 'erg-trainer.settings';
const PLAN_KEY = 'erg-trainer.plan.pete';
const plan = PLANS.pete;

const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
  },
};

const settings = { machine: 'rower', fitDevice: 'generic', pushToPm5: true, ...store.get(SETTINGS_KEY, {}) };
let planProgress = store.get(PLAN_KEY, {});

const state = {
  erg: null, // { kind, device, name }
  hr: null,
  live: {},
  workout: PRESETS[1],
  engine: null,
  timer: null,
  wakeLock: null,
  summary: null,
  lastCountdownBeep: null,
};

// ---------- sound ----------

let audio;
function beep(freq = 880, ms = 160) {
  try {
    audio ??= new AudioContext();
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.15, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + ms / 1000);
    osc.connect(gain).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + ms / 1000);
  } catch { /* no audio */ }
}

// ---------- views ----------

function show(view) {
  for (const id of ['setup', 'workout', 'summary']) $(`#view-${id}`).hidden = id !== view;
  window.scrollTo(0, 0);
}

function setChip(el, label, on) {
  el.textContent = label;
  el.dataset.on = String(on);
}

function updateConnectionUi() {
  setChip($('#chip-erg'), state.erg ? `Erg: ${state.erg.name}` : 'Erg: none', !!state.erg);
  setChip($('#chip-hr'), state.hr ? `HR: ${state.hr.name}` : 'HR: none', !!state.hr);
  for (const btn of document.querySelectorAll('[data-connect]')) {
    const kind = btn.dataset.connect;
    const connected = kind === 'hr' ? !!state.hr : state.erg?.kind === kind;
    btn.dataset.connected = String(connected);
  }
  const canPush = state.erg?.kind === 'pm5' && state.erg.device.canProgram;
  $('#push-row').hidden = !canPush;
  $('#push-pm5').checked = settings.pushToPm5;
  const start = $('#start');
  start.disabled = !state.erg;
  start.textContent = !state.erg ? 'Connect an erg to start' : canPush && settings.pushToPm5 ? 'Load onto PM5 and start' : 'Start workout';
  renderLivePreview();
}

function renderLivePreview() {
  const el = $('#live-preview');
  if (!state.erg && !state.hr) { el.textContent = 'Not connected.'; return; }
  const m = machineInfo(settings.machine);
  const parts = [];
  if (state.erg) {
    const { speed, cadence, power } = state.live;
    parts.push(`${formatPace(speed > 0.3 ? m.paceUnit / speed : null)} /${m.paceUnit}m`);
    parts.push(`${cadence != null ? Math.round(cadence) : '--'} ${m.cadenceUnit}`);
    parts.push(`${power != null ? Math.round(power) : '--'} W`);
  }
  parts.push(`${state.live.heartRate ?? '--'} bpm`);
  el.textContent = `Live: ${parts.join(' · ')}`;
}

function renderPresets() {
  const wrap = $('#presets');
  wrap.replaceChildren(...PRESETS.map((p) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'preset';
    b.setAttribute('aria-pressed', String(p.name === state.workout.name && !state.workout.plan));
    b.innerHTML = `<strong></strong><small></small>`;
    b.querySelector('strong').textContent = p.name;
    b.querySelector('small').textContent = segmentCount(p);
    b.addEventListener('click', () => selectWorkout(p));
    return b;
  }));
  $('#selected-name').textContent = state.workout.name;
}

function segmentCount(w) {
  const works = w.segments.filter((s) => s.type === 'work').length;
  return works > 1 ? `${works} pieces` : w.segments[0].kind === 'open' ? 'No target' : 'Single piece';
}

function selectWorkout(w) {
  state.workout = w;
  setPushStatus('');
  renderPresets();
  renderPlan();
}

// ---------- plan ----------

function savePlan() {
  store.set(PLAN_KEY, planProgress);
}

function renderPlan() {
  const days = planDays(plan);
  const next = nextDay(plan, planProgress);
  const cycle = planProgress.cycle ?? 1;
  const doneThisCycle = new Map();
  for (const h of planProgress.history ?? []) {
    if ((h.cycle ?? 1) === cycle && !doneThisCycle.has(h.dayIndex)) doneThisCycle.set(h.dayIndex, h);
  }
  const nextW = planWorkout(plan, next, planProgress);
  $('#plan-next').innerHTML = '';
  const strong = document.createElement('strong');
  strong.textContent = `Next up: Week ${days[next].week}, Day ${days[next].day} · ${nextW.shortName}`;
  $('#plan-next').append(`Cycle ${cycle} · `, strong);

  const weeks = plan.weeks.map((w, wi) => {
    const section = document.createElement('div');
    section.className = 'plan-week';
    const h = document.createElement('h3');
    h.textContent = `Week ${wi + 1}`;
    section.append(h);
    for (const d of days.filter((x) => x.week === wi + 1)) {
      const wk = planWorkout(plan, d.index, planProgress);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'plan-day';
      b.innerHTML = '<span class="d-num"></span><span class="d-name"></span><span class="d-meta"></span>';
      b.querySelector('.d-num').textContent = `Day ${d.day}`;
      b.querySelector('.d-name').textContent = wk ? wk.shortName : 'Rest day';
      const done = doneThisCycle.get(d.index);
      const target = planProgress.targets?.[d.session.id];
      b.querySelector('.d-meta').textContent = done
        ? `✓ ${done.pace ? formatPace(done.pace) : 'done'}`
        : target ? `target ${formatPace(target)}` : '';
      b.dataset.done = String(!!done);
      b.dataset.next = String(d.index === next);
      b.setAttribute('aria-pressed', String(state.workout.plan?.dayIndex === d.index));
      if (!wk) b.disabled = true;
      else b.addEventListener('click', () => selectWorkout(planWorkout(plan, d.index, planProgress)));
      section.append(b);
    }
    return section;
  });
  $('#plan-weeks').replaceChildren(...weeks);
  const opts = { ...plan.defaults, ...planProgress.options };
  $('#plan-steady').value = opts.steadyDistance;
  $('#plan-hard').value = opts.hardDistance;
}

function setPlanOption(key, value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < 500 || n > 100000) return;
  planProgress = { ...planProgress, options: { ...planProgress.options, [key]: n } };
  savePlan();
  const sel = state.workout.plan;
  if (sel && (sel.kind === 'steady' || sel.kind === 'hard')) state.workout = planWorkout(plan, sel.dayIndex, planProgress);
  renderPresets();
  renderPlan();
}

function showTab(tab) {
  for (const t of document.querySelectorAll('[data-tab]')) t.setAttribute('aria-selected', String(t.dataset.tab === tab));
  for (const p of document.querySelectorAll('[data-panel]')) p.hidden = p.dataset.panel !== tab;
  settings.tab = tab;
  store.set(SETTINGS_KEY, settings);
}

function setPushStatus(text, kind = '') {
  const el = $('#push-status');
  el.textContent = text;
  el.dataset.state = kind;
}

function renderMachineSelect() {
  const sel = $('#machine');
  sel.replaceChildren(...Object.entries(MACHINES).map(([key, m]) => new Option(m.label, key, false, key === settings.machine)));
  updateUnitLabels();
}

function updateUnitLabels() {
  const m = machineInfo(settings.machine);
  $('#target-label').textContent = `Target pace /${m.paceUnit}m (optional)`;
  $('#w-pace-label').textContent = `Pace /${m.paceUnit}m`;
  $('#w-cad-label').textContent = m.cadenceUnit === 'rpm' ? 'Cadence' : 'Stroke rate';
}

function renderFitDeviceSelect() {
  $('#fit-device').replaceChildren(...Object.entries(FIT_DEVICES).map(([key, d]) => new Option(d.label, key, false, key === settings.fitDevice)));
}

function renderHistory() {
  const items = store.get(HISTORY_KEY, []);
  $('#history-card').hidden = items.length === 0;
  $('#history').replaceChildren(...items.slice(0, 10).map((h) => {
    const li = document.createElement('li');
    const m = machineInfo(h.machine);
    li.innerHTML = '<div><div class="h-name"></div><div class="h-meta"></div></div><div class="h-res"></div>';
    li.querySelector('.h-name').textContent = h.name;
    li.querySelector('.h-meta').textContent = `${new Date(h.startTime).toLocaleString()} · ${m.label}`;
    li.querySelector('.h-res').textContent = `${formatDistance(h.totalDistance)} · ${formatTime(h.elapsed)}`;
    return li;
  }));
}

// ---------- devices ----------

function onErgData(update) {
  if (state.hr) delete update.heartRate; // a dedicated strap wins over the erg's own HR
  Object.assign(state.live, update);
  state.engine?.ingest(update, Date.now());
  if (!state.engine) renderLivePreview();
}

function onHrData(update) {
  Object.assign(state.live, update);
  state.engine?.ingest(update, Date.now());
  if (!state.engine) renderLivePreview();
}

async function connect(kind) {
  try {
    if (kind === 'hr') {
      state.hr?.device.disconnect();
      const device = new HeartRateDevice({ onData: onHrData, onDisconnect: () => { state.hr = null; updateConnectionUi(); } });
      state.hr = { kind, device, name: await device.connect() };
    } else {
      state.erg?.device.disconnect();
      state.erg = null;
      state.live = {};
      const handlers = { onData: onErgData, onDisconnect: () => { state.erg = null; updateConnectionUi(); } };
      const device = kind === 'pm5' ? new PM5Device(handlers)
        : kind === 'ftms' ? new FtmsDevice(handlers)
        : new Simulator({ machine: settings.machine, onData: onErgData });
      const name = await device.connect();
      state.erg = { kind, device, name };
      if (device.machineGuess && device.machineGuess !== settings.machine) setMachine(device.machineGuess);
    }
  } catch (err) {
    if (err?.name !== 'NotFoundError') alert(`Could not connect: ${err?.message ?? err}`); // NotFoundError = picker cancelled
  }
  updateConnectionUi();
}

function setMachine(machine) {
  settings.machine = machine;
  store.set(SETTINGS_KEY, settings);
  $('#machine').value = machine;
  if (state.erg?.kind === 'sim') state.erg.device.machine = machine;
  updateUnitLabels();
  renderLivePreview();
}

// ---------- workout ----------

async function loadOntoPm5() {
  const pm = state.erg.device;
  let terminateFirst = false;
  if (pm.workoutInProgress) {
    if (!confirm('The PM5 has a workout in progress. End it and load this one?')) return false;
    terminateFirst = true;
  }
  const start = $('#start');
  start.disabled = true;
  setPushStatus('Loading onto the PM5…');
  try {
    const { verified } = await pm.programWorkout(state.workout, {
      terminateFirst,
      sendTargets: machineInfo(settings.machine).paceUnit === 500,
    });
    setPushStatus(
      verified ? 'Loaded. The PM5 is ready: start rowing.' : 'Sent to the PM5. Check its screen shows the workout, then start rowing.',
      'ok',
    );
    return true;
  } catch (err) {
    setPushStatus(`${err?.message ?? err} You can untick "Load this workout onto the PM5" and set it up on the monitor instead.`, 'error');
    return false;
  } finally {
    start.disabled = !state.erg;
  }
}

async function startWorkout() {
  if (!state.erg) return;
  if (state.erg.kind === 'pm5' && state.erg.device.canProgram && settings.pushToPm5) {
    if (!(await loadOntoPm5())) return;
  }
  beep(660, 60); // unlocks audio on iOS-style autoplay policies
  state.lastCountdownBeep = null;
  state.engine = new WorkoutEngine(state.workout, {
    machine: settings.machine,
    onSegmentChange: (seg, index) => {
      if (state.erg?.kind === 'sim') state.erg.device.setResting(seg.type === 'rest');
      if (index > 0) beep(seg.type === 'rest' ? 520 : 990, 350);
    },
    onFinish: (summary) => setTimeout(() => finishWorkout(summary)),
  });
  if (state.erg.kind === 'sim') state.erg.device.setResting(false);
  $('#sim-controls').hidden = state.erg.kind !== 'sim';
  renderSimEffort();
  show('workout');
  state.timer = setInterval(renderWorkout, 200);
  renderWorkout();
  try { state.wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* not supported */ }
}

function segTitle(seg) {
  if (seg.kind === 'open') return 'Just row';
  return seg.kind === 'distance' ? `${seg.value.toLocaleString('en-US')}m` : formatTime(seg.value);
}

function renderWorkout() {
  const e = state.engine;
  if (!e) return;
  const now = Date.now();
  e.tick(now);
  if (!state.engine) return; // finished during tick
  const v = e.view(now);
  const m = machineInfo(e.machine);
  const isRest = v.seg.type === 'rest';

  $('#w-seg-label').textContent = isRest
    ? 'Rest'
    : v.works > 1 ? `Piece ${v.workNumber} of ${v.works} · ${segTitle(v.seg)}` : segTitle(v.seg);
  $('#w-next').textContent = v.next ? `Next: ${v.next.type === 'rest' ? `rest ${formatTime(v.next.value)}` : segTitle(v.next)}` : '';

  const hero = $('#w-hero');
  const caption = $('#w-hero-caption');
  $('#w-hero-wrap').dataset.type = v.seg.type;
  if (v.state === 'armed') {
    hero.textContent = v.seg.kind === 'distance' ? v.seg.value.toLocaleString('en-US') : v.seg.kind === 'time' ? formatTime(v.seg.value) : '0:00';
    caption.textContent = 'Start moving to begin, or tap Start now';
  } else if (v.seg.kind === 'distance') {
    hero.textContent = Math.ceil(v.remaining).toLocaleString('en-US');
    caption.textContent = `metres to go · ${formatTime(v.segElapsed)} elapsed${v.projected ? ` · projected ${formatTime(v.projected, true)}` : ''}`;
  } else if (v.seg.kind === 'time') {
    hero.textContent = formatTime(Math.ceil(v.remaining));
    caption.textContent = isRest ? 'rest remaining' : `remaining · ${formatDistance(v.segDistance)} · projected ${formatDistance(v.projected)}`;
  } else {
    hero.textContent = formatTime(v.segElapsed);
    caption.textContent = formatDistance(v.segDistance);
  }
  $('#w-progress').style.width = `${(v.progress ?? 0) * 100}%`;

  // Countdown beeps in the last 3 seconds of a rest.
  if (isRest && v.state === 'running') {
    const left = Math.ceil(v.remaining);
    if (left <= 3 && left > 0 && state.lastCountdownBeep !== `${v.segIndex}:${left}`) {
      state.lastCountdownBeep = `${v.segIndex}:${left}`;
      beep(740, 120);
    }
  }

  const target = $('#w-target');
  target.hidden = v.targetDelta == null || isRest;
  if (v.targetDelta != null) {
    const ahead = v.targetDelta <= 0;
    target.dataset.state = ahead ? 'ahead' : 'behind';
    target.textContent = `Target ${formatPace(v.seg.targetPace)} · ${Math.abs(v.targetDelta).toFixed(1)}s ${ahead ? 'ahead' : 'behind'} per ${m.paceUnit}m`;
  }

  $('#w-pace').textContent = formatPace(v.pace);
  $('#w-seg-pace').textContent = formatPace(v.segPace);
  $('#w-cadence').textContent = v.cadence ? Math.round(v.cadence) : '--';
  $('#w-power').textContent = v.power ? Math.round(v.power) : '--';
  $('#w-hr').textContent = v.heartRate ?? '--';
  $('#w-cal').textContent = Math.round(v.calories);
  $('#w-dist').textContent = formatDistance(v.totalDistance);
  $('#w-time').textContent = formatTime(v.totalElapsed);
  $('#start-now').hidden = v.state !== 'armed';
}

function renderSimEffort() {
  const sim = state.erg?.kind === 'sim' ? state.erg.device : null;
  if (sim) $('#sim-effort').textContent = `${Math.round(sim.effort * 100)}%`;
}

function stopWorkoutLoop() {
  clearInterval(state.timer);
  state.timer = null;
  state.engine = null;
  state.wakeLock?.release?.().catch(() => {});
  state.wakeLock = null;
}

function finishWorkout(summary) {
  stopWorkoutLoop();
  if (!summary || !summary.laps.length) { show('setup'); return; }
  beep(990, 500);
  state.summary = summary;
  const { samples, laps, ...brief } = summary;
  store.set(HISTORY_KEY, [brief, ...store.get(HISTORY_KEY, [])].slice(0, 20));
  if (summary.plan?.planId === plan.id) {
    planProgress = recordPlanResult(plan, planProgress, summary);
    savePlan();
    renderPlan();
  }
  renderSummary(summary);
  renderHistory();
  show('summary');
}

function renderSummary(s) {
  const m = machineInfo(s.machine);
  $('#s-title').textContent = s.name;
  $('#s-date').textContent = `${new Date(s.startTime).toLocaleString()} · ${m.label}`;
  const stats = [
    ['Distance', formatDistance(s.totalDistance)],
    ['Time', formatTime(s.elapsed, true)],
    [`Work pace /${m.paceUnit}m`, formatPace(s.workPace)],
    ['Avg watts', s.avgPower || '--'],
    [`Avg ${m.cadenceUnit}`, s.avgCadence || '--'],
    ['Avg / max HR', s.avgHr ? `${s.avgHr} / ${s.maxHr}` : '--'],
    ['Calories', s.calories],
  ];
  $('#s-stats').replaceChildren(...stats.map(([label, value]) => {
    const d = document.createElement('div');
    d.className = 'stat';
    d.innerHTML = '<span></span><strong></strong>';
    d.querySelector('span').textContent = label;
    d.querySelector('strong').textContent = value;
    return d;
  }));
  $('#s-pace-head').textContent = `/${m.paceUnit}m`;
  $('#s-cad-head').textContent = m.cadenceUnit.toUpperCase();
  let n = 0;
  $('#s-laps').replaceChildren(...s.laps.map((l) => {
    const tr = document.createElement('tr');
    if (l.type === 'rest') tr.className = 'rest';
    const cells = [
      l.type === 'rest' ? 'rest' : String(++n),
      formatTime(l.duration, true),
      Math.round(l.distance).toLocaleString('en-US'),
      l.type === 'rest' ? '--' : formatPace(l.pace),
      l.avgPower || '--',
      l.type === 'rest' ? '--' : l.avgCadence || '--',
      l.avgHr ?? '--',
    ];
    for (const c of cells) {
      const td = document.createElement('td');
      td.textContent = c;
      tr.append(td);
    }
    return tr;
  }));
}

function download(bytes, filename, type) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function fileStem(s) {
  const d = new Date(s.startTime);
  const pad = (x) => String(x).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
  return `${stamp}_${s.machine}_${s.name.replace(/[^\w]+/g, '-').replace(/^-|-$/g, '')}`;
}

// ---------- custom workout form ----------

function readCustomForm(form) {
  const data = new FormData(form);
  const reps = Number(data.get('reps'));
  const workKind = data.get('kind');
  const workValue = workKind === 'time' ? parseDuration(data.get('work')) : Number(data.get('work'));
  const restText = String(data.get('rest') || '0').trim();
  const restSec = restText ? parseDuration(restText) : 0;
  const targetText = String(data.get('target') || '').trim();
  const targetPace = targetText ? parseDuration(targetText) : null;

  if (!Number.isInteger(reps) || reps < 1) return { error: 'Reps must be a whole number of at least 1.' };
  if (!Number.isFinite(workValue) || workValue <= 0) return { error: workKind === 'time' ? 'Enter work time as m:ss, e.g. 4:00.' : 'Enter work distance in metres, e.g. 500.' };
  if (!Number.isFinite(restSec) || restSec < 0) return { error: 'Enter rest as m:ss, e.g. 1:00, or 0 for none.' };
  if (targetText && (!Number.isFinite(targetPace) || targetPace <= 0)) return { error: 'Enter target pace as m:ss.t, e.g. 1:55.0.' };
  return { workout: buildIntervals({ reps, workKind, workValue, restSec, targetPace }) };
}

// ---------- wire up ----------

function init() {
  if (!navigator.bluetooth) {
    const warn = $('#bt-warning');
    warn.hidden = false;
    warn.textContent = /iPhone|iPad|iPod/.test(navigator.userAgent)
      ? 'Safari on iPhone and iPad does not support Web Bluetooth. Open this page in the Bluefy browser (free on the App Store) to connect, or try the simulator.'
      : 'This browser does not support Web Bluetooth. Use Chrome or Edge on a computer or Android phone (over https or localhost), or try the simulator.';
    for (const kind of ['pm5', 'ftms', 'hr']) document.querySelector(`[data-connect="${kind}"]`).disabled = true;
  }

  renderMachineSelect();
  renderFitDeviceSelect();
  renderPresets();
  renderPlan();
  renderHistory();
  showTab(settings.tab ?? 'quick');
  updateConnectionUi();
  $('#plan-notes').replaceChildren(...plan.notes.map((n) => Object.assign(document.createElement('li'), { textContent: n })));

  for (const t of document.querySelectorAll('[data-tab]')) t.addEventListener('click', () => showTab(t.dataset.tab));
  $('#plan-steady').addEventListener('change', (e) => setPlanOption('steadyDistance', e.target.value));
  $('#plan-hard').addEventListener('change', (e) => setPlanOption('hardDistance', e.target.value));
  $('#push-pm5').addEventListener('change', (e) => {
    settings.pushToPm5 = e.target.checked;
    store.set(SETTINGS_KEY, settings);
    setPushStatus('');
    updateConnectionUi();
  });

  for (const btn of document.querySelectorAll('[data-connect]')) btn.addEventListener('click', () => connect(btn.dataset.connect));
  $('#machine').addEventListener('change', (e) => setMachine(e.target.value));
  $('#fit-device').addEventListener('change', (e) => { settings.fitDevice = e.target.value; store.set(SETTINGS_KEY, settings); });

  const form = $('#custom-form');
  form.kind.addEventListener('change', () => {
    const time = form.kind.value === 'time';
    $('#work-label').textContent = time ? 'Time (m:ss)' : 'Distance (m)';
    form.work.value = time ? '4:00' : '500';
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const { workout, error } = readCustomForm(form);
    $('#custom-error').textContent = error ?? '';
    if (workout) selectWorkout(workout);
  });

  $('#start').addEventListener('click', startWorkout);
  $('#start-now').addEventListener('click', () => state.engine?.startNow(Date.now()));
  $('#end').addEventListener('click', () => {
    const e = state.engine;
    if (!e) return;
    if (e.state === 'running' && !confirm('End this workout now?')) return;
    const summary = e.end(Date.now());
    if (!summary) finishWorkout(null); // never started; onFinish handles the rest
  });
  $('#sim-slower').addEventListener('click', () => { state.erg?.device.adjustEffort?.(-0.05); renderSimEffort(); });
  $('#sim-faster').addEventListener('click', () => { state.erg?.device.adjustEffort?.(0.05); renderSimEffort(); });

  $('#dl-fit').addEventListener('click', () => {
    const s = state.summary;
    if (s) download(encodeFit(s, { device: settings.fitDevice }), `${fileStem(s)}.fit`, 'application/vnd.ant.fit');
  });
  $('#dl-csv').addEventListener('click', () => {
    const s = state.summary;
    if (s) download(lapsToCsv(s), `${fileStem(s)}_splits.csv`, 'text/csv');
  });
  $('#again').addEventListener('click', () => {
    if (state.workout.plan) selectWorkout(planWorkout(plan, nextDay(plan, planProgress), planProgress));
    setPushStatus('');
    show('setup');
    updateConnectionUi();
  });

  document.addEventListener('visibilitychange', async () => {
    if (state.engine && document.visibilityState === 'visible' && !state.wakeLock) {
      try { state.wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* ignore */ }
    }
  });
}

init();
