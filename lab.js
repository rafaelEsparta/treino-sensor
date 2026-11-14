import { Commands, FrameParser, UUID, interpretRegister, parseHex, toHex } from './src/witmotion.js';
import { RepCounter } from './src/repcounter.js';
import { RollingChart } from './src/chart.js';
import { simulate, workoutScript } from './src/simulator.js';

const $ = (id) => document.getElementById(id);
const fmt = (x, d = 2) => x.toFixed(d).replace('.', ',');
const KNOWN_RATES = [10, 20, 50, 100, 200];

const rc = new RepCounter();
const parser = new FrameParser();
const charts = {
  vel: new RollingChart($('cVel'), { series: [{ name: 'Velocidade', color: '--s1' }], unit: 'm/s', minSpan: 0.4 }),
  acc: new RollingChart($('cAcc'), { series: [{ name: 'X', color: '--s1' }, { name: 'Y', color: '--s2' }, { name: 'Z', color: '--s3' }], unit: 'g', minSpan: 0.4, digits: 3 }),
  gyro: new RollingChart($('cGyro'), { series: [{ name: 'X', color: '--s1' }, { name: 'Y', color: '--s2' }, { name: 'Z', color: '--s3' }], unit: '°/s', minSpan: 20, digits: 1 }),
  ang: new RollingChart($('cAng'), { series: [{ name: 'Roll', color: '--s1' }, { name: 'Pitch', color: '--s2' }, { name: 'Yaw', color: '--s3' }], unit: '°', minSpan: 20, digits: 1 }),
};

let device = null;
let writeChar = null;
let simTimer = null;
let frames = 0;
let streamT = 0; // tempo acumulado do fluxo, em segundos
let arrivals = []; // instantes de chegada dos últimos 2 s
let nominalRate = 10;
let recording = null;
let uiDirty = true;

// ---------- registro ----------
const logLines = [];
function log(text) {
  const time = new Date().toLocaleTimeString('pt-BR');
  logLines.push(`${time}  ${text}`);
  if (logLines.length > 300) logLines.shift();
  const el = $('log');
  el.textContent = logLines.join('\n');
  el.scrollTop = el.scrollHeight;
}

// ---------- som ----------
let audio = null;
function beep(freq, ms, count = 1) {
  if (!$('pSound').checked) return;
  try {
    audio ??= new AudioContext();
    for (let i = 0; i < count; i++) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      const t0 = audio.currentTime + i * (ms / 1000 + 0.12);
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.2, t0);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + ms / 1000);
      osc.connect(gain).connect(audio.destination);
      osc.start(t0);
      osc.stop(t0 + ms / 1000);
    }
  } catch {
    /* sem áudio disponível */
  }
}

// ---------- amostras ----------
function handleSample(s, dt) {
  frames++;
  streamT += dt;
  const events = rc.update(s, dt);
  charts.vel.push(streamT, [rc.vVert]);
  charts.acc.push(streamT, [s.ax, s.ay, s.az]);
  charts.gyro.push(streamT, [s.wx, s.wy, s.wz]);
  charts.ang.push(streamT, [s.roll, s.pitch, s.yaw]);
  if (recording) {
    recording.push([
      Math.round(performance.now()), streamT.toFixed(3),
      s.ax.toFixed(4), s.ay.toFixed(4), s.az.toFixed(4),
      s.wx.toFixed(2), s.wy.toFixed(2), s.wz.toFixed(2),
      s.roll.toFixed(2), s.pitch.toFixed(2), s.yaw.toFixed(2),
      rc.aVert.toFixed(4), rc.vVert.toFixed(4), rc.phase, rc.setIndex, rc.reps,
    ].join(','));
  }
  for (const e of events) onEvent(e);
  uiDirty = true;
}

function onEvent(e) {
  if (e.type === 'rep') {
    beep(880, 70);
    log(`REP ${e.rep.n}: amplitude ${fmt(e.rep.range * 100, 0)} cm, subida ${fmt(e.rep.upDur, 1)} s, descida ${fmt(e.rep.downDur, 1)} s`);
  } else if (e.type === 'setStart') {
    log(`SÉRIE ${e.index} iniciada`);
    renderSets();
  } else if (e.type === 'setEnd') {
    log(`SÉRIE ${e.set.index} encerrada com ${e.set.reps} repetições; descanso de ${rc.cfg.restTarget} s iniciado`);
    renderSets();
  } else if (e.type === 'restDone') {
    beep(660, 250, 3);
    log('DESCANSO concluído');
  }
}

function onNotification(event) {
  const dv = event.target.value;
  const bytes = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
  const now = performance.now();
  for (const { raw, frame } of parser.push(bytes)) {
    if (!frame) continue;
    if (frame.type === 'data') {
      arrivals.push(now);
      if ($('logData').checked && frames % 10 === 0) log(`RX ${toHex(raw)}`);
      handleSample(frame, 1 / nominalRate);
    } else {
      onRegister(raw, frame);
    }
  }
  while (arrivals.length && arrivals[0] < now - 2000) arrivals.shift();
  if (arrivals.length > 5 && now - arrivals[0] > 1000) {
    const measured = ((arrivals.length - 1) * 1000) / (now - arrivals[0]);
    const near = KNOWN_RATES.reduce((a, b) => (Math.abs(b - measured) < Math.abs(a - measured) ? b : a));
    nominalRate = Math.abs(near - measured) / near < 0.2 ? near : measured;
    $('rate').textContent = `${fmt(measured, 1)} Hz`;
  }
}

function onRegister(raw, frame) {
  const r = interpretRegister(frame);
  let text;
  switch (r.kind) {
    case 'battery':
      text = `bateria ${fmt(r.volts)} V (~${r.percent}%)`;
      $('battery').textContent = `${fmt(r.volts)} V · ${r.percent}%`;
      break;
    case 'temperature':
      text = `temperatura ${fmt(r.celsius, 1)} °C`;
      $('temp').textContent = `${fmt(r.celsius, 1)} °C`;
      break;
    case 'magnetometer':
      text = `magnetômetro bruto X=${r.hx} Y=${r.hy} Z=${r.hz}`;
      break;
    case 'quaternion':
      text = `quatérnio ${r.q.map((x) => fmt(x, 4)).join(' ; ')}`;
      break;
    case 'version':
      text = `versão (bruto) ${r.raw}`;
      break;
    default:
      text = `registrador 0x${frame.start.toString(16)}: ${frame.values.join(', ')}`;
  }
  log(`RX ${toHex(raw)}\n          → ${text}`);
}

// ---------- Bluetooth ----------
async function send(bytes, label) {
  if (!writeChar) return;
  try {
    if (writeChar.properties.writeWithoutResponse) await writeChar.writeValueWithoutResponse(bytes);
    else await writeChar.writeValue(bytes);
    log(`TX ${toHex(bytes)}${label ? `  (${label})` : ''}`);
  } catch (err) {
    log(`ERRO ao enviar: ${err.message}`);
  }
}

function setConnected(mode, name) {
  const st = $('status');
  st.className = `status ${mode}`;
  st.textContent = mode === 'on' ? 'Conectado' : mode === 'sim' ? 'Simulador' : 'Desconectado';
  $('devName').textContent = name || '—';
  $('btnConnect').textContent = mode === 'on' ? 'Desconectar' : 'Conectar sensor';
  $('btnSim').textContent = mode === 'sim' ? 'Parar simulador' : 'Simulador';
  $('btnSim').disabled = mode === 'on';
  $('btnConnect').disabled = mode === 'sim' || !navigator.bluetooth;
  for (const b of document.querySelectorAll('[data-ble]')) b.disabled = mode !== 'on';
}

function resetStream() {
  frames = 0;
  streamT = 0;
  arrivals = [];
  rc.reset();
  Object.values(charts).forEach((c) => c.clear());
  renderSets();
  uiDirty = true;
}

async function connect() {
  try {
    device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'WT' }],
      optionalServices: [UUID.service],
    });
    log(`Dispositivo escolhido: ${device.name}`);
    device.addEventListener('gattserverdisconnected', () => {
      log('Sensor desconectado');
      writeChar = null;
      setConnected('off');
    });
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(UUID.service);
    const notifyChar = await service.getCharacteristic(UUID.notify);
    writeChar = await service.getCharacteristic(UUID.write);
    resetStream();
    notifyChar.addEventListener('characteristicvaluechanged', onNotification);
    await notifyChar.startNotifications();
    setConnected('on', device.name);
    log('Notificações ativas. Lendo bateria.');
    await send(Commands.readRegister(0x64), 'ler bateria');
  } catch (err) {
    if (err.name !== 'NotFoundError') log(`ERRO de conexão: ${err.message}`);
    setConnected('off');
  }
}

$('btnConnect').onclick = () => {
  if (device?.gatt?.connected) device.gatt.disconnect();
  else connect();
};

// ---------- simulador ----------
function toggleSim() {
  if (simTimer) {
    clearInterval(simTimer);
    simTimer = null;
    setConnected('off');
    return;
  }
  resetStream();
  const makeGen = () =>
    simulate(
      workoutScript([
        { reps: 8, up: 1, down: 1.5, pauseTop: 0.3, pauseBottom: 0.2, rest: 20 },
        { reps: 6, up: 1.2, down: 1.8, pauseTop: 0.4, rest: 20 },
      ]),
      { rate: 50, seed: Date.now() },
    );
  let gen = makeGen();
  let last = performance.now();
  setConnected('sim', 'Dados sintéticos · 50 Hz');
  $('rate').textContent = '50,0 Hz';
  simTimer = setInterval(() => {
    const now = performance.now();
    let n = Math.min(50, Math.floor((now - last) / 20));
    last += n * 20;
    while (n-- > 0) {
      let next = gen.next();
      if (next.done) {
        gen = makeGen();
        next = gen.next();
      }
      handleSample(next.value, 0.02);
    }
  }, 20);
}
$('btnSim').onclick = toggleSim;

// ---------- comandos ----------
$('btnRate').onclick = async () => {
  const hz = Number($('rateSel').value);
  await send(Commands.setRate(hz), `taxa ${hz} Hz`);
  await new Promise((r) => setTimeout(r, 200));
  await send(Commands.save(), 'salvar configuração');
};
for (const b of document.querySelectorAll('[data-reg]')) {
  b.onclick = () => send(Commands.readRegister(Number(b.dataset.reg)), b.textContent.toLowerCase());
}
$('btnCalib').onclick = async () => {
  if (!confirm('Deixe o sensor imóvel sobre uma superfície plana e nivelada. Calibrar agora?')) return;
  await send(Commands.calibrateAccel(), 'calibrar acelerômetro');
};
$('btnHex').onclick = () => {
  try {
    send(parseHex($('hexIn').value), 'manual');
  } catch (err) {
    log(`ERRO: ${err.message}`);
  }
};
$('btnClearLog').onclick = () => {
  logLines.length = 0;
  $('log').textContent = '';
};

// ---------- gravação ----------
$('btnRec').onclick = () => {
  const btn = $('btnRec');
  if (!recording) {
    recording = ['relogio_ms,t_s,ax_g,ay_g,az_g,wx_dps,wy_dps,wz_dps,roll,pitch,yaw,a_vert_ms2,v_vert_ms,fase,serie,reps'];
    btn.textContent = 'Parar e baixar CSV';
    btn.classList.add('active');
    return;
  }
  const blob = new Blob([recording.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `witmotion-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  $('recInfo').textContent = `${recording.length - 1} amostras salvas em ${a.download}`;
  recording = null;
  btn.textContent = 'Gravar CSV';
  btn.classList.remove('active');
};

// ---------- ajustes ----------
const PARAMS = { pRest: 'restTarget', pRestDetect: 'restDetect', pVelOn: 'velOn', pMinRange: 'minRange', pStillAcc: 'stillAcc' };
for (const [id, key] of Object.entries(PARAMS)) {
  const input = $(id);
  input.value = rc.cfg[key];
  input.onchange = () => {
    const v = Number(input.value);
    if (v > 0) rc.cfg[key] = v;
    else input.value = rc.cfg[key];
  };
}
$('btnReset').onclick = () => {
  rc.reset();
  renderSets();
  uiDirty = true;
  log('Treino zerado; gravidade será reestimada (mantenha o sensor parado por 1 s)');
};

// ---------- tela ----------
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const PHASE = { idle: 'parado', up: 'subindo', top: 'no topo', down: 'descendo' };

function renderSets() {
  const body = $('sets').tBodies[0];
  if (!rc.sets.length) {
    body.innerHTML = '<tr class="empty"><td colspan="6">Nenhuma série concluída</td></tr>';
    return;
  }
  body.innerHTML = rc.sets
    .map((s) => {
      const d = s.repDetails;
      const avg = (f) => d.reduce((acc, r) => acc + f(r), 0) / d.length;
      return `<tr><td>${s.index}</td><td>${s.reps}</td><td>${fmt(s.duration, 1)} s</td>
        <td>${fmt(avg((r) => r.range) * 100, 0)} cm</td>
        <td>${fmt(avg((r) => r.upDur), 1)} / ${fmt(avg((r) => r.downDur), 1)} s</td>
        <td>${s.restActual === null ? '—' : `${fmt(s.restActual, 0)} s de ${s.restTarget}`}</td></tr>`;
    })
    .join('');
}

function render() {
  Object.values(charts).forEach((c) => c.draw());
  if (uiDirty) {
    uiDirty = false;
    $('frames').textContent = frames;
    $('discarded').textContent = parser.discarded;
    $('reps').textContent = rc.state === 'rest' ? rc.sets[rc.sets.length - 1].reps : rc.reps;
    $('setNo').textContent = rc.setIndex || '–';
    $('phase').textContent = PHASE[rc.phase];
    $('aVert').textContent = fmt(rc.aVert);
    $('vVert').textContent = fmt(rc.vVert);
    const box = $('restBox');
    if (rc.state === 'rest') {
      const rem = rc.restRemaining;
      box.classList.toggle('over', rem <= 0);
      $('rest').textContent = rem > 0 ? mmss(Math.ceil(rem)) : `+${mmss(-rem)}`;
      $('restLabel').textContent = rem > 0 ? 'descanso restante' : 'além do descanso';
      $('wState').textContent = rem > 0 ? 'Descansando' : 'Descanso concluído: hora da próxima série';
    } else {
      box.classList.remove('over');
      $('rest').textContent = '–';
      $('restLabel').textContent = 'descanso';
      $('wState').textContent = rc.state === 'set' ? `Série ${rc.setIndex} em andamento` : 'Aguardando a primeira repetição';
    }
  }
  requestAnimationFrame(render);
}

if (!navigator.bluetooth) $('unsupported').hidden = false;
setConnected('off');
log('Pronto. Clique em "Conectar sensor" e escolha o WT901BLE67.');
requestAnimationFrame(render);
