// App de treino para celular: conta repetições e descanso com o WT901BLE67
// preso na pilha de pesos. Usa Web Bluetooth (Chrome no Android).
import { Commands, FrameParser, UUID, interpretRegister } from './src/witmotion.js';
import { DEFAULTS, RepCounter } from './src/repcounter.js';
import { simulate, workoutScript } from './src/simulator.js';
import { initFree } from './free.js';
import { DEFAULT_EXERCISES, DEFAULT_REST, DEFAULT_STEP, newDefault as makeDefault } from './src/defaults.js';
import { buildDemoStore } from './src/demodata.js';
import {
  MUSCLES, activityByDay, dayKey, e1rm, e1rmSeries, entryVolume, exerciseEntries, muscleVolume, records, suggestLoad, toCSV, totals, validateImport,
} from './src/stats.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const num = (x, d = 0) => x.toFixed(d).replace('.', ',');
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const uid = () => Math.random().toString(36).slice(2, 10);

// ---------- dados salvos no aparelho ----------
const KEY = 'treino-v1';
const DETECTION = ['restDetect', 'velOn', 'minRange', 'stillAcc'];
// Página /demo: mesmos arquivos, dados fictícios gerados na hora e nada gravado no aparelho.
const DEMO = /\/demo(\/|\/index\.html)?$/.test(location.pathname);
const newDefault = (def) => makeDefault(def, uid());
const defaultStore = () => ({
  version: 4,
  exercises: DEFAULT_EXERCISES.map(newDefault),
  history: [],
  settings: { sound: true, vibrate: true, ...Object.fromEntries(DETECTION.map((k) => [k, DEFAULTS[k]])) },
});
function loadStore() {
  const base = defaultStore();
  if (DEMO) return { ...base, ...buildDemoStore(Date.now()) };
  try {
    const saved = JSON.parse(localStorage.getItem(KEY));
    if (saved && Array.isArray(saved.exercises)) {
      const merged = { ...base, ...saved, settings: { ...base.settings, ...saved.settings } };
      if (!(saved.version >= 2)) migrateToV2(merged);
      if (!(saved.version >= 3)) migrateToV3(merged);
      if (!(saved.version >= 4)) migrateToV4(merged);
      return merged;
    }
  } catch {
    /* armazenamento indisponível: segue com os padrões */
  }
  return base;
}
/** Dados da primeira versão: acrescenta os novos padrões sem apagar nada. */
function migrateToV2(s) {
  for (const def of DEFAULT_EXERCISES) {
    const found = s.exercises.find((x) => x.name === def[0]);
    if (!found) {
      s.exercises.push(newDefault(def));
    } else if (found.load === null || found.load === undefined) {
      // exercício padrão antigo, nunca ajustado: recebe sugestão e descanso novo
      found.load = def[1];
      found.suggested = true;
      if (found.rest === 60) found.rest = DEFAULT_REST;
    }
  }
  s.version = 2;
}
/** Versão 3: grupo muscular e aumento de carga por exercício; histórico ligado ao exercício. */
function migrateToV3(s) {
  const muscleByName = new Map(DEFAULT_EXERCISES.map(([name, , muscle]) => [name, muscle]));
  for (const x of s.exercises) {
    x.muscle ??= muscleByName.get(x.name) || 'Outro';
    x.step ??= DEFAULT_STEP;
  }
  for (const e of s.history) {
    const x = s.exercises.find((y) => y.name === e.name);
    if (x) {
      e.exId ??= x.id;
      e.muscle ??= x.muscle;
    }
  }
  s.version = 3;
}
/** Versão 4: lista de exercícios padrão ampliada (peito, ombros, braços, panturrilha, abdômen). */
function migrateToV4(s) {
  for (const def of DEFAULT_EXERCISES) {
    if (!s.exercises.some((x) => x.name === def[0])) s.exercises.push(newDefault(def));
  }
  s.version = 4;
}
const store = loadStore();
function save() {
  if (DEMO) return; // a demonstração não grava nada no aparelho
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    /* sem armazenamento: o treino continua, só não fica salvo */
  }
}

// ---------- estado ----------
const rc = new RepCounter();
const parser = new FrameParser();
const sensor = { mode: 'off', device: null, write: null, wanted: false, retries: 0, rate: 10, arrivals: [], battery: null };
let active = null; // { exercise, entry, restWallStart, restTarget, restAlerted }
let view = 'home';
let simTimer = null;
let wakeLock = null;
let dirty = true;

function applyDetection() {
  for (const k of DETECTION) rc.cfg[k] = store.settings[k];
}
applyDetection();

// ---------- avisos ----------
let audio = null;
function beep(freq, ms, count = 1) {
  if (!store.settings.sound) return;
  try {
    audio ??= new AudioContext();
    if (audio.state === 'suspended') audio.resume();
    for (let i = 0; i < count; i++) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      const t0 = audio.currentTime + i * (ms / 1000 + 0.12);
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.3, t0);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + ms / 1000);
      osc.connect(gain).connect(audio.destination);
      osc.start(t0);
      osc.stop(t0 + ms / 1000);
    }
  } catch {
    /* sem áudio */
  }
}
let toastTimer = null;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4000);
}
function vibrate(pattern) {
  if (store.settings.vibrate && navigator.vibrate) navigator.vibrate(pattern);
}

let wantAwake = false;
async function keepAwake(on) {
  wantAwake = on;
  try {
    if (on && !wakeLock && 'wakeLock' in navigator && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = null));
    } else if (!on && wakeLock) {
      await wakeLock.release();
    }
  } catch {
    /* sem permissão para manter a tela ligada */
  }
}
document.addEventListener('visibilitychange', () => keepAwake(wantAwake));

// ---------- amostras e eventos do detector ----------
function onSample(s, dt) {
  if (!active) return;
  for (const e of rc.update(s, dt)) {
    if (e.type === 'rep') {
      beep(880, 70);
      vibrate(40);
    } else if (e.type === 'setStart') {
      active.restWallStart = null;
    } else if (e.type === 'setEnd') {
      startRest((rc.t - rc.restStartT) * 1000);
    }
  }
  dirty = true;
}

function startRest(alreadyElapsedMs = 0) {
  // A série que acabou de fechar foi feita com a carga atual.
  const last = rc.sets[rc.sets.length - 1];
  if (last && last.load === undefined) last.load = active.exercise.load;
  checkRecord(last);
  active.restWallStart = Date.now() - alreadyElapsedMs;
  active.restTarget = active.exercise.rest;
  active.restAlerted = false;
  persist();
  dirty = true;
}

/** Compara a série recém-fechada com tudo o que já foi feito neste exercício. */
function checkRecord(set) {
  if (!set || set.pr !== undefined) return;
  set.pr = null;
  if (!set.load || !set.reps) return;
  const previous = exerciseEntries(store.history, active.exercise).filter((e) => e !== active.entry);
  if (!previous.length) return; // primeira vez no exercício: é a referência, não recorde
  const earlier = rc.sets.filter((s) => s !== set).map((s) => ({ reps: s.reps, load: s.load ?? null }));
  const best = records([...previous, { load: null, sets: earlier }]);
  const kinds = [];
  if (set.load > best.maxLoad) kinds.push('carga');
  if (e1rm(set.load, set.reps) > best.bestE1rm + 0.01) kinds.push('1RM estimado');
  if (!kinds.length) return;
  set.pr = kinds;
  toast(`Recorde de ${kinds.join(' e ')}!`);
  beep(1320, 120, 2);
}

/** Copia as séries concluídas para o histórico (cria a entrada na primeira). */
function persist() {
  if (!active || !rc.sets.length) return;
  if (!active.entry) {
    const x = active.exercise;
    active.entry = { id: uid(), date: new Date().toISOString(), name: x.name, exId: x.id, muscle: x.muscle, load: x.load, sets: [] };
    store.history.push(active.entry);
  }
  active.entry.load = active.exercise.load;
  active.entry.sets = rc.sets.map((s) => ({
    reps: s.reps,
    load: s.load ?? null,
    pr: s.pr || null,
    duration: Math.round(s.duration),
    rest: s.restActual === null ? null : Math.round(s.restActual),
    range: s.repDetails.length ? s.repDetails.reduce((a, r) => a + r.range, 0) / s.repDetails.length : null,
  }));
  save();
}

// ---------- Bluetooth ----------
function setMode(mode) {
  sensor.mode = mode;
  const chip = $('conn');
  chip.className = `chip ${mode === 'connecting' ? 'busy' : mode}`;
  $('connText').textContent = { off: 'Conectar', connecting: 'Conectando…', on: sensor.battery ? `Sensor · ${sensor.battery.percent}%` : 'Sensor', sim: 'Demo' }[mode];
  $('sState').textContent = { off: 'Desconectado', connecting: 'Conectando…', on: sensor.device?.name || 'Conectado', sim: 'Modo demonstração' }[mode];
  $('btnDisconnect').disabled = mode !== 'on';
  $('btnDemo').textContent = mode === 'sim' ? 'Parar demonstração' : 'Modo demonstração';
  $('btnDemo').disabled = mode === 'on' || mode === 'connecting';
  if (mode !== 'on' && mode !== 'sim') $('sRate').textContent = '—';
  dirty = true;
}

async function send(bytes) {
  if (!sensor.write) return;
  try {
    if (sensor.write.properties.writeWithoutResponse) await sensor.write.writeValueWithoutResponse(bytes);
    else await sensor.write.writeValue(bytes);
  } catch {
    /* a reconexão cuida de falhas de envio */
  }
}

function onNotification(event) {
  const dv = event.target.value;
  const now = performance.now();
  for (const { frame } of parser.push(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength))) {
    if (!frame) continue;
    if (frame.type === 'data') {
      sensor.arrivals.push(now);
      onSample(frame, 1 / sensor.rate);
    } else {
      const r = interpretRegister(frame);
      if (r.kind === 'battery') {
        sensor.battery = r;
        $('sBattery').textContent = `${num(r.volts, 2)} V · ${r.percent}%`;
        if (sensor.mode === 'on') $('connText').textContent = `Sensor · ${r.percent}%`;
      }
    }
  }
  const a = sensor.arrivals;
  while (a.length && a[0] < now - 2000) a.shift();
  if (a.length > 5 && now - a[0] > 1000) {
    const measured = ((a.length - 1) * 1000) / (now - a[0]);
    const near = [10, 20, 50, 100, 200].reduce((p, c) => (Math.abs(c - measured) < Math.abs(p - measured) ? c : p));
    sensor.rate = Math.abs(near - measured) / near < 0.2 ? near : measured;
    $('sRate').textContent = `${num(measured, 1)} Hz`;
  }
}

async function openGatt() {
  setMode('connecting');
  const server = await sensor.device.gatt.connect();
  const service = await server.getPrimaryService(UUID.service);
  const notify = await service.getCharacteristic(UUID.notify);
  sensor.write = await service.getCharacteristic(UUID.write);
  notify.addEventListener('characteristicvaluechanged', onNotification);
  await notify.startNotifications();
  sensor.arrivals = [];
  sensor.retries = 0;
  setMode('on');
  await send(Commands.readRegister(0x64));
  // 10 Hz (padrão de fábrica) é pouco para contar: sobe para 50 Hz se preciso.
  setTimeout(() => {
    if (sensor.mode === 'on' && sensor.rate < 40) send(Commands.setRate(50));
  }, 3000);
}

async function connect() {
  if (!navigator.bluetooth) return;
  try {
    sensor.device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'WT' }],
      optionalServices: [UUID.service],
    });
    sensor.wanted = true;
    sensor.device.addEventListener('gattserverdisconnected', onDisconnected);
    await openGatt();
  } catch {
    if (sensor.mode !== 'on') setMode('off');
  }
}

async function onDisconnected() {
  sensor.write = null;
  if (!sensor.wanted || sensor.retries >= 8) {
    setMode('off');
    return;
  }
  // Queda de sinal: tenta de novo sozinho, sem pedir para escolher o sensor.
  sensor.retries++;
  setMode('connecting');
  await new Promise((r) => setTimeout(r, Math.min(1000 * sensor.retries, 5000)));
  if (!sensor.wanted) return;
  try {
    await openGatt();
  } catch {
    onDisconnected();
  }
}

function disconnect() {
  sensor.wanted = false;
  if (sensor.device?.gatt?.connected) sensor.device.gatt.disconnect();
  setMode('off');
}

function toggleDemo() {
  if (simTimer) {
    clearInterval(simTimer);
    simTimer = null;
    setMode('off');
    return;
  }
  const makeGen = () =>
    simulate(workoutScript([{ reps: 6, up: 1, down: 1.5, pauseTop: 0.3, pauseBottom: 0.2, rest: 25 }]), { rate: 50, seed: Date.now() });
  let gen = makeGen();
  let last = performance.now();
  setMode('sim');
  $('sRate').textContent = '50,0 Hz';
  simTimer = setInterval(() => {
    const now = performance.now();
    let n = Math.min(100, Math.floor((now - last) / 20));
    last += n * 20;
    while (n-- > 0) {
      let next = gen.next();
      if (next.done) {
        gen = makeGen();
        next = gen.next();
      }
      onSample(next.value, 0.02);
    }
  }, 20);
}

// ---------- navegação ----------
const TITLES = { home: 'Treinar', free: 'Treino livre', progress: 'Progresso', history: 'Histórico', settings: 'Ajustes' };
function show(next) {
  view = next;
  for (const v of ['home', 'workout', 'free', 'progress', 'history', 'settings']) $(v).hidden = v !== next;
  const focused = next === 'workout' || next === 'free';
  $('tabs').hidden = focused;
  $('btnBack').hidden = !focused;
  $('conn').hidden = next === 'free'; // o treino livre não usa o sensor
  $('btnAdd').hidden = next !== 'home';
  $('title').textContent = next === 'workout' ? active.exercise.name : TITLES[next];
  $('subtitle').textContent =
    next === 'workout' ? active.exercise.muscle || ''
    : next === 'free' ? 'câmera · halteres e peso do corpo'
    : next === 'home' ? new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' })
    : '';
  for (const b of $('tabs').children) b.classList.toggle('on', b.dataset.view === next);
  if (next === 'home') renderExercises();
  if (next === 'history') renderHistory();
  if (next === 'progress') renderProgress();
  document.querySelector('main').scrollTop = 0;
  dirty = true;
}
for (const b of $('tabs').children) b.onclick = () => show(b.dataset.view);

// ---------- exercícios ----------
const int = (v) => Math.round(v).toLocaleString('pt-BR');
const kg = (v) => `${num(v, v % 1 ? 1 : 0)} kg`;
function describe(ex) {
  const load = ex.load ? ` · ${kg(ex.load)}${ex.suggested ? ' (sugestão)' : ''}` : '';
  return `${ex.sets} × ${ex.reps}${load} · descanso ${ex.rest} s`;
}
function setLoad(value) {
  const ex = active.exercise;
  ex.load = value > 0 ? Math.round(value * 2) / 2 : null;
  ex.suggested = false;
  save();
  $('wLoad').value = ex.load ?? '';
  dirty = true;
}
let muscleFilter = 'Todos';

function ago(date) {
  const days = Math.round((new Date(dayKey(new Date())) - new Date(dayKey(date))) / 864e5);
  if (days <= 0) return 'hoje';
  if (days === 1) return 'ontem';
  if (days < 14) return `há ${days} dias`;
  if (days < 60) return `há ${Math.round(days / 7)} semanas`;
  return `há ${Math.round(days / 30)} meses`;
}
const initials = (name) => name.split(/\s+/).filter((w) => /[\p{L}\d]/u.test(w)).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
const DOTS = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg>';

function renderWeek() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const todayIdx = (start.getDay() + 6) % 7; // segunda = 0
  start.setDate(start.getDate() - todayIdx);
  const entries = store.history.filter((e) => new Date(e.date) >= start);
  const t = totals(entries);
  const trained = new Set(entries.map((e) => (new Date(e.date).getDay() + 6) % 7));
  $('weekDots').innerHTML = ['S', 'T', 'Q', 'Q', 'S', 'S', 'D']
    .map((d, i) => `<li class="${trained.has(i) ? 'on' : ''}${i === todayIdx ? ' today' : ''}">${d}</li>`)
    .join('');
  $('weekStats').innerHTML = `
    <div><b>${t.days}</b><small>${t.days === 1 ? 'dia de treino' : 'dias de treino'}</small></div>
    <div><b>${t.sets}</b><small>séries</small></div>
    <div><b>${t.volume >= 1000 ? `${num(t.volume / 1000, 1)} t` : `${int(t.volume)} kg`}</b><small>volume</small></div>`;
}

function renderExercises() {
  renderWeek();
  const sensor = store.exercises.filter((x) => !x.pose); // os do treino livre ficam fora desta lista
  const used = MUSCLES.filter((m) => sensor.some((x) => (x.muscle || 'Outro') === m));
  if (!used.includes(muscleFilter)) muscleFilter = 'Todos';
  $('filters').hidden = used.length < 2;
  $('filters').innerHTML = ['Todos', ...used]
    .map((m) => `<button role="tab" aria-selected="${m === muscleFilter}" class="${m === muscleFilter ? 'on' : ''}" data-muscle="${m}">${m}</button>`)
    .join('');
  const list = sensor.filter((x) => muscleFilter === 'Todos' || (x.muscle || 'Outro') === muscleFilter);
  $('exList').innerHTML = list.length
    ? list
        .map((ex) => {
          const entries = exerciseEntries(store.history, ex);
          const last = entries[entries.length - 1];
          const up = suggestLoad(ex, entries);
          const load = ex.load ? ` · ${kg(ex.load)}` : '';
          const lastLine = last
            ? `Último: ${ago(last.date)} · ${last.sets.map((x) => x.reps).join(' · ')}`
            : ex.suggested && ex.load ? 'Carga sugerida para começar' : 'Ainda não feito';
          return `<li><button class="go" data-id="${ex.id}">
            <span class="avatar" aria-hidden="true">${esc(initials(ex.name))}</span>
            <span class="body"><b>${esc(ex.name)}</b>
              <small>${ex.sets} × ${ex.reps}${load} · ${ex.rest} s${up ? '<span class="badge">↑ subir carga</span>' : ''}</small>
              <small class="last">${lastLine}</small></span>
          </button><button class="more" data-edit="${ex.id}" aria-label="Editar ${esc(ex.name)}">${DOTS}</button></li>`;
        })
        .join('')
    : '<li class="empty">Nenhum exercício. Toque em + para criar o primeiro.</li>';
}
$('filters').onclick = (e) => {
  const b = e.target.closest('[data-muscle]');
  if (!b) return;
  muscleFilter = b.dataset.muscle;
  renderExercises();
};
$('exList').onclick = (e) => {
  const go = e.target.closest('[data-id]');
  const edit = e.target.closest('[data-edit]');
  if (go) startExercise(store.exercises.find((x) => x.id === go.dataset.id));
  else if (edit) openEditor(store.exercises.find((x) => x.id === edit.dataset.edit));
};
$('btnAdd').onclick = () => openEditor(null);

let editing = null;
function openEditor(ex) {
  editing = ex;
  $('dlgTitle').textContent = ex ? 'Editar exercício' : 'Novo exercício';
  $('fName').value = ex?.name ?? '';
  $('fRest').value = ex?.rest ?? DEFAULT_REST;
  $('fSets').value = ex?.sets ?? 3;
  $('fReps').value = ex?.reps ?? 12;
  $('fLoad').value = ex?.load ?? '';
  $('fMuscle').innerHTML = MUSCLES.map((m) => `<option>${m}</option>`).join('');
  $('fMuscle').value = ex?.muscle ?? 'Outro';
  $('fStep').value = ex?.step ?? DEFAULT_STEP;
  $('fDelete').hidden = !ex;
  $('dlg').showModal();
}
$('fCancel').onclick = () => $('dlg').close();
$('fDelete').onclick = () => {
  if (!confirm(`Excluir "${editing.name}"? O histórico é mantido.`)) return;
  store.exercises = store.exercises.filter((x) => x !== editing);
  save();
  $('dlg').close();
  renderExercises();
};
$('exForm').onsubmit = () => {
  const data = {
    name: $('fName').value.trim(),
    rest: Number($('fRest').value),
    sets: Number($('fSets').value),
    reps: Number($('fReps').value),
    load: $('fLoad').value === '' ? null : Number($('fLoad').value),
    muscle: $('fMuscle').value,
    step: Number($('fStep').value) || DEFAULT_STEP,
  };
  if (editing) {
    if (data.load !== editing.load) editing.suggested = false;
    Object.assign(editing, data);
  } else {
    store.exercises.push({ id: uid(), ...data, suggested: false });
  }
  save();
  renderExercises();
};

// ---------- treino ----------
function startExercise(ex) {
  beep(1, 1); // destrava o áudio com o toque do usuário
  if (DEMO && sensor.mode === 'off') toggleDemo(); // na demonstração o "sensor" é simulado
  rc.reset();
  applyDetection();
  rc.cfg.restTarget = ex.rest;
  active = { exercise: ex, entry: null, restWallStart: null, restTarget: ex.rest, restAlerted: false };
  $('wLoad').value = ex.load ?? '';
  active.suggestion = suggestLoad(ex, exerciseEntries(store.history, ex));
  keepAwake(true);
  show('workout');
}

function finishExercise() {
  const closed = rc.finishSet();
  if (closed) {
    closed.load = active.exercise.load;
    checkRecord(closed);
  }
  persist();
  active = null;
  keepAwake(false);
  show('home');
}

function adjustReps(d) {
  if (rc.state === 'set') {
    rc.reps = Math.max(0, rc.reps + d);
  } else if (rc.state === 'rest') {
    const last = rc.sets[rc.sets.length - 1];
    last.reps = Math.max(0, last.reps + d);
    persist();
  } else if (d > 0) {
    // Sem nenhuma repetição detectada ainda: abre a série manualmente.
    rc.state = 'set';
    rc.setIndex += 1;
    rc.reps = 1;
    rc.curSetReps = [];
    rc.setStartT = rc.t;
    rc.lastActiveT = rc.t;
  }
  dirty = true;
}
$('btnSuggest').onclick = () => {
  setLoad(active.suggestion.load);
  active.suggestion = null;
};
$('btnLoadPlus').onclick = () => setLoad((active.exercise.load || 0) + 5);
$('btnLoadMinus').onclick = () => setLoad((active.exercise.load || 0) - 5);
$('wLoad').onchange = (e) => setLoad(Number(e.target.value));
$('btnPlus').onclick = () => adjustReps(1);
$('btnMinus').onclick = () => adjustReps(-1);
$('btnEndSet').onclick = () => {
  if (rc.finishSet()) startRest(0);
};
$('btnFinish').onclick = finishExercise;
$('btnBack').onclick = () => (free.open ? free.finish() : finishExercise());
$('btnRestPlus').onclick = () => {
  active.restTarget += 15;
  active.restAlerted = false;
  dirty = true;
};
$('btnRestMinus').onclick = () => {
  active.restTarget = Math.max(5, active.restTarget - 15);
  dirty = true;
};

const RING = 2 * Math.PI * 104;
let shownReps = 0;

function renderWorkout() {
  const ex = active.exercise;
  const resting = rc.state === 'rest' && active.restWallStart !== null;
  const done = rc.sets.length;
  $('wWarn').hidden = sensor.mode === 'on' || sensor.mode === 'sim';

  const sug = active.suggestion;
  $('wSuggest').hidden = !sug || done > 0 || (ex.load || 0) >= sug.load;
  if (sug) {
    $('wSuggestText').textContent = `Você fez ${sug.sets} × ${sug.reps} com ${kg(sug.from)} na última vez. Hora de subir.`;
    $('btnSuggest').textContent = `Usar ${kg(sug.load)}`;
  }
  $('wLoadHint').hidden = !ex.suggested;

  // anel: repetições da série, ou contagem regressiva do descanso
  const hero = $('hero');
  let fraction;
  let over = false;
  if (resting) {
    const elapsed = (Date.now() - active.restWallStart) / 1000;
    const rem = active.restTarget - elapsed;
    over = rem <= 0;
    fraction = over ? 1 : rem / active.restTarget;
    $('wBig').textContent = over ? `+${mmss(-rem)}` : mmss(Math.ceil(rem));
    $('wStatus').textContent = over ? (done >= ex.sets ? 'Séries feitas' : 'Próxima série') : 'Descanso';
    $('wSub').textContent = `última: ${rc.sets[done - 1].reps} reps`;
    $('restTarget').textContent = `de ${mmss(active.restTarget)}`;
    if (over && !active.restAlerted) {
      active.restAlerted = true;
      beep(660, 250, 3);
      vibrate([300, 150, 300, 150, 300]);
    }
    shownReps = 0;
  } else {
    fraction = Math.min(1, rc.reps / ex.reps);
    $('wBig').textContent = rc.reps;
    $('wStatus').textContent = rc.state === 'set' ? `Série ${rc.setIndex}` : 'Pronto';
    $('wSub').textContent = rc.state === 'set' ? `de ${ex.reps}` : 'comece a série';
    if (rc.reps > shownReps) {
      const big = $('wBig');
      big.classList.remove('pulse');
      void big.offsetWidth; // reinicia a animação
      big.classList.add('pulse');
    }
    shownReps = rc.reps;
  }
  hero.classList.toggle('rest', resting);
  hero.classList.toggle('over', over);
  $('ringArc').style.strokeDashoffset = RING * (1 - fraction);
  $('repCtl').hidden = resting;
  $('restCtl').hidden = !resting;

  // uma pílula por série: feitas, a atual e as que faltam
  const slots = Math.max(ex.sets, done + (rc.state === 'set' ? 1 : 0));
  let pills = '';
  for (let i = 0; i < slots; i++) {
    if (i < done) pills += `<li class="done${rc.sets[i].pr ? ' pr' : ''}" aria-label="Série ${i + 1}: ${rc.sets[i].reps} repetições">${rc.sets[i].reps}${rc.sets[i].pr ? '★' : ''}</li>`;
    else if (i === done) pills += `<li class="cur" aria-label="Série ${i + 1}, atual">${rc.state === 'set' ? rc.reps : i + 1}</li>`;
    else pills += `<li aria-label="Série ${i + 1}, a fazer">${i + 1}</li>`;
  }
  $('wPills').innerHTML = pills;

  const closedVolume = rc.sets.reduce((sum, s) => sum + s.reps * (s.load ?? ex.load ?? 0), 0);
  $('wVolume').textContent = `${int(closedVolume + (rc.state === 'set' ? rc.reps * (ex.load || 0) : 0))} kg`;
  $('wGoal').textContent = `${ex.sets} × ${ex.reps}`;
  $('wRestGoal').textContent = mmss(ex.rest);
  $('btnEndSet').disabled = rc.state !== 'set';
  $('wSets').innerHTML = rc.sets
    .map((s, i) => `<li><span>${i + 1}ª série</span><b>${s.reps} reps${s.load ? ` × ${kg(s.load)}` : ''}</b>${s.pr ? '<em>★ recorde</em>' : ''}${s.restActual === null ? '' : `<small>descanso ${mmss(s.restActual)}</small>`}</li>`)
    .join('');
}

// ---------- histórico ----------
function renderHistory() {
  const days = new Map();
  for (const e of [...store.history].reverse()) {
    const key = dayKey(e.date);
    if (!days.has(key)) days.set(key, []);
    days.get(key).push(e);
  }
  $('btnClearHist').hidden = !store.history.length;
  $('histList').innerHTML = days.size
    ? [...days]
        .map(([key, entries]) => {
          const label = new Date(`${key}T12:00:00`).toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
          const t = totals(entries);
          return `<div class="day"><div class="day-head"><h2>${esc(label)}</h2><span>${t.sets} séries · ${tons(t.volume)}</span></div>${entries
            .map((e) => {
              const time = new Date(e.date).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
              const reps = e.sets
                .map((s) => {
                  const load = s.load ?? e.load ?? null;
                  return `<li class="${s.pr ? 'pr' : ''}">${s.reps}${load ? ` <small>× ${kg(load)}</small>` : ''}${s.pr ? ' ★' : ''}</li>`;
                })
                .join('');
              const rests = e.sets.filter((s) => s.rest !== null && s.rest !== undefined).map((s) => mmss(s.rest));
              return `<div class="entry"><div class="entry-top"><b>${esc(e.name)}</b><span>${time}</span></div><ol class="reps">${reps}</ol>${rests.length ? `<p>Descansos: ${rests.join(' · ')}</p>` : ''}</div>`;
            })
            .join('')}</div>`;
        })
        .join('')
    : '<p class="empty">Nenhum treino registrado ainda.<br>Escolha um exercício em Treinar para começar.</p>';
}
$('btnClearHist').onclick = () => {
  if (!confirm('Apagar todo o histórico? Não dá para desfazer.')) return;
  store.history = [];
  save();
  renderHistory();
};

// ---------- progresso ----------
const shortDate = (d) => new Date(d).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
const longDate = (d) => new Date(d).toLocaleDateString('pt-BR', { day: 'numeric', month: 'long', year: 'numeric' });
const tons = (v) => (v >= 10000 ? `${num(v / 1000, 1)} t` : `${int(v)} kg`);

function renderProgress() {
  const h = store.history;
  const t = totals(h);
  const weekStart = new Date();
  weekStart.setHours(0, 0, 0, 0);
  weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7)); // segunda-feira
  const week = totals(h.filter((e) => new Date(e.date) >= weekStart));
  $('pTiles').innerHTML = `
    <div><b>${t.days}</b><small>dias de treino</small></div>
    <div><b>${int(t.sets)}</b><small>séries</small></div>
    <div><b>${tons(t.volume)}</b><small>volume total</small></div>
    <div><b>${week.sets}</b><small>séries nesta semana</small></div>`;
  renderHeat();
  renderMuscles();
  const sel = $('pEx');
  const keep = sel.value;
  const withData = store.exercises.filter((x) => exerciseEntries(h, x).length);
  const list = withData.length ? withData : store.exercises;
  sel.innerHTML = list.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('');
  if (list.some((x) => x.id === keep)) sel.value = keep;
  renderExerciseProgress();
}

function renderHeat() {
  const act = activityByDay(store.history);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7) - 52 * 7); // segunda-feira, 52 semanas atrás
  const cells = [];
  for (let i = 0; i < 53 * 7; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const key = dayKey(d);
    const sets = act.get(key)?.sets || 0;
    const level = sets === 0 ? 0 : sets <= 4 ? 1 : sets <= 9 ? 2 : sets <= 15 ? 3 : 4;
    cells.push(`<i class="${d > today ? 'future' : `l${level}`}" data-day="${key}"></i>`);
  }
  $('pHeat').innerHTML = cells.join('');
  $('pHeatScroll').scrollLeft = $('pHeatScroll').scrollWidth;
  $('pHeat').onclick = (e) => {
    const cell = e.target.closest('[data-day]');
    if (!cell) return;
    $('pHeat').querySelector('.sel')?.classList.remove('sel');
    cell.classList.add('sel');
    const day = act.get(cell.dataset.day);
    const label = longDate(`${cell.dataset.day}T12:00:00`);
    $('pHeatInfo').textContent = day ? `${label}: ${day.sets} séries, ${int(day.volume)} kg` : `${label}: sem treino`;
  };
}

function renderMuscles() {
  const rows = muscleVolume(store.history, Date.now() - 30 * 864e5, store.exercises);
  if (!rows.length) {
    $('pMuscles').innerHTML = '<p class="empty">Nenhum treino nos últimos 30 dias.</p>';
    return;
  }
  const max = rows[0].sets;
  $('pMuscles').innerHTML = rows
    .map((m) => `<div class="mrow"><span>${esc(m.muscle)}</span><div class="track"><i style="width:${(m.sets / max) * 100}%"></i></div><small>${m.sets} séries · ${int(m.volume)} kg</small></div>`)
    .join('');
}

function renderExerciseProgress() {
  const ex = store.exercises.find((x) => x.id === $('pEx').value);
  const entries = ex ? exerciseEntries(store.history, ex) : [];
  $('pReadout').textContent = '';
  if (!entries.length) {
    $('pNext').hidden = true;
    $('pRecs').innerHTML = '';
    $('pTable').innerHTML = '';
    $('pChart').innerHTML = '<p class="empty">Sem registros deste exercício ainda.</p>';
    return;
  }
  const r = records(entries);
  $('pRecs').innerHTML = `
    <div><b>${r.maxLoad ? kg(r.maxLoad) : '—'}</b><small>maior carga</small></div>
    <div><b>${r.bestE1rm ? kg(Math.round(r.bestE1rm)) : '—'}</b><small>1RM estimado</small></div>
    <div><b>${r.maxReps}</b><small>mais reps</small></div>`;
  const up = suggestLoad(ex, entries);
  $('pNext').hidden = !ex.load;
  $('pNext').classList.toggle('up', Boolean(up));
  $('pNextText').innerHTML = up
    ? `<b>Próxima carga sugerida: ${kg(up.load)}</b><br>Você fez ${up.sets} × ${up.reps} com ${kg(up.from)} na última vez.`
    : `<b>Carga atual: ${ex.load ? kg(ex.load) : '—'}</b><br>Sobe para ${kg((ex.load || 0) + (ex.step || DEFAULT_STEP))} quando fechar ${ex.sets} × ${ex.reps}.`;
  const series = e1rmSeries(entries);
  $('pChart').innerHTML = series.length >= 2
    ? lineChart(series)
    : `<p class="hint">${series.length ? 'O gráfico de 1RM estimado aparece a partir do segundo treino com carga.' : 'Registre a carga para acompanhar o 1RM estimado.'}</p>`;
  $('pChart').onclick = (e) => {
    const hit = e.target.closest('[data-i]');
    if (!hit) return;
    const p = series[Number(hit.dataset.i)];
    $('pChart').querySelector('.dot.sel')?.classList.remove('sel');
    $('pChart').querySelector(`.dot[data-d="${hit.dataset.i}"]`).classList.add('sel');
    $('pReadout').textContent = `${longDate(p.date)}: 1RM estimado ${kg(Math.round(p.value))} (${p.reps} × ${kg(p.load)})`;
  };
  $('pTable').innerHTML = `<table class="mini"><thead><tr><th>Data</th><th>Séries</th><th>Volume</th><th>1RM est.</th></tr></thead><tbody>${[...entries]
    .reverse()
    .slice(0, 8)
    .map((e) => {
      const best = e1rmSeries([e])[0];
      const reps = e.sets.map((s) => `${s.reps}${s.pr ? '★' : ''}`).join(' · ');
      return `<tr><td>${shortDate(e.date)}</td><td>${reps}</td><td>${int(entryVolume(e))} kg</td><td>${best ? kg(Math.round(best.value)) : '—'}</td></tr>`;
    })
    .join('')}</tbody></table>`;
}
$('pEx').onchange = renderExerciseProgress;

/** Gráfico de linha em SVG: uma série, um eixo, pontos tocáveis. */
function lineChart(series) {
  const W = 320;
  const H = 170;
  const pad = { l: 36, r: 12, t: 10, b: 22 };
  const values = series.map((p) => p.value);
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (hi - lo < 10) {
    const mid = (hi + lo) / 2;
    lo = mid - 5;
    hi = mid + 5;
  }
  const step = [1, 2, 5, 10, 20, 50, 100].find((s) => (hi - lo) / s <= 4) || 200;
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;
  const x = (i) => pad.l + (i / (series.length - 1)) * (W - pad.l - pad.r);
  const y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);
  let grid = '';
  for (let v = lo; v <= hi + 0.001; v += step) {
    grid += `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
  }
  const path = series.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const dots = series.map((p, i) => `<circle class="dot" data-d="${i}" cx="${x(i)}" cy="${y(p.value)}" r="4"/>`).join('');
  const hits = series.map((p, i) => `<circle class="hit" data-i="${i}" cx="${x(i)}" cy="${y(p.value)}" r="16"/>`).join('');
  const last = series.length - 1;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="1RM estimado ao longo do tempo, em kg">${grid}
    <text x="${pad.l}" y="${H - 5}">${shortDate(series[0].date)}</text>
    <text x="${W - pad.r}" y="${H - 5}" text-anchor="end">${shortDate(series[last].date)}</text>
    <path class="line" d="${path}"/>${dots}${hits}</svg>`;
}

// ---------- dados ----------
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
  $('dataInfo').textContent = `Arquivo ${name} gerado.`;
}
$('btnExport').onclick = () => download(`treino-backup-${dayKey(new Date())}.json`, JSON.stringify(store, null, 2), 'application/json');
$('btnCsv').onclick = () => download(`treinos-${dayKey(new Date())}.csv`, `\ufeff${toCSV(store.history)}`, 'text/csv');
$('btnImport').onclick = () => $('fileImport').click();
$('fileImport').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = validateImport(JSON.parse(await file.text()));
    const msg = `Substituir os dados deste aparelho pelo backup?\n\nBackup: ${data.exercises.length} exercícios e ${data.history.length} registros.\nAtual: ${store.exercises.length} exercícios e ${store.history.length} registros.\n\nNão dá para desfazer.`;
    if (!confirm(msg)) return;
    store.exercises = data.exercises;
    store.history = data.history;
    store.settings = { ...store.settings, ...data.settings };
    store.version = 4;
    save();
    location.reload();
  } catch (err) {
    $('dataInfo').textContent = `Não foi possível importar: ${err.message}`;
  }
};

// ---------- ajustes ----------
const FIELDS = { oRestDetect: 'restDetect', oVelOn: 'velOn', oMinRange: 'minRange', oStillAcc: 'stillAcc' };
function fillSettings() {
  $('oSound').checked = store.settings.sound;
  $('oVibrate').checked = store.settings.vibrate;
  for (const [id, key] of Object.entries(FIELDS)) $(id).value = store.settings[key];
}
$('oSound').onchange = (e) => {
  store.settings.sound = e.target.checked;
  save();
};
$('oVibrate').onchange = (e) => {
  store.settings.vibrate = e.target.checked;
  save();
};
for (const [id, key] of Object.entries(FIELDS)) {
  $(id).onchange = (e) => {
    const v = Number(e.target.value);
    if (v > 0) store.settings[key] = v;
    else e.target.value = store.settings[key];
    applyDetection();
    save();
  };
}
$('btnDefaults').onclick = () => {
  for (const k of DETECTION) store.settings[k] = DEFAULTS[k];
  applyDetection();
  save();
  fillSettings();
};
$('btnDisconnect').onclick = disconnect;
$('btnDemo').onclick = toggleDemo;
$('conn').onclick = () => {
  if (sensor.mode === 'off') connect();
  else if (!active) show('settings');
};

// ---------- laço de tela ----------
let lastTick = 0;
function frame(now) {
  // Durante o descanso o relógio precisa andar mesmo sem amostras novas.
  if (active && (dirty || now - lastTick > 200)) {
    lastTick = now;
    dirty = false;
    renderWorkout();
  }
  requestAnimationFrame(frame);
}

const free = initFree({ store, save, beep, vibrate, toast, keepAwake, show, kg, mmss, int, uid, esc, DEFAULT_REST, demo: DEMO });
$('btnFree').onclick = () => free.start();

if (!navigator.bluetooth) {
  $('conn').disabled = true;
  $('connText').textContent = 'Sem Bluetooth';
}
if ('serviceWorker' in navigator && !DEMO) navigator.serviceWorker.register('sw.js').catch(() => {});
fillSettings();
setMode('off');
if (DEMO) {
  // Faixa fixa avisando que os dados são fictícios, com a saída para o app real.
  document.body.classList.add('is-demo');
  const bar = document.createElement('a');
  bar.className = 'demobar';
  bar.href = './';
  bar.innerHTML = '<b>Demonstração</b> · dados fictícios · <u>sair</u>';
  bar.title = 'Nada do que você fizer aqui é gravado. Toque para ir ao app de verdade.';
  document.querySelector('.top').after(bar);
  $('demoLink').hidden = true;
  // Abre direto no gráfico de progressão de um exercício com sugestão pronta.
  show('progress');
  const leg = store.exercises.find((x) => x.name === 'Leg press 45');
  if (leg) {
    $('pEx').value = leg.id;
    renderExerciseProgress();
  }
} else {
  show('home');
}
requestAnimationFrame(frame);
