import { PM5Device } from './pm5.js';
import { FtmsDevice } from './ftms.js';
import { HeartRateDevice } from './hr.js';
import { Simulator } from './simulator.js';
import { encodeFit, lapsToCsv, FIT_DEVICES } from './fit.js';
import { PLANS, planDays, planWorkout, nextDay, recordPlanResult } from './plans.js';
import { LogbookClient, LOGBOOK_TYPES, buildLogbookResult } from './logbook.js';
import { suggestTargets, applyTargets } from './insights.js';
import { MULTI_MACHINES, SHORT_NAMES, buildCircuit, buildErgathlon, machinesIn, nextLegOn, splitByMachine } from './multi.js';
import {
  MACHINES, PRESETS, WorkoutEngine, splitKindOf, splitForSegment, parseSplitText, describeSplit, buildIntervals, formatDistance, formatPace,
  formatTime, machineInfo, parseDuration,
} from './workout.js';

const $ = (sel) => document.querySelector(sel);
const HISTORY_KEY = 'erg-trainer.history';
const SETTINGS_KEY = 'erg-trainer.settings';
const PLAN_KEY = 'erg-trainer.plan.pete';
const LB_HISTORY_KEY = 'erg-trainer.logbook.history';
const LB_HISTORY_MAX_AGE_MS = 6 * 3600 * 1000;
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
delete settings.strokeView; // setting from the removed stroke panel
let planProgress = store.get(PLAN_KEY, {});
const logbook = new LogbookClient();

const state = {
  erg: null, // { kind, device, name, machine }: the erg for single-machine workouts
  ergs: {}, // machine -> connection, for the other machines in a multi-erg workout
  hr: null,
  live: {},
  workout: PRESETS[1],
  engine: null,
  timer: null,
  wakeLock: null,
  summary: null,
  lastCountdownBeep: null,
  rep: null, // running averages for the current piece
};

const machineLabel = (key) => (key === 'multi' ? 'Multi-erg' : machineInfo(key).label);
const shortName = (key) => SHORT_NAMES[key] ?? machineInfo(key).label;

// The connection for a machine: one connected for a multi-erg workout, or the main erg if it is
// set to that machine.
function connFor(machine) {
  return state.ergs[machine] ?? (state.erg?.machine === machine ? state.erg : null);
}

// Every connected erg, without duplicates.
function allErgs() {
  return [...new Set([state.erg, ...Object.values(state.ergs)].filter(Boolean))];
}

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
  const multiErgs = Object.keys(state.ergs);
  if (multiErgs.length) setChip($('#chip-erg'), `Ergs: ${multiErgs.map(shortName).join(', ')}`, true);
  else setChip($('#chip-erg'), state.erg ? `Erg: ${state.erg.name}` : 'Erg: none', !!state.erg);
  setChip($('#chip-hr'), state.hr ? `HR: ${state.hr.name}` : 'HR: none', !!state.hr);
  for (const btn of document.querySelectorAll('[data-connect]')) {
    const kind = btn.dataset.connect;
    const connected = kind === 'hr' ? !!state.hr : state.erg?.kind === kind;
    btn.dataset.connected = String(connected);
  }
  const start = $('#start');
  renderMultiMachines();
  if (state.workout.multi) {
    const needed = machinesIn(state.workout);
    const missing = needed.filter((m) => !connFor(m));
    const canPush = needed.some((m) => connFor(m)?.kind === 'pm5' && connFor(m).device.canProgram);
    $('#push-row').hidden = !canPush;
    $('#push-pm5').checked = settings.pushToPm5;
    start.disabled = missing.length > 0;
    start.textContent = missing.length ? `Connect ${missing.map(shortName).join(', ')} to start` : canPush && settings.pushToPm5 ? 'Load onto the PM5s and start' : 'Start workout';
  } else {
    const canPush = state.erg?.kind === 'pm5' && state.erg.device.canProgram;
    $('#push-row').hidden = !canPush;
    $('#push-pm5').checked = settings.pushToPm5;
    start.disabled = !state.erg;
    start.textContent = !state.erg ? 'Connect an erg to start' : canPush && settings.pushToPm5 ? 'Load onto PM5 and start' : 'Start workout';
  }
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
  renderSuggestion();
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
  renderSplitSetting();
  updateConnectionUi();
}

// ---------- split setting ----------

// The split box on the Go card. What you type is remembered per workout.
function renderSplitSetting() {
  const w = state.workout;
  const kind = splitKindOf(w);
  $('#split-row').hidden = !kind;
  if (!kind) return;
  const input = $('#split-input');
  $('#split-label').textContent = kind === 'distance' ? 'Split every (meters)' : kind === 'time' ? 'Split every (m:ss)' : 'Split every (meters, or m:ss)';
  input.inputMode = kind === 'distance' ? 'numeric' : 'text';
  const auto = splitForSegment({ ...w, split: null }, w.segments.find((x) => x.type === 'work'));
  input.placeholder = auto ? `Auto: ${describeSplit(auto)}` : kind === 'time' ? 'e.g. 2:00 (optional)' : 'e.g. 250 (optional)';
  input.value = settings.splitPrefs?.[w.name] ?? '';
  const works = w.segments.filter((x) => x.type === 'work').length;
  $('#split-hint').textContent = works > 1
    ? 'Each piece is split on this screen and in the FIT file. The PM5 and Logbook keep whole pieces.'
    : kind === 'either'
      ? 'Recorded on this screen, in the Logbook and in the FIT file.'
      : 'Used on the PM5, on this screen, in the Logbook and in the FIT file.';
  checkSplitInput();
}

function checkSplitInput() {
  const { error } = parseSplitText($('#split-input').value, state.workout);
  $('#split-error').textContent = error ?? '';
  return !error;
}

// For a multi-erg workout: one row per machine it uses, each with its own connect buttons.
function renderMultiMachines() {
  const wrap = $('#multi-machines');
  wrap.hidden = !state.workout.multi;
  if (!state.workout.multi) return;
  wrap.replaceChildren(...machinesIn(state.workout).map((machine) => {
    const conn = connFor(machine);
    const row = document.createElement('div');
    row.className = 'multi-machine';
    row.dataset.connected = String(!!conn);
    row.innerHTML = '<div><div class="mm-name"></div><div class="mm-status"></div></div><div class="mm-buttons"></div>';
    row.querySelector('.mm-name').textContent = machineInfo(machine).label;
    row.querySelector('.mm-status').textContent = !conn ? 'Not connected'
      : conn.connected === false ? 'Asleep or out of range: reconnecting when it wakes' : `Connected: ${conn.name}`;
    if (conn?.connected === false) row.dataset.connected = 'waiting';
    const buttons = row.querySelector('.mm-buttons');
    for (const [kind, label] of [['pm5', 'PM5'], ['sim', 'Simulate']]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `btn btn-small${kind === 'sim' ? ' btn-ghost' : ''}`;
      b.textContent = conn?.kind === kind ? `${label} ✓` : label;
      b.disabled = kind === 'pm5' && !navigator.bluetooth;
      b.addEventListener('click', () => connectMulti(machine, kind));
      buttons.append(b);
    }
    return row;
  }));
}

// ---------- suggested targets (from Logbook history) ----------

function logbookHistory() {
  const h = store.get(LB_HISTORY_KEY, null);
  return h && h.type === LOGBOOK_TYPES[settings.machine] ? h : null;
}

function renderSuggestion() {
  const box = $('#suggest');
  const h = logbookHistory();
  const m = machineInfo(settings.machine);
  const s = h ? suggestTargets(state.workout, h.items, { paceUnit: m.paceUnit }) : null;
  state.suggestion = s;
  box.hidden = !s;
  if (!s) return;
  const parts = [`${formatPace(s.pace)} /${m.paceUnit}m`, `${s.watts} W`];
  if (s.spm) parts.push(`~${s.spm} ${m.cadenceUnit}`);
  if (s.hr) parts.push(`~${s.hr} bpm`);
  $('#suggest-main').textContent = parts.join(' · ');
  $('#suggest-basis').textContent = s.basis === 'similar'
    ? `Average of your last ${s.count === 1 ? 'session' : `${s.count} sessions`} of this workout.`
    : `Predicted from your best recent pieces (${s.count} in the last few months). Stroke rate and heart rate are what you usually do at this pace.`;
  const applied = s.targets.every((t) => state.workout.segments[t.index].targetPace === t.pace);
  const btn = $('#suggest-apply');
  btn.disabled = applied;
  btn.textContent = applied ? 'Targets set' : 'Use these targets';
}

function renderHistoryStatus(text) {
  const h = logbookHistory();
  $('#lb-refresh').hidden = !logbook.connected;
  $('#lb-history').textContent = text ?? (h ? `Workout history: ${h.items.length} ${machineInfo(settings.machine).label} workouts from the last year, used for suggested targets.` : '');
}

async function refreshLogbookHistory({ force = false } = {}) {
  const type = LOGBOOK_TYPES[settings.machine];
  if (!logbook.connected || !type) { renderHistoryStatus(); return; }
  const h = logbookHistory();
  if (!force && h && Date.now() - h.fetchedAt < LB_HISTORY_MAX_AGE_MS) { renderHistoryStatus(); return; }
  renderHistoryStatus('Loading your workout history…');
  try {
    const items = await logbook.history({ type });
    store.set(LB_HISTORY_KEY, { type, fetchedAt: Date.now(), items });
    renderHistoryStatus();
    renderSuggestion();
  } catch (err) {
    renderHistoryStatus(`Couldn't load your workout history: ${err.message}`);
  }
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
  $('#w-pace-label').textContent = `Split /${m.paceUnit}m`;
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
    li.innerHTML = '<div><div class="h-name"></div><div class="h-meta"></div></div><div class="h-res"></div>';
    li.querySelector('.h-name').textContent = h.name;
    li.querySelector('.h-meta').textContent = `${new Date(h.startTime).toLocaleString()} · ${machineLabel(h.machine)}`;
    li.querySelector('.h-res').textContent = `${formatDistance(h.totalDistance)} · ${formatTime(h.elapsed)}`;
    return li;
  }));
}

// ---------- devices ----------

function onErgData(update, conn) {
  if (state.hr) delete update.heartRate; // a dedicated strap wins over the erg's own HR
  const e = state.engine;
  if (e?.multi) {
    const active = conn?.machine === e.machineOf(e.segment);
    if (active) Object.assign(state.live, update);
    e.ingest({ ...update, source: conn?.machine }, Date.now());
    return;
  }
  if (conn && conn !== state.erg) return; // a multi-erg machine, idle between workouts
  Object.assign(state.live, update);
  e?.ingest(update, Date.now());
  if (!e) renderLivePreview();
}

// The PM5 left its workout: either it finished, or the rower pressed Menu to end it early.
// A finished workout normally completes in the app at the same moment; give the last readings a
// moment to arrive, then end whatever is still running so the work so far is saved (and synced).
const PM_END_GRACE_MS = 2000;
function onPmWorkoutEnd() {
  const engine = state.engine;
  // In a multi-erg workout each PM5 finishes its own legs; the app moves on by distance or time.
  if (!engine || engine.multi) return;
  const endedAt = Date.now();
  setTimeout(() => {
    if (state.engine !== engine || engine.state !== 'running') return;
    const summary = engine.end(endedAt);
    if (!summary) finishWorkout(null);
  }, PM_END_GRACE_MS);
}

function onHrData(update) {
  Object.assign(state.live, update);
  state.engine?.ingest(update, Date.now());
  if (!state.engine) renderLivePreview();
}

// Connect one erg. Its data is tagged with the connection, so we know which machine it came from.
async function openErg(kind, machine, onGone) {
  const conn = { kind, machine };
  const handlers = {
    onData: (u) => onErgData(u, conn),
    onDisconnect: () => { onGone(); updateConnectionUi(); },
    onWorkoutEnd: onPmWorkoutEnd,
  };
  conn.device = kind === 'pm5' ? new PM5Device(handlers)
    : kind === 'ftms' ? new FtmsDevice(handlers)
    : new Simulator({ machine, onData: handlers.onData });
  conn.name = await conn.device.connect();
  return conn;
}

// Multi-erg PM5s sit idle for long stretches and may go to sleep. Keep checking in with them,
// and when one drops, keep reconnecting until it wakes (when someone starts using it).
function keepConnected(conn) {
  if (conn.kind !== 'pm5') return;
  conn.connected = true;
  conn.device.onConnectionChange = (ok) => {
    conn.connected = ok;
    const e = state.engine;
    if (ok && e?.multi && e.state !== 'finished') {
      e.resetSource(conn.machine);
      // Woke up before its leg: load the leg again, unless it's the one in progress.
      const seg = e.segment;
      if (!(seg.type === 'work' && seg.machine === conn.machine)) loadNextLeg(e, e.segIndex - 1, conn.machine);
    }
    updateConnectionUi();
  };
  conn.device.setAutoReconnect(true);
  conn.device.startKeepAlive();
}

async function connectMulti(machine, kind) {
  try {
    const old = state.ergs[machine];
    if (old && old !== state.erg) old.device.disconnect();
    delete state.ergs[machine];
    if (state.erg?.machine === machine && state.erg.kind !== kind) {
      if (!Object.values(state.ergs).includes(state.erg)) state.erg.device.disconnect();
      state.erg = null;
    }
    const conn = await openErg(kind, machine, () => { if (state.ergs[machine] === conn) delete state.ergs[machine]; });
    const guess = conn.device.machineGuess;
    if (kind === 'pm5' && guess && guess !== machine && !confirm(`That monitor looks like a ${machineInfo(guess).label}. Use it for the ${machineInfo(machine).label}?`)) {
      conn.device.disconnect();
    } else {
      state.ergs[machine] = conn;
      keepConnected(conn);
    }
  } catch (err) {
    if (err?.name !== 'NotFoundError') alert(`Could not connect: ${err?.message ?? err}`);
  }
  updateConnectionUi();
}

async function connect(kind) {
  try {
    if (kind === 'hr') {
      state.hr?.device.disconnect();
      const device = new HeartRateDevice({ onData: onHrData, onDisconnect: () => { state.hr = null; updateConnectionUi(); } });
      state.hr = { kind, device, name: await device.connect() };
    } else {
      if (state.erg && !Object.values(state.ergs).includes(state.erg)) state.erg.device.disconnect();
      state.erg = null;
      state.live = {};
      const conn = await openErg(kind, settings.machine, () => { if (state.erg === conn) state.erg = null; });
      state.erg = conn;
      if (conn.device.machineGuess && conn.device.machineGuess !== settings.machine) setMachine(conn.device.machineGuess);
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
  if (state.erg) state.erg.machine = machine;
  if (state.erg?.kind === 'sim') state.erg.device.machine = machine;
  updateUnitLabels();
  renderLivePreview();
  renderSuggestion();
  refreshLogbookHistory();
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

// Multi-erg: load the first leg for each machine onto its PM5 before the start.
async function loadLegsOntoPm5s(workout) {
  const start = $('#start');
  start.disabled = true;
  try {
    for (const machine of machinesIn(workout)) {
      const conn = connFor(machine);
      if (conn?.kind !== 'pm5' || !conn.device.canProgram) continue;
      const pm = conn.device;
      let terminateFirst = false;
      if (pm.workoutInProgress) {
        if (!confirm(`The ${machineInfo(machine).label} PM5 has a workout in progress. End it and load this one?`)) return false;
        terminateFirst = true;
      }
      setPushStatus(`Loading the ${machineInfo(machine).label}…`);
      await pm.programWorkout({ segments: [nextLegOn(workout, machine).segment] }, { terminateFirst, sendTargets: machineInfo(machine).paceUnit === 500 });
    }
    setPushStatus('Loaded. Start on the first machine when you are ready.', 'ok');
    return true;
  } catch (err) {
    setPushStatus(`${err?.message ?? err} You can untick "Load this workout onto the PM5" and set up each monitor yourself.`, 'error');
    return false;
  } finally {
    updateConnectionUi();
  }
}

// Multi-erg: as soon as a leg finishes, load that machine's next leg so it is ready in time.
// With `machine` given, load that machine's next leg after `finishedIndex` whatever just finished.
function loadNextLeg(engine, finishedIndex, machine) {
  const seg = engine.workout.segments[finishedIndex];
  const m = machine ?? (seg?.type === 'work' ? seg.machine : null);
  if (!settings.pushToPm5 || !m) return;
  const conn = connFor(m);
  const next = nextLegOn(engine.workout, m, finishedIndex);
  if (conn?.kind !== 'pm5' || !conn.device.canProgram || conn.connected === false || !next) return;
  conn.device.programWorkout({ segments: [next.segment] }, { sendTargets: machineInfo(m).paceUnit === 500 })
    .catch(() => { /* the monitor still streams data; the leg is tracked by the app either way */ });
}

// Simulated machines: the active one rows, the others rest. After a leg, the next machine
// starts a few seconds later, as if the athlete walked over.
const SIM_CHANGEOVER_MS = 6000;
function driveSimulators(engine) {
  const seg = engine.segment;
  for (const conn of allErgs()) {
    if (conn.kind !== 'sim') continue;
    const active = !engine.multi || conn.machine === seg.machine;
    if (seg.type === 'transition') {
      conn.device.setResting(true);
      if (active) setTimeout(() => { if (state.engine === engine && engine.segment === seg) conn.device.setResting(false); }, SIM_CHANGEOVER_MS);
    } else {
      conn.device.setResting(!active || seg.type === 'rest');
    }
  }
}

async function startWorkout() {
  if (!state.workout.multi) {
    const { split, error } = parseSplitText($('#split-row').hidden ? '' : $('#split-input').value, state.workout);
    if (error) {
      setPushStatus(error, 'error');
      $('#split-input').focus();
      return;
    }
    const { split: _previous, ...workout } = state.workout;
    state.workout = split ? { ...workout, split } : workout;
  }
  const multi = !!state.workout.multi;
  if (multi ? machinesIn(state.workout).some((m) => !connFor(m)) : !state.erg) return;
  if (multi && settings.pushToPm5) {
    if (!(await loadLegsOntoPm5s(state.workout))) return;
  } else if (!multi && state.erg.kind === 'pm5' && state.erg.device.canProgram && settings.pushToPm5) {
    if (!(await loadOntoPm5())) return;
  }
  beep(660, 60); // unlocks audio on iOS-style autoplay policies
  state.lastCountdownBeep = null;
  state.engine = new WorkoutEngine(state.workout, {
    machine: settings.machine,
    onSegmentChange: (seg, index) => {
      const e = state.engine;
      if (!e) return;
      driveSimulators(e);
      if (index > 0) beep(seg.type === 'work' ? 990 : 520, 350);
      if (e.multi && index > 0) loadNextLeg(e, index - 1);
    },
    onFinish: (summary) => setTimeout(() => finishWorkout(summary)),
  });
  driveSimulators(state.engine);
  $('#sim-controls').hidden = !allErgs().some((c) => c.kind === 'sim');
  renderSimEffort();
  state.rep = null;
  state.piecesKey = null;
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
  const m = machineInfo(v.machine);
  const isTransition = v.seg.type === 'transition';
  const isRest = v.seg.type === 'rest' || isTransition;
  $('#w-pace-label').textContent = `Split /${m.paceUnit}m`;
  $('#w-cad-label').textContent = m.cadenceUnit === 'rpm' ? 'Cadence' : 'Stroke rate';

  renderMachineStatus(e);
  if (e.multi) {
    $('#w-seg-label').textContent = isTransition
      ? `Change to the ${m.label}`
      : `Leg ${v.workNumber} of ${v.works} · ${shortName(v.machine)} ${segTitle(v.seg)}`;
    const nextLeg = e.workout.segments.slice(v.segIndex + 1).find((x) => x.type === 'work');
    $('#w-next').textContent = isTransition ? '' : nextLeg ? `Next: ${shortName(nextLeg.machine)} ${segTitle(nextLeg)}` : 'Last leg';
  } else {
    $('#w-seg-label').textContent = isRest
      ? 'Rest'
      : v.works > 1 ? `Piece ${v.workNumber} of ${v.works} · ${segTitle(v.seg)}` : segTitle(v.seg);
    $('#w-next').textContent = v.next ? `Next: ${v.next.type === 'rest' ? `rest ${formatTime(v.next.value)}` : segTitle(v.next)}` : '';
  }

  const hero = $('#w-hero');
  const caption = $('#w-hero-caption');
  $('#w-hero-wrap').dataset.type = v.seg.type;
  if (v.state === 'armed') {
    hero.textContent = v.seg.kind === 'distance' ? v.seg.value.toLocaleString('en-US') : v.seg.kind === 'time' ? formatTime(v.seg.value) : '0:00';
    caption.textContent = e.multi ? `Start moving on the ${m.label} to begin` : 'Start moving to begin, or tap Start now';
  } else if (isTransition) {
    hero.textContent = formatTime(v.segElapsed);
    caption.textContent = `changeover · the clock is running · the next leg starts when you move`;
  } else if (v.seg.kind === 'distance') {
    hero.textContent = Math.ceil(v.remaining).toLocaleString('en-US');
    caption.textContent = `metres to go · ${formatTime(v.segElapsed)} elapsed`;
  } else if (v.seg.kind === 'time') {
    hero.textContent = formatTime(Math.ceil(v.remaining));
    caption.textContent = isRest ? 'rest remaining' : `remaining · ${formatDistance(v.segDistance)}`;
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

  renderPacePanel(v, m, isRest);
  const avg = trackRepAverages(v, isRest);
  const targetWatts = !isRest && v.seg.targetPace ? Math.round(m.watts(m.paceUnit / v.seg.targetPace)) : null;

  $('#w-cadence').textContent = v.cadence ? Math.round(v.cadence) : '--';
  $('#w-power').textContent = v.power ? Math.round(v.power) : '--';
  $('#w-hr').textContent = v.heartRate ?? '--';
  $('#w-cadence-sub').textContent = avg.cadence ? `avg ${Math.round(avg.cadence)}` : '';
  $('#w-power-sub').textContent = targetWatts ? `target ${targetWatts}` : avg.power ? `avg ${Math.round(avg.power)}` : '';
  $('#w-hr-sub').textContent = avg.heartRate ? `avg ${Math.round(avg.heartRate)}` : '';

  $('#w-seg-pace').textContent = formatPace(v.segPace);
  const proj = !isRest && v.state === 'running' && v.projected ? v.projected : null;
  $('#w-proj-label').textContent = v.seg.kind === 'time' ? 'Projected' : 'Finish';
  $('#w-proj').textContent = proj == null || v.seg.kind === 'open' ? '--'
    : v.seg.kind === 'distance' ? formatTime(proj, true) : formatDistance(proj);
  $('#w-dist').textContent = formatDistance(v.totalDistance);
  $('#w-time').textContent = formatTime(v.totalElapsed);
  renderPieces(e, v, m);
  $('#start-now').hidden = v.state !== 'armed';
}

// How far the live split can be from the target before the band marker pins to the edge (s).
const BAND_RANGE = 3;
const BAND_ON_TARGET = 1.5;

function renderPacePanel(v, m, isRest) {
  const panel = $('#w-pace-panel');
  $('#w-pace').textContent = formatPace(v.pace);
  const target = isRest ? null : v.seg.targetPace;
  const band = $('#w-band');
  if (!target) {
    $('#w-target-label').textContent = 'Rep average';
    $('#w-target-value').textContent = formatPace(v.segPace);
    $('#w-target-delta').textContent = '';
    band.hidden = true;
    delete panel.dataset.state;
    return;
  }
  $('#w-target-label').textContent = 'Target';
  $('#w-target-value').textContent = formatPace(target);
  band.hidden = false;
  if (v.pace == null) {
    $('#w-target-delta').textContent = '';
    $('#w-band-marker').style.left = '50%';
    delete panel.dataset.state;
    return;
  }
  const delta = v.pace - target; // positive = slower than target
  const shown = Math.abs(delta) < 0.05 ? 'on target' : `${Math.abs(delta).toFixed(1)}s ${delta < 0 ? 'faster' : 'slower'}`;
  $('#w-target-delta').textContent = shown;
  panel.dataset.state = Math.abs(delta) <= BAND_ON_TARGET ? 'on' : delta < 0 ? 'fast' : 'slow';
  const pos = 50 + Math.max(-1, Math.min(1, delta / BAND_RANGE)) * 50;
  $('#w-band-marker').style.left = `${pos}%`;
}

// Average stroke rate, watts and heart rate over the current piece, sampled as the screen updates.
function trackRepAverages(v, isRest) {
  if (!state.rep || state.rep.segIndex !== v.segIndex) state.rep = { segIndex: v.segIndex, sums: {}, counts: {} };
  const r = state.rep;
  if (!isRest && v.state === 'running') {
    for (const key of ['cadence', 'power', 'heartRate']) {
      if (v[key] > 0) { r.sums[key] = (r.sums[key] ?? 0) + v[key]; r.counts[key] = (r.counts[key] ?? 0) + 1; }
    }
  }
  return Object.fromEntries(['cadence', 'power', 'heartRate'].map((k) => [k, r.counts[k] ? r.sums[k] / r.counts[k] : null]));
}

// Completed work pieces, for interval workouts. Shown in the side column on big screens.
function renderPieces(e, v, m) {
  const panel = $('#w-pieces');
  const hasSplits = e.workout.segments.some((x) => splitForSegment(e.workout, x));
  const show = v.works > 1 || hasSplits;
  panel.dataset.show = String(show);
  $('#view-workout').dataset.side = show ? 'full' : 'empty';
  if (!show) return;
  const done = e.laps.filter((l) => l.type === 'work');
  const key = `${done.length}:${v.segIndex}:${v.splits.length}`;
  if (state.piecesKey === key) return;
  state.piecesKey = key;
  $('#w-pieces-title').textContent = hasSplits ? 'Splits' : 'Pieces';
  $('#w-pieces-pace').textContent = e.multi ? 'Split' : `/${m.paceUnit}m`;
  const single = v.works === 1;
  const row = (label, l, cls = '') => {
    const delta = l.targetPace && l.pace ? l.pace - l.targetPace : null;
    const vsCls = delta == null ? '' : delta <= 0 ? 'ahead' : 'behind';
    const vs = delta == null ? '' : `${delta <= 0 ? '−' : '+'}${Math.abs(delta).toFixed(1)}s`;
    const pace = e.multi && machineInfo(l.machine).paceUnit !== 500 ? `${formatPace(l.pace)} /1k` : formatPace(l.pace);
    return `<tr class="${cls}"><td>${label}</td><td>${pace}</td><td>${l.avgCadence || '--'}</td><td>${l.avgPower || '--'}</td><td>${l.avgHr ?? '--'}</td><td class="${vsCls}">${vs}</td></tr>`;
  };
  // Split labels: 1, 2, 3 for a single piece; 2.1, 2.2 for the splits of piece 2.
  const splitLabel = (piece, k) => (single ? String(k + 1) : `${piece}.${k + 1}`);
  const rows = [];
  done.forEach((l, i) => {
    const multiSplits = l.splits?.length > 1;
    if (!single) rows.push(row(e.multi ? `${i + 1} ${shortName(l.machine)}` : i + 1, l, multiSplits ? 'piece' : ''));
    if (multiSplits) l.splits.forEach((sp, k) => rows.push(row(splitLabel(i + 1, k), sp, single ? '' : 'split')));
  });
  if (v.seg.type === 'work' && done.length < v.works) {
    const n = done.length + 1;
    v.splits.forEach((sp, k) => rows.push(row(splitLabel(n, k), sp, single ? '' : 'split')));
    const label = v.split ? splitLabel(n, v.splits.length) : n;
    rows.push(`<tr class="current"><td>${label}</td><td colspan="5">in progress</td></tr>`);
  }
  $('#w-pieces-body').innerHTML = rows.join('');
  const wrap = $('#w-pieces-wrap');
  wrap.scrollTop = wrap.scrollHeight; // keep the newest split in view
}

// Multi-erg: one chip per machine, so a monitor that fell asleep is spotted before the changeover.
function renderMachineStatus(e) {
  const el = $('#w-machines');
  el.hidden = !e.multi;
  if (!e.multi) return;
  const active = e.machineOf(e.segment);
  const html = machinesIn(e.workout).map((m) => {
    const conn = connFor(m);
    const st = !conn ? 'off' : conn.connected === false ? 'waiting' : 'on';
    const note = st === 'waiting' ? ' · reconnecting' : st === 'off' ? ' · not connected' : '';
    return `<span class="chip" data-on="${st === 'on'}" data-state="${st}"${m === active ? ' aria-current="true"' : ''}>${shortName(m)}${note}</span>`;
  }).join('');
  if (el.innerHTML !== html) el.innerHTML = html;
}

function renderSimEffort() {
  const sim = allErgs().find((c) => c.kind === 'sim')?.device;
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
  state.summaryWorkout = state.engine?.workout ?? state.workout;
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
  if (logbook.connected && logbook.config.autoSync && canLog(summary)) sendToLogbook();
}

function renderSummary(s) {
  const m = machineInfo(s.machine);
  $('#lb-send').hidden = !logbook.connected || !canLog(s);
  $('#lb-send').disabled = false;
  setSendStatus('');
  $('#s-title').textContent = s.name;
  $('#s-date').textContent = `${new Date(s.startTime).toLocaleString()} · ${machineLabel(s.machine)}`;
  const changeovers = s.laps.filter((l) => l.type === 'transition');
  const stats = [
    ['Distance', formatDistance(s.totalDistance)],
    ['Time', formatTime(s.elapsed, true)],
    s.multi
      ? ['Changeovers', changeovers.length ? formatTime(changeovers.reduce((a, l) => a + l.duration, 0), true) : '--']
      : [`Work pace /${m.paceUnit}m`, formatPace(s.workPace)],
    ['Avg watts', s.avgPower || '--'],
    ...(s.multi ? [] : [[`Avg ${m.cadenceUnit}`, s.avgCadence || '--']]),
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
  $('#s-pace-head').textContent = s.multi ? 'Split' : `/${m.paceUnit}m`;
  $('#s-cad-head').textContent = s.multi ? 'Rate' : m.cadenceUnit.toUpperCase();
  let n = 0;
  const makeRow = (cells, cls) => {
    const tr = document.createElement('tr');
    if (cls) tr.className = cls;
    for (const c of cells) {
      const td = document.createElement('td');
      td.textContent = c;
      tr.append(td);
    }
    return tr;
  };
  $('#s-laps').replaceChildren(...s.laps.flatMap((l) => {
    const off = l.type !== 'work';
    const unitNote = s.multi && machineInfo(l.machine).paceUnit !== 500 ? ' /1k' : '';
    const label = l.type === 'rest' ? 'rest' : l.type === 'transition' ? 'change' : s.multi ? `${++n} ${shortName(l.machine)}` : String(++n);
    const rows = [makeRow([
      label,
      formatTime(l.duration, true),
      Math.round(l.distance).toLocaleString('en-US'),
      off ? '--' : formatPace(l.pace) + unitNote,
      l.avgPower || '--',
      off ? '--' : l.avgCadence || '--',
      l.avgHr ?? '--',
    ], off ? 'rest' : '')];
    if (!off && l.splits?.length > 1) {
      for (const sp of l.splits) {
        rows.push(makeRow([
          `${label}.${sp.index + 1}`,
          formatTime(sp.duration, true),
          Math.round(sp.distance).toLocaleString('en-US'),
          formatPace(sp.pace) + unitNote,
          sp.avgPower || '--',
          sp.avgCadence || '--',
          sp.avgHr ?? '--',
        ], 'split'));
      }
    }
    return rows;
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

// ---------- Concept2 Logbook ----------

function setLogbookStatus(text, kind = '') {
  const el = $('#lb-status');
  el.textContent = text;
  el.dataset.state = kind;
}

async function renderLogbook() {
  $('#lb-server').value = logbook.config.serverUrl;
  $('#lb-weight').value = logbook.config.weightClass;
  $('#lb-auto').checked = logbook.config.autoSync;
  $('#lb-connect').textContent = logbook.connected ? 'Disconnect Logbook' : 'Connect Logbook';
  renderHistoryStatus();
  if (!logbook.connected) { setLogbookStatus('Not connected.'); return; }
  setLogbookStatus('Connected.', 'ok');
  try {
    const u = logbook.user ?? (await logbook.me());
    setLogbookStatus(`Connected as ${u.username || u.first_name || 'you'}.`, 'ok');
    refreshLogbookHistory();
  } catch (err) {
    setLogbookStatus(`Connected, but the Logbook didn't answer: ${err.message}`, 'error');
  }
}

function setSendStatus(text, kind = '') {
  const el = $('#lb-send-status');
  el.textContent = text;
  el.dataset.state = kind;
}

// Concept2 machines only. A multi-erg workout goes up as one result per machine.
const canLog = (s) => (s.multi ? splitByMachine(s).some((p) => LOGBOOK_TYPES[p.machine]) : !!LOGBOOK_TYPES[s.machine]);

async function sendToLogbook() {
  const s = state.summary;
  if (!s) return;
  if (!logbook.connected) { setSendStatus('Connect the Logbook in Settings first.', 'error'); return; }
  const btn = $('#lb-send');
  btn.disabled = true;
  setSendStatus('Sending to the Concept2 Logbook…');
  try {
    if (s.multi) {
      const parts = splitByMachine(s).filter((p) => LOGBOOK_TYPES[p.machine]);
      const saved = [];
      for (const p of parts) {
        const r = await logbook.upload(buildLogbookResult(p.summary, p.workout, { weightClass: logbook.config.weightClass }));
        saved.push(`${machineInfo(p.machine).label}${r.duplicate ? ' (already there)' : ''}`);
        setSendStatus(`Saved ${saved.join(', ')}…`);
      }
      setSendStatus(`Saved to your Concept2 Logbook: ${saved.join(', ')}.`, 'ok');
      return;
    }
    const result = buildLogbookResult(s, state.summaryWorkout, { weightClass: logbook.config.weightClass });
    const r = await logbook.upload(result);
    setSendStatus(r.duplicate ? 'Already in your Logbook.' : 'Saved to your Concept2 Logbook.', 'ok');
    refreshLogbookHistory({ force: true });
  } catch (err) {
    setSendStatus(`Not saved: ${err.message}`, 'error');
    btn.disabled = false;
  }
}

// ---------- multi-erg form ----------

const MULTI_DEFAULTS = {
  distance: { circuit: '500', legs: ['2000', '4000', '2000'] },
  time: { circuit: '4:00', legs: ['10:00', '10:00', '10:00'] },
};

function setupMultiForm() {
  const form = $('#multi-form');
  const order = ['rower', 'bikeerg', 'ski'];
  ['m1', 'm2', 'm3'].forEach((name, i) => {
    const sel = form[name];
    sel.replaceChildren(...MULTI_MACHINES.map((m) => new Option(machineInfo(m).label, m, false, m === order[i])), new Option('None', ''));
  });
  const sync = () => {
    const format = form.format.value;
    form.dataset.format = format;
    $('#multi-format-hint').textContent = format === 'circuit'
      ? 'The same leg on each machine in turn, round after round.'
      : 'One leg on each machine, back to back.';
    const time = form.kind.value === 'time';
    for (const el of form.querySelectorAll('.multi-value-label')) {
      el.textContent = el.closest('[data-for="circuit"]') ? (time ? 'Each leg (m:ss)' : 'Each leg (m)') : time ? 'Time (m:ss)' : 'Distance (m)';
    }
  };
  for (const r of form.querySelectorAll('[name="format"]')) r.addEventListener('change', sync);
  form.kind.addEventListener('change', () => {
    const d = MULTI_DEFAULTS[form.kind.value];
    form.value.value = d.circuit;
    ['v1', 'v2', 'v3'].forEach((n, i) => { form[n].value = d.legs[i]; });
    sync();
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const { workout, error } = readMultiForm(form);
    $('#multi-error').textContent = error ?? '';
    if (workout) selectWorkout(workout);
  });
  sync();
}

function readMultiForm(form) {
  const kind = form.kind.value;
  const parse = (text) => (kind === 'time' ? parseDuration(text) : Number(String(text).trim()));
  const slots = [['m1', 'v1'], ['m2', 'v2'], ['m3', 'v3']].map(([m, v]) => ({ machine: form[m].value, value: parse(form[v].value) })).filter((x) => x.machine);
  const unitHelp = kind === 'time' ? 'as m:ss, e.g. 4:00' : 'in metres, e.g. 500';
  try {
    if (form.format.value === 'circuit') {
      const rounds = Number(form.rounds.value);
      const value = parse(form.value.value);
      if (!Number.isInteger(rounds) || rounds < 1) return { error: 'Rounds must be a whole number of at least 1.' };
      if (!Number.isFinite(value) || value <= 0) return { error: `Enter each leg ${unitHelp}.` };
      return { workout: buildCircuit({ machines: slots.map((x) => x.machine), rounds, kind, value, matchBike: form.matchBike.checked }) };
    }
    if (slots.some((x) => !Number.isFinite(x.value) || x.value <= 0)) return { error: `Enter each machine's leg ${unitHelp}.` };
    return { workout: buildErgathlon(slots.map((x) => ({ ...x, kind }))) };
  } catch (err) {
    return { error: err.message };
  }
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

  setupMultiForm();
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
  $('#split-input').addEventListener('input', (ev) => {
    settings.splitPrefs = { ...settings.splitPrefs, [state.workout.name]: ev.target.value.trim() };
    store.set(SETTINGS_KEY, settings);
    setPushStatus('');
    checkSplitInput();
  });
  renderSplitSetting();
  $('#start-now').addEventListener('click', () => state.engine?.startNow(Date.now()));
  $('#end').addEventListener('click', () => {
    const e = state.engine;
    if (!e) return;
    if (e.state === 'running' && !confirm('End this workout now?')) return;
    const summary = e.end(Date.now());
    if (!summary) finishWorkout(null); // never started; onFinish handles the rest
  });
  const adjustSims = (d) => { for (const c of allErgs()) c.device.adjustEffort?.(d); renderSimEffort(); };
  $('#sim-slower').addEventListener('click', () => adjustSims(-0.05));
  $('#sim-faster').addEventListener('click', () => adjustSims(0.05));

  $('#dl-fit').addEventListener('click', () => {
    const s = state.summary;
    if (s) download(encodeFit(s, { device: settings.fitDevice }), `${fileStem(s)}.fit`, 'application/vnd.ant.fit');
  });
  $('#dl-csv').addEventListener('click', () => {
    const s = state.summary;
    if (s) download(lapsToCsv(s), `${fileStem(s)}_splits.csv`, 'text/csv');
  });
  $('#lb-send').addEventListener('click', sendToLogbook);
  $('#lb-refresh').addEventListener('click', () => refreshLogbookHistory({ force: true }));
  $('#suggest-apply').addEventListener('click', () => {
    if (state.suggestion) selectWorkout(applyTargets(state.workout, state.suggestion));
  });
  $('#lb-server').addEventListener('change', (e) => logbook.saveConfig({ serverUrl: e.target.value.trim() }));
  $('#lb-weight').addEventListener('change', (e) => logbook.saveConfig({ weightClass: e.target.value }));
  $('#lb-auto').addEventListener('change', (e) => logbook.saveConfig({ autoSync: e.target.checked }));
  $('#lb-connect').addEventListener('click', () => {
    if (logbook.connected) {
      logbook.disconnect();
      renderLogbook();
      return;
    }
    logbook.saveConfig({ serverUrl: $('#lb-server').value.trim() });
    try {
      logbook.login();
    } catch (err) {
      setLogbookStatus(err.message, 'error');
    }
  });
  const redirect = logbook.handleRedirect();
  renderLogbook().then(() => { if (redirect?.error) setLogbookStatus(redirect.error, 'error'); });
  if (redirect) $('#lb-status').scrollIntoView({ block: 'center' });

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
