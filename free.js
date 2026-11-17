// Treino livre: a câmera identifica o exercício (halteres e peso do corpo),
// conta repetições e descanso, e grava no mesmo histórico do modo com sensor.
import { FeatureSmoother, extractFeatures, qualityText } from './src/pose.js';
import { POSE_EXERCISE, POSE_EXERCISES, PoseRepCounter } from './src/posecounter.js';
import { Script } from './src/posesim.js';
import { e1rm, exerciseEntries, records } from './src/stats.js';

const $ = (id) => document.getElementById(id);
const RING = 2 * Math.PI * 104;

/**
 * @param {object} api o que o app principal empresta: store, save, beep, vibrate,
 *   toast, keepAwake, show, kg, mmss, int, uid, esc, DEFAULT_REST
 */
export function initFree(api) {
  const { store, save, beep, vibrate, toast, keepAwake, show, kg, mmss, int, uid, esc, DEFAULT_REST, demo = false } = api;
  const smoother = new FeatureSmoother();
  const pc = new PoseRepCounter();
  let camera = null;
  let camModule = null;
  let demoTimer = null;
  let open = false;
  let session = null; // { entries, restWallStart, restTarget, restAlerted }
  let last = null; // último quadro: { f, image }
  let shownReps = 0;
  let camError = '';

  /** Registro do exercício no armazenamento (criado na primeira vez). */
  function record(poseId) {
    let x = store.exercises.find((e) => e.pose === poseId);
    if (!x) {
      const def = POSE_EXERCISE[poseId];
      x = { id: uid(), name: def.name, muscle: def.muscle, pose: poseId, rest: DEFAULT_REST, sets: 3, reps: 12, load: null, step: 2, suggested: false };
      store.exercises.push(x);
      save();
    }
    return x;
  }

  function speak(text) {
    if (!store.settings.sound || !window.speechSynthesis) return;
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'pt-BR';
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    } catch {
      /* sem voz disponível */
    }
  }

  // ---------- quadros e eventos ----------
  function handleFrame({ world, image, poses = world ? 1 : 0, dark = false, up, dt }) {
    if (!open) return;
    const f = smoother.update(extractFeatures(world, image, { poses, dark, up }), dt);
    last = { f, image };
    for (const e of pc.update(f, dt)) onEvent(e);
  }

  function onEvent(e) {
    if (e.type === 'exercise') {
      const x = record(e.id);
      $('fLoad').value = x.load ?? '';
      speak(x.name);
    } else if (e.type === 'rep') {
      beep(880, 70);
      vibrate(40);
    } else if (e.type === 'setStart') {
      session.restWallStart = null;
    } else if (e.type === 'setEnd') {
      closeSet(e.set, (pc.t - pc.restStartT) * 1000);
    }
  }

  /** Série fechada: guarda a carga, confere recorde, grava e começa o descanso. */
  function closeSet(set, alreadyElapsedMs) {
    const x = record(set.exercise);
    if (set.load === undefined) set.load = x.load;
    persist();
    checkRecord(set, x);
    session.restWallStart = Date.now() - alreadyElapsedMs;
    session.restTarget = x.rest;
    session.restAlerted = false;
    $('fLoad').value = x.load ?? '';
  }

  /**
   * Copia as séries para o histórico: séries seguidas do mesmo exercício viram
   * uma entrada, no mesmo formato do modo com sensor.
   */
  function persist() {
    const groups = [];
    for (const s of pc.sets) {
      const g = groups[groups.length - 1];
      if (g && g.exercise === s.exercise) g.sets.push(s);
      else groups.push({ exercise: s.exercise, sets: [s] });
    }
    groups.forEach((g, i) => {
      const x = record(g.exercise);
      let entry = session.entries[i];
      if (!entry) {
        entry = { id: uid(), date: new Date().toISOString(), source: 'livre' };
        session.entries[i] = entry;
        store.history.push(entry);
      }
      Object.assign(entry, {
        name: x.name,
        exId: x.id,
        muscle: x.muscle,
        load: g.sets[g.sets.length - 1].load ?? null,
        sets: g.sets.map((s) => ({
          reps: s.reps,
          load: s.load ?? null,
          duration: Math.round(s.duration),
          rest: s.restActual === null ? null : Math.round(s.restActual),
          pr: s.pr || null,
        })),
      });
    });
    // uma correção de exercício pode juntar entradas: remove as que sobraram
    for (const extra of session.entries.splice(groups.length)) {
      const at = store.history.indexOf(extra);
      if (at >= 0) store.history.splice(at, 1);
    }
    save();
  }

  function checkRecord(set, x) {
    if (set.pr !== undefined) return;
    set.pr = null;
    if (!set.load || !set.reps) return;
    const mine = new Set(session.entries);
    const previous = exerciseEntries(store.history, x).filter((e) => !mine.has(e));
    if (!previous.length) return; // primeira vez: é a referência
    const earlier = pc.sets.filter((s) => s !== set && s.exercise === set.exercise).map((s) => ({ reps: s.reps, load: s.load ?? null }));
    const best = records([...previous, { load: null, sets: earlier }]);
    const kinds = [];
    if (set.load > best.maxLoad) kinds.push('carga');
    if (e1rm(set.load, set.reps) > best.bestE1rm + 0.01) kinds.push('1RM estimado');
    if (!kinds.length) return;
    set.pr = kinds;
    persist();
    toast(`Recorde de ${kinds.join(' e ')}!`);
    beep(1320, 120, 2);
  }

  // ---------- câmera e demonstração ----------
  async function startCamera() {
    camError = '';
    try {
      camModule ??= await import('./src/posecam.js');
      const cam = new camModule.PoseCamera($('fVideo'), handleFrame);
      await cam.start();
      if (!open) {
        cam.stop();
        return;
      }
      camera = cam;
      $('fCanvas').width = $('fVideo').videoWidth || 640;
      $('fCanvas').height = $('fVideo').videoHeight || 480;
    } catch (err) {
      camError = err?.name === 'NotAllowedError'
        ? 'Sem permissão para usar a câmera. Libere o acesso nas configurações do site.'
        : `Não consegui ligar a câmera (${err?.message || 'erro desconhecido'}).`;
    }
  }

  function stopSources() {
    camera?.stop();
    camera = null;
    if (demoTimer) clearInterval(demoTimer);
    demoTimer = null;
  }

  function startDemo() {
    stopSources();
    camError = '';
    const frames = [...new Script().hold(2).set('rosca', 8).hold(14).set('agachamento', 6).hold(14).set('desenvolvimento', 6).hold(12).frames({ seed: Date.now() % 997 })];
    let i = 0;
    let due = performance.now();
    demoTimer = setInterval(() => {
      const now = performance.now();
      let n = 0;
      while (due <= now && n++ < 30) {
        handleFrame(frames[i]);
        due += frames[i].dt * 1000;
        i = (i + 1) % frames.length;
      }
    }, 16);
  }

  // ---------- abrir e fechar ----------
  function start() {
    smoother.reset();
    pc.reset();
    session = { entries: [], restWallStart: null, restTarget: DEFAULT_REST, restAlerted: false };
    last = null;
    shownReps = 0;
    open = true;
    $('fLoad').value = '';
    beep(1, 1); // destrava o áudio com o toque do usuário
    keepAwake(true);
    show('free');
    if (demo) {
      // página de demonstração: boneco sintético no lugar da câmera
      import('./src/posecam.js').then((m) => (camModule = m)).catch(() => {});
      startDemo();
    } else {
      startCamera();
    }
    requestAnimationFrame(render);
  }

  function finish() {
    if (!open) return;
    const closed = pc.finishSet();
    if (closed) {
      const x = record(closed.exercise);
      closed.load = x.load;
      persist();
      checkRecord(closed, x);
    } else if (pc.sets.length) {
      persist();
    }
    open = false;
    stopSources();
    window.speechSynthesis?.cancel();
    keepAwake(false);
    show(pc.sets.length ? 'history' : 'home');
  }

  // ---------- controles ----------
  function currentRecord() {
    return pc.exercise ? record(pc.exercise) : null;
  }
  function setLoad(value) {
    const x = currentRecord();
    if (!x) return;
    x.load = value > 0 ? Math.round(value * 2) / 2 : null;
    // No descanso, a carga digitada vale para a série que acabou de fechar.
    if (pc.state === 'rest' && pc.sets.length) {
      pc.sets[pc.sets.length - 1].load = x.load;
      persist();
    } else {
      save();
    }
    $('fLoad').value = x.load ?? '';
  }
  $('fLoadPlus').onclick = () => setLoad((currentRecord()?.load || 0) + 2);
  $('fLoadMinus').onclick = () => setLoad((currentRecord()?.load || 0) - 2);
  $('fLoad').onchange = (e) => setLoad(Number(e.target.value));
  const adjust = (d) => {
    pc.adjust(d);
    if (pc.state === 'rest') persist();
  };
  $('fPlus').onclick = () => adjust(1);
  $('fMinus').onclick = () => adjust(-1);
  $('fRestPlus').onclick = () => {
    session.restTarget += 15;
    session.restAlerted = false;
  };
  $('fRestMinus').onclick = () => (session.restTarget = Math.max(5, session.restTarget - 15));
  $('fEndSet').onclick = () => {
    const set = pc.finishSet();
    if (set) closeSet(set, 0);
  };
  $('fFinish').onclick = finish;
  $('fDemo').onclick = startDemo;
  $('fRetry').onclick = () => {
    stopSources();
    startCamera();
  };

  // toque no nome: corrigir o exercício, mantendo a contagem
  $('fExercise').onclick = () => {
    const current = pc.exercise;
    $('fPickList').innerHTML = `<button data-pose="" class="${pc.locked ? '' : 'on'}">Identificar sozinho</button>${POSE_EXERCISES.map(
      (x) => `<button data-pose="${x.id}" class="${x.id === current && (pc.locked || pc.state !== 'waiting') ? 'on' : ''}"><b>${esc(x.name)}</b><small>${esc(x.muscle)}</small></button>`,
    ).join('')}`;
    $('fPick').showModal();
  };
  $('fPickClose').onclick = () => $('fPick').close();
  $('fPickList').onclick = (e) => {
    const b = e.target.closest('[data-pose]');
    if (!b) return;
    const id = b.dataset.pose;
    if (!id) {
      pc.unlock();
    } else {
      // Antes de começar, a escolha fixa o exercício; depois, corrige o que foi detectado.
      pc.setExercise(id, { lock: pc.state === 'waiting' });
      const x = record(id);
      $('fLoad').value = x.load ?? '';
      if (pc.state === 'rest' && pc.sets.length) {
        const lastSet = pc.sets[pc.sets.length - 1];
        lastSet.load = x.load;
        lastSet.pr = undefined;
        persist();
        session.restTarget = x.rest;
      }
    }
    $('fPick').close();
  };

  // ---------- tela ----------
  function render() {
    if (!open) return;
    requestAnimationFrame(render);
    const resting = pc.state === 'rest' && session.restWallStart !== null;
    const done = pc.sets.length;
    const x = currentRecord();

    // avisos: câmera, enquadramento, luz, mais de uma pessoa
    const q = last ? last.f.quality : 'ok';
    const warn = camError || (last ? qualityText(q) : demoTimer || camera ? '' : 'Ligando a câmera…');
    $('fWarn').hidden = !warn;
    $('fWarnText').textContent = warn;
    $('fRetry').hidden = !camError;
    $('fDemo').hidden = Boolean(camera || demoTimer) && !camError;
    if (camModule && last) camModule.drawSkeleton($('fCanvas'), q === 'sem_corpo' ? null : last.image);
    $('fCam').classList.toggle('bad', q !== 'ok');
    $('fCam').classList.toggle('demo', Boolean(demoTimer));

    $('fExName').textContent = x ? x.name : 'Aguardando movimento';
    $('fExHint').textContent = x ? (pc.locked ? 'escolhido à mão · toque para trocar' : 'toque para corrigir') : 'faça 2 repetições, ou toque para escolher';

    const hero = $('fHero');
    let fraction = 0;
    let over = false;
    if (resting) {
      const elapsed = (Date.now() - session.restWallStart) / 1000;
      const rem = session.restTarget - elapsed;
      over = rem <= 0;
      fraction = over ? 1 : rem / session.restTarget;
      $('fBig').textContent = over ? `+${mmss(-rem)}` : mmss(Math.ceil(rem));
      $('fStatus').textContent = over ? 'Próxima série' : 'Descanso';
      $('fSub').textContent = `última: ${pc.sets[done - 1].reps} reps`;
      $('fRestTarget').textContent = `de ${mmss(session.restTarget)}`;
      if (over && !session.restAlerted) {
        session.restAlerted = true;
        beep(660, 250, 3);
        vibrate([300, 150, 300, 150, 300]);
      }
      shownReps = 0;
    } else {
      const target = x ? x.reps : 12;
      fraction = Math.min(1, pc.reps / target);
      $('fBig').textContent = pc.reps;
      $('fStatus').textContent = pc.state === 'set' ? `Série ${pc.setIndex}` : 'Pronto';
      $('fSub').textContent = pc.state === 'set' ? 'repetições' : 'pode começar';
      if (pc.reps > shownReps) {
        const big = $('fBig');
        big.classList.remove('pulse');
        void big.offsetWidth; // reinicia a animação
        big.classList.add('pulse');
      }
      shownReps = pc.reps;
    }
    hero.classList.toggle('rest', resting);
    hero.classList.toggle('over', over);
    $('fRingArc').style.strokeDashoffset = RING * (1 - fraction);
    $('fRepCtl').hidden = resting;
    $('fRestCtl').hidden = !resting;
    $('fEndSet').disabled = pc.state !== 'set';
    $('fLoad').disabled = !x;
    $('fLoadPlus').disabled = !x;
    $('fLoadMinus').disabled = !x;

    $('fSets').innerHTML = pc.sets
      .map((s, i) => `<li><span>${i + 1}ª série</span><b>${esc(POSE_EXERCISE[s.exercise].name)} · ${s.reps} reps${s.load ? ` × ${kg(s.load)}` : ''}</b>${s.pr ? '<em>★ recorde</em>' : ''}${s.restActual === null ? '' : `<small>descanso ${mmss(s.restActual)}</small>`}</li>`)
      .join('');
    const volume = pc.sets.reduce((sum, s) => sum + s.reps * (s.load || 0), 0);
    $('fTotals').textContent = done ? `${done} ${done === 1 ? 'série' : 'séries'} · ${int(volume)} kg` : '';
  }

  return { start, finish, get open() { return open; } };
}
