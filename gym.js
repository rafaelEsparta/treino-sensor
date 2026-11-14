// App de treino para celular: conta repetições e descanso com o WT901BLE67
// preso na pilha de pesos. Usa Web Bluetooth (Chrome no Android).
import { Commands, FrameParser, UUID, interpretRegister } from './src/witmotion.js';
import { DEFAULTS, RepCounter } from './src/repcounter.js';
import { simulate, workoutScript } from './src/simulator.js';
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
const DEFAULT_REST = 90;
// Exercícios padrão: [nome, carga sugerida em kg para iniciante de 80 kg].
// São pontos de partida conservadores; a numeração varia entre máquinas.
const DEFAULT_EXERCISES = [
  ['Agachamento livre', 40, 'Quadríceps'], // barra de 20 kg + 10 kg de cada lado
  ['Leg press 45', 80, 'Quadríceps'],
  ['Leg press horizontal', 60, 'Quadríceps'],
  ['Cadeira extensora', 30, 'Quadríceps'],
  ['Cadeira abdutora', 30, 'Glúteos'],
  ['Cadeira adutora', 30, 'Adutores'],
  ['Stiff', 30, 'Posteriores'],
  ['Mesa flexora', 20, 'Posteriores'],
  ['Cadeira flexora', 25, 'Posteriores'],
  ['Puxada alta', 30, 'Costas'],
  ['Remada baixa', 30, 'Costas'],
];
const DEFAULT_STEP = 5;
const newDefault = ([name, load, muscle]) => ({ id: uid(), name, rest: DEFAULT_REST, sets: 3, reps: 12, load, step: DEFAULT_STEP, muscle, suggested: true });
const defaultStore = () => ({
  version: 3,
  exercises: DEFAULT_EXERCISES.map(newDefault),
  history: [],
  settings: { sound: true, vibrate: true, ...Object.fromEntries(DETECTION.map((k) => [k, DEFAULTS[k]])) },
});
function loadStore() {
  const base = defaultStore();
  try {
    const saved = JSON.parse(localStorage.getItem(KEY));
    if (saved && Array.isArray(saved.exercises)) {
      const merged = { ...base, ...saved, settings: { ...base.settings, ...saved.settings } };
      if (!(saved.version >= 2)) migrateToV2(merged);
      if (!(saved.version >= 3)) migrateToV3(merged);
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
const store = loadStore();
function save() {
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

async function keepAwake(on) {
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
document.addEventListener('visibilitychange', () => keepAwake(Boolean(active)));

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
  chip.textContent = { off: 'Conectar sensor', connecting: 'Conectando…', on: 'Sensor conectado', sim: 'Demonstração' }[mode];
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
const TITLES = { home: 'Exercícios', progress: 'Progresso', history: 'Histórico', settings: 'Ajustes' };
function show(next) {
  view = next;
  for (const v of ['home', 'workout', 'progress', 'history', 'settings']) $(v).hidden = v !== next;
  $('tabs').hidden = next === 'workout';
  $('title').textContent = next === 'workout' ? active.exercise.name : TITLES[next];
  for (const b of $('tabs').children) b.classList.toggle('on', b.dataset.view === next);
  if (next === 'home') renderExercises();
  if (next === 'history') renderHistory();
  if (next === 'progress') renderProgress();
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
function renderExercises() {
  $('exList').innerHTML = store.exercises.length
    ? store.exercises
        .map((ex) => `<li><button class="go" data-id="${ex.id}"><em>${esc(ex.muscle || 'Outro')}</em><b>${esc(ex.name)}</b><small>${describe(ex)}</small></button><button class="edit" data-edit="${ex.id}">Editar</button></li>`)
        .join('')
    : '<li class="empty">Nenhum exercício. Crie o primeiro abaixo.</li>';
}
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
$('btnRestPlus').onclick = () => {
  active.restTarget += 15;
  active.restAlerted = false;
  dirty = true;
};
$('btnRestMinus').onclick = () => {
  active.restTarget = Math.max(5, active.restTarget - 15);
  dirty = true;
};

function renderWorkout() {
  const ex = active.exercise;
  const resting = rc.state === 'rest' && active.restWallStart !== null;
  const done = rc.sets.length;
  $('wWarn').hidden = sensor.mode === 'on' || sensor.mode === 'sim';
  const closedVolume = rc.sets.reduce((sum, s) => sum + s.reps * (s.load ?? ex.load ?? 0), 0);
  const volume = closedVolume + (rc.state === 'set' ? rc.reps * (ex.load || 0) : 0);
  $('wInfo').textContent = `${ex.sets} × ${ex.reps} · descanso ${ex.rest} s · volume ${int(volume)} kg`;
  $('wLoadHint').hidden = !ex.suggested;
  const sug = active.suggestion;
  $('wSuggest').hidden = !sug || rc.sets.length > 0 || (ex.load || 0) >= sug.load;
  if (sug) {
    $('wSuggestText').textContent = `Você fez ${sug.sets} × ${sug.reps} com ${kg(sug.from)} na última vez. Hora de subir.`;
    $('btnSuggest').textContent = `Usar ${kg(sug.load)}`;
  }
  $('wCard').classList.toggle('dim', resting);
  $('wReps').textContent = resting ? rc.sets[done - 1].reps : rc.reps;
  $('wTarget').textContent = `/ ${ex.reps}`;
  $('wSet').textContent = `Série ${resting ? done : rc.setIndex || 1} de ${ex.sets}`;
  $('wStatus').textContent = resting ? 'Série encerrada' : rc.state === 'set' ? 'Contando' : 'Pronto. Comece a série.';
  $('btnEndSet').disabled = rc.state !== 'set';
  $('restCard').hidden = !resting;
  if (resting) {
    const elapsed = (Date.now() - active.restWallStart) / 1000;
    const rem = active.restTarget - elapsed;
    const over = rem <= 0;
    $('restCard').classList.toggle('done', over);
    $('restTime').textContent = over ? `+${mmss(-rem)}` : mmss(Math.ceil(rem));
    $('restBar').style.width = `${Math.min(100, (elapsed / active.restTarget) * 100)}%`;
    $('restTarget').textContent = `de ${mmss(active.restTarget)}`;
    $('restLabel').textContent = !over ? 'Descanso' : done >= ex.sets ? 'Descanso concluído. Séries planejadas feitas.' : 'Descanso concluído. Próxima série!';
    if (over && !active.restAlerted) {
      active.restAlerted = true;
      beep(660, 250, 3);
      vibrate([300, 150, 300, 150, 300]);
    }
  }
  $('wSets').innerHTML = rc.sets
    .map((s, i) => `<li${s.pr ? ' class="pr"' : ''}>${i + 1}ª <b>${s.reps}</b> reps${s.load ? ` × ${kg(s.load)}` : ''}${s.pr ? '<em>★ recorde</em>' : ''}${s.restActual === null ? '' : `<small>descanso ${mmss(s.restActual)}</small>`}</li>`)
    .join('');
}

// ---------- histórico ----------
function renderHistory() {
  const days = new Map();
  for (const e of [...store.history].reverse()) {
    const day = new Date(e.date).toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
    if (!days.has(day)) days.set(day, []);
    days.get(day).push(e);
  }
  $('btnClearHist').hidden = !store.history.length;
  $('histList').innerHTML = days.size
    ? [...days]
        .map(([day, entries]) => `<div class="day"><h2>${esc(day)}</h2>${entries
          .map((e) => {
            const loads = e.sets.map((s) => s.load ?? e.load ?? null);
            const same = loads.every((l) => l === loads[0]);
            const title = same && loads[0] ? ` · ${kg(loads[0])}` : '';
            const reps = same
              ? `${e.sets.map((s) => `${s.reps}${s.pr ? '★' : ''}`).join(' · ')} reps`
              : e.sets.map((s, i) => `${s.reps} × ${loads[i] ? kg(loads[i]) : 'sem carga'}${s.pr ? '★' : ''}`).join(' · ');
            const rests = e.sets.filter((s) => s.rest !== null).map((s) => mmss(s.rest));
            return `<div class="entry"><b>${esc(e.name)}${title}</b><span>${reps}${rests.length ? ` · descansos ${rests.join(', ')}` : ''}</span></div>`;
          })
          .join('')}</div>`)
        .join('')
    : '<p class="empty">Nenhum treino registrado ainda.</p>';
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
    store.version = 3;
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

if (!navigator.bluetooth) {
  $('unsupported').hidden = false;
  $('conn').disabled = true;
}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
fillSettings();
setMode('off');
show('home');
requestAnimationFrame(frame);
