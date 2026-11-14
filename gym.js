// App de treino para celular: conta repetições e descanso com o WT901BLE67
// preso na pilha de pesos. Usa Web Bluetooth (Chrome no Android).
import { Commands, FrameParser, UUID, interpretRegister } from './src/witmotion.js';
import { DEFAULTS, RepCounter } from './src/repcounter.js';
import { simulate, workoutScript } from './src/simulator.js';

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
  ['Agachamento livre', 40], // barra de 20 kg + 10 kg de cada lado
  ['Leg press 45', 80],
  ['Leg press horizontal', 60],
  ['Cadeira extensora', 30],
  ['Cadeira abdutora', 30],
  ['Cadeira adutora', 30],
  ['Stiff', 30],
  ['Mesa flexora', 20],
  ['Cadeira flexora', 25],
  ['Puxada alta', 30],
  ['Remada baixa', 30],
];
const newDefault = ([name, load]) => ({ id: uid(), name, rest: DEFAULT_REST, sets: 3, reps: 12, load, suggested: true });
const defaultStore = () => ({
  version: 2,
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
      if (saved.version !== 2) migrateToV2(merged);
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
  active.restWallStart = Date.now() - alreadyElapsedMs;
  active.restTarget = active.exercise.rest;
  active.restAlerted = false;
  persist();
  dirty = true;
}

/** Copia as séries concluídas para o histórico (cria a entrada na primeira). */
function persist() {
  if (!active || !rc.sets.length) return;
  if (!active.entry) {
    active.entry = { id: uid(), date: new Date().toISOString(), name: active.exercise.name, load: active.exercise.load, sets: [] };
    store.history.push(active.entry);
  }
  active.entry.load = active.exercise.load;
  active.entry.sets = rc.sets.map((s) => ({
    reps: s.reps,
    load: s.load ?? null,
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
const TITLES = { home: 'Exercícios', history: 'Histórico', settings: 'Ajustes' };
function show(next) {
  view = next;
  for (const v of ['home', 'workout', 'history', 'settings']) $(v).hidden = v !== next;
  $('tabs').hidden = next === 'workout';
  $('title').textContent = next === 'workout' ? active.exercise.name : TITLES[next];
  for (const b of $('tabs').children) b.classList.toggle('on', b.dataset.view === next);
  if (next === 'home') renderExercises();
  if (next === 'history') renderHistory();
  dirty = true;
}
for (const b of $('tabs').children) b.onclick = () => show(b.dataset.view);

// ---------- exercícios ----------
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
        .map((ex) => `<li><button class="go" data-id="${ex.id}"><b>${esc(ex.name)}</b><small>${describe(ex)}</small></button><button class="edit" data-edit="${ex.id}">Editar</button></li>`)
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
  keepAwake(true);
  show('workout');
}

function finishExercise() {
  const closed = rc.finishSet();
  if (closed) closed.load = active.exercise.load;
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
  $('wInfo').textContent = `${ex.sets} × ${ex.reps} · descanso ${ex.rest} s`;
  $('wLoadHint').hidden = !ex.suggested;
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
    .map((s, i) => `<li>${i + 1}ª <b>${s.reps}</b> reps${s.load ? ` × ${kg(s.load)}` : ''}${s.restActual === null ? '' : `<small>descanso ${mmss(s.restActual)}</small>`}</li>`)
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
              ? `${e.sets.map((s) => s.reps).join(' · ')} reps`
              : e.sets.map((s, i) => `${s.reps} × ${loads[i] ? kg(loads[i]) : 'sem carga'}`).join(' · ');
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
