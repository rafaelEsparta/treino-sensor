// Lab da câmera: mostra o esqueleto, os ângulos e o contador de pose ao vivo,
// grava os pontos em JSON e reproduz gravações ou sequências sintéticas.
import { FeatureSmoother, POSTURE_TEXT, extractFeatures, packFrame, qualityText, unpackFrame } from './src/pose.js';
import { POSE_EXERCISE, POSE_EXERCISES, PoseRepCounter } from './src/posecounter.js';
import { Script } from './src/posesim.js';
import { PoseCamera, drawSkeleton } from './src/posecam.js';

const $ = (id) => document.getElementById(id);
const fmt = (x, d = 0) => x.toFixed(d).replace('.', ',');
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

const smoother = new FeatureSmoother();
const pc = new PoseRepCounter();
let camera = null;
let replayTimer = null;
let recording = null;
let last = null; // último quadro processado, para a tela

const logLines = [];
function log(text) {
  logLines.push(`${new Date().toLocaleTimeString('pt-BR')}  ${text}`);
  if (logLines.length > 200) logLines.shift();
  $('log').textContent = logLines.join('\n');
  $('log').scrollTop = $('log').scrollHeight;
}

// ---------- processamento de um quadro (câmera, gravação ou simulação) ----------
function handleFrame({ world, image, poses = world ? 1 : 0, dark = false, up, dt }) {
  if (recording) recording.push(packFrame(world, image, dt));
  const f = smoother.update(extractFeatures(world, image, { poses, dark, up }), dt);
  for (const e of pc.update(f, dt)) {
    if (e.type === 'exercise') log(`EXERCÍCIO identificado: ${POSE_EXERCISE[e.id].name}`);
    else if (e.type === 'rep') log(`REP ${e.rep.n}: amplitude ${fmt(e.rep.amp)}°, ${fmt(e.rep.duration, 1)} s`);
    else if (e.type === 'setStart') log(`SÉRIE ${e.index} iniciada`);
    else if (e.type === 'setEnd') {
      log(`SÉRIE ${e.set.index} encerrada: ${POSE_EXERCISE[e.set.exercise].name}, ${e.set.reps} repetições`);
      renderSets();
    } else if (e.type === 'restDone') log('DESCANSO concluído');
  }
  last = { f, image, poses };
}

// ---------- fontes ----------
function setStatus(mode, text) {
  $('status').className = `status ${mode}`;
  $('status').textContent = text;
  $('btnCam').textContent = camera ? 'Desligar câmera' : 'Ligar câmera';
  $('btnSim').textContent = replayTimer ? 'Parar' : 'Reproduzir';
}

function resetPipeline() {
  smoother.reset();
  pc.reset();
  applyExercise();
  renderSets();
}

async function toggleCamera() {
  if (camera) {
    camera.stop();
    camera = null;
    setStatus('off', 'Parado');
    return;
  }
  stopReplay();
  resetPipeline();
  setStatus('off', 'Carregando modelo…');
  try {
    const cam = new PoseCamera($('video'), (frame) => {
      $('fps').textContent = fmt(cam.fps);
      handleFrame(frame);
    });
    await cam.start();
    camera = cam;
    $('stage').classList.remove('plain');
    $('overlay').width = $('video').videoWidth || 640;
    $('overlay').height = $('video').videoHeight || 480;
    setStatus('on', 'Câmera ligada');
    log('Câmera ligada');
  } catch (err) {
    setStatus('off', 'Parado');
    log(`ERRO: ${err.message}`);
  }
}

function stopReplay() {
  if (replayTimer) clearInterval(replayTimer);
  replayTimer = null;
}

/** Reproduz quadros em tempo real, respeitando o dt de cada um. */
function replay(frames, label) {
  if (camera) toggleCamera();
  stopReplay();
  resetPipeline();
  $('stage').classList.add('plain');
  let i = 0;
  let due = performance.now();
  setStatus('sim', label);
  log(`Reproduzindo: ${label} (${frames.length} quadros)`);
  replayTimer = setInterval(() => {
    const now = performance.now();
    let n = 0;
    while (i < frames.length && due <= now && n++ < 30) {
      handleFrame(frames[i]);
      due += frames[i].dt * 1000;
      i++;
    }
    if (n) $('fps').textContent = fmt(1 / frames[Math.max(0, i - 1)].dt);
    if (i >= frames.length) {
      stopReplay();
      setStatus('off', 'Fim da reprodução');
    }
  }, 16);
  setStatus('sim', label);
}

const SIMS = {
  'Três séries: rosca, agachamento, desenvolvimento': () => new Script().hold(1.5).set('rosca', 8).hold(10).set('agachamento', 6).hold(10).set('desenvolvimento', 6).hold(8),
  ...Object.fromEntries(POSE_EXERCISES.map((x) => [x.name, () => new Script().hold(1.5).set(x.id, 6).hold(8)])),
  'Negativo: andar': () => new Script().hold(1).walk(12).hold(3),
  'Negativo: pegar halteres e fazer rosca': () => new Script().hold(1).pickUp().hold(1).set('rosca', 6).hold(6),
};
$('simSel').innerHTML = Object.keys(SIMS).map((k) => `<option>${k}</option>`).join('');
$('btnSim').onclick = () => {
  if (replayTimer) {
    stopReplay();
    setStatus('off', 'Parado');
    return;
  }
  const name = $('simSel').value;
  replay([...SIMS[name]().frames({ seed: Date.now() % 1000 })], `Simulação: ${name}`);
};
$('btnLoad').onclick = () => $('file').click();
$('file').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.frames)) throw new Error('arquivo sem a lista "frames"');
    replay(data.frames.map(unpackFrame), `Gravação: ${file.name}`);
  } catch (err) {
    log(`ERRO ao abrir a gravação: ${err.message}`);
  }
};
$('btnCam').onclick = toggleCamera;

// ---------- gravação ----------
$('btnRec').onclick = () => {
  const btn = $('btnRec');
  if (!recording) {
    recording = [];
    btn.textContent = 'Parar e baixar JSON';
    btn.classList.add('active');
    return;
  }
  const name = `pose-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`;
  const blob = new Blob([JSON.stringify({ formato: 'treino-sensor/pose/1', frames: recording })], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
  $('recInfo').textContent = `${recording.length} quadros salvos em ${name}`;
  recording = null;
  btn.textContent = 'Gravar pontos (JSON)';
  btn.classList.remove('active');
};

// ---------- contador ----------
$('exSel').innerHTML = `<option value="">Identificar sozinho</option>${POSE_EXERCISES.map((x) => `<option value="${x.id}">${x.name}</option>`).join('')}`;
function applyExercise() {
  const id = $('exSel').value;
  if (id) pc.setExercise(id, { lock: true });
  else pc.unlock();
}
$('exSel').onchange = () => {
  applyExercise();
  log($('exSel').value ? `Exercício fixado à mão: ${POSE_EXERCISE[$('exSel').value].name}` : 'Identificação automática');
};
$('btnReset').onclick = resetPipeline;

function renderSets() {
  const body = $('sets').tBodies[0];
  body.innerHTML = pc.sets.length
    ? pc.sets
        .map((s) => `<tr><td>${s.index}</td><td>${POSE_EXERCISE[s.exercise].name}</td><td>${s.reps}</td><td>${fmt(s.duration, 1)} s</td><td>${s.restActual === null ? '—' : `${fmt(s.restActual)} s`}</td></tr>`)
        .join('')
    : '<tr class="empty"><td colspan="5">Nenhuma série concluída</td></tr>';
}

// ---------- tela ----------
const ROWS = [['Cotovelo', 'elbow'], ['Ombro (braço x tronco)', 'shoulder'], ['Quadril', 'hip'], ['Joelho', 'knee']];
$('angles').tBodies[0].innerHTML = ROWS.map(([label, key]) => `<tr><td>${label}</td><td id="a_${key}L">—</td><td id="a_${key}R">—</td></tr>`).join('');

function render() {
  if (last) {
    const { f, image, poses } = last;
    drawSkeleton($('overlay'), f.quality === 'sem_corpo' ? null : image);
    for (const [, key] of ROWS) {
      for (const side of ['L', 'R']) {
        const cell = $(`a_${key}${side}`);
        const v = f[key + side];
        cell.textContent = v === null || v === undefined ? 'sem visão' : `${fmt(v)}°`;
        cell.className = v === null || v === undefined ? 'na' : '';
      }
    }
    $('posture').textContent = POSTURE_TEXT[f.posture];
    $('trunk').textContent = f.trunk === null ? '—' : `${fmt(f.trunk)}°`;
    $('quality').textContent = f.quality === 'ok' ? 'Boa' : 'Ruim';
    $('people').textContent = poses;
    $('warn').hidden = f.quality === 'ok';
    $('warn').textContent = qualityText(f.quality);
    $('recCount').textContent = recording ? recording.length : 0;
    const name = pc.exercise ? POSE_EXERCISE[pc.exercise].name : null;
    $('reps').textContent = pc.state === 'rest' ? pc.sets[pc.sets.length - 1].reps : pc.reps;
    $('setNo').textContent = pc.setIndex || '–';
    $('rest').textContent = pc.state === 'rest' ? (pc.restRemaining > 0 ? mmss(Math.ceil(pc.restRemaining)) : `+${mmss(-pc.restRemaining)}`) : '–';
    $('wState').textContent =
      pc.state === 'set' ? `${name}: série ${pc.setIndex} em andamento`
      : pc.state === 'rest' ? `Descansando (último: ${name})`
      : pc.locked ? `${name}: aguardando a primeira repetição` : 'Aguardando movimento';
  }
  requestAnimationFrame(render);
}

setStatus('off', 'Parado');
log('Pronto. Ligue a câmera ou reproduza uma sequência sintética.');
requestAnimationFrame(render);
