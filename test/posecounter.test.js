import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FeatureSmoother, extractFeatures, jointAngle, packFrame, postureOf, unpackFrame, upFromGravity } from '../src/pose.js';
import { CycleDetector, POSE_EXERCISES, PoseRepCounter } from '../src/posecounter.js';
import { NEUTRAL, SIM_EXERCISES, Script, poseToFrame } from '../src/posesim.js';

/** Passa um roteiro pelo mesmo caminho do app: sinais -> suavização -> contador. */
function run(script, { options = {}, sim = {}, ctx = {}, prepare } = {}) {
  const smoother = new FeatureSmoother();
  const pc = new PoseRepCounter(options);
  if (prepare) prepare(pc);
  const events = [];
  for (const fr of script.frames(sim)) {
    const f = smoother.update(extractFeatures(fr.world, fr.image, ctx), fr.dt);
    for (const e of pc.update(f, fr.dt)) events.push({ ...e, t: pc.t });
  }
  return { pc, events };
}
const summary = (pc) => pc.sets.map((s) => `${s.exercise}:${s.reps}`);

test('ângulos e postura do boneco em pé', () => {
  const { world, image } = poseToFrame(NEUTRAL);
  const f = extractFeatures(world, image);
  assert.equal(f.quality, 'ok');
  assert.ok(Math.abs(f.elbowL - 170) < 1, `cotovelo ${f.elbowL}`);
  assert.ok(Math.abs(f.kneeR - 177) < 1, `joelho ${f.kneeR}`);
  assert.ok(f.trunk < 6 && f.legs < 6);
  assert.equal(postureOf(f.trunk, f.legs), 'em_pe');
  assert.equal(jointAngle({ x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }), 90);
});

test('postura: remada é inclinado, flexão é deitado', () => {
  for (const [id, expected] of [['remada', 'inclinado'], ['flexao', 'deitado'], ['agachamento', 'em_pe']]) {
    const { world, image } = poseToFrame(SIM_EXERCISES[id].a);
    const f = extractFeatures(world, image);
    assert.equal(postureOf(f.trunk, f.legs), expected, id);
  }
});

test('gravidade do aparelho corrige a inclinação do celular', () => {
  assert.deepEqual(upFromGravity(null), [0, -1, 0]);
  assert.deepEqual(upFromGravity({ x: 0, y: 0.5, z: 9.8 }), [0, -1, 0]); // deitado na mesa: ignora
  const up = upFromGravity({ x: 0, y: 9.8 * Math.cos(0.35), z: 9.8 * Math.sin(0.35) }); // 20° para trás
  assert.ok(Math.abs(up[1] + Math.cos(0.35)) < 1e-9 && Math.abs(up[2] - Math.sin(0.35)) < 1e-9);
});

test('qualidade: sem corpo, fora do quadro, várias pessoas, pouca luz', () => {
  assert.equal(extractFeatures(null, null).quality, 'sem_corpo');
  const { world, image } = poseToFrame(NEUTRAL);
  assert.equal(extractFeatures(world, image, { poses: 2 }).quality, 'varias_pessoas');
  assert.equal(extractFeatures(world, image, { dark: true }).quality, 'pouca_luz');
  const off = poseToFrame(NEUTRAL, { shiftX: 0.5 });
  assert.equal(extractFeatures(off.world, off.image).quality, 'fora_do_quadro');
  const hidden = poseToFrame(NEUTRAL, { visibility: (name) => (name.startsWith('wrist') ? 0.1 : 1) });
  const f = extractFeatures(hidden.world, hidden.image);
  assert.equal(f.quality, 'ok');
  assert.equal(f.elbowL, null); // ponto invisível é ignorado, não inventado
  assert.ok(f.kneeL > 170);
});

test('detector de ciclo: ida e volta nos dois sentidos, sem contar oscilação pequena', () => {
  const d = new CycleDetector({ minAmp: 40 });
  const cycles = [];
  let t = 0;
  const feed = (fn, dur) => {
    for (let i = 0; i < dur * 30; i++) {
      t += 1 / 30;
      const c = d.update(fn(i / 30), t, 1 / 30);
      if (c) cycles.push(c);
    }
  };
  feed(() => 170, 1);
  feed((x) => 170 - 60 * (1 - Math.cos(Math.PI * x)), 2); // 170 -> 50 -> 170
  feed(() => 170, 1);
  feed((x) => 170 - 5 * Math.sin(8 * x), 2); // tremor de 5 graus
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0].dir, -1);
  assert.ok(Math.abs(cycles[0].amp - 120) < 5);
});

for (const ex of POSE_EXERCISES) {
  test(`identifica e conta: ${ex.name}`, () => {
    const { pc, events } = run(new Script().hold(1.5).set(ex.id, 8).hold(6));
    assert.deepEqual(summary(pc), [`${ex.id}:8`]);
    // identificou com 2 repetições, e elas entraram na contagem
    const first = events.find((e) => e.type === 'setStart');
    const repsAtStart = events.filter((e) => e.type === 'rep' && e.t === first.t).length;
    assert.equal(repsAtStart, 2);
    assert.equal(events.filter((e) => e.type === 'exercise')[0].id, ex.id);
  });
}

test('três séries de exercícios diferentes, com descanso entre elas', () => {
  const script = new Script().hold(1.5).set('rosca', 10).hold(20).set('agachamento', 8).hold(20).set('desenvolvimento', 6).hold(8);
  const { pc, events } = run(script, { options: { restTarget: 15 } });
  assert.deepEqual(summary(pc), ['rosca:10', 'agachamento:8', 'desenvolvimento:6']);
  // descanso real ~ pausa de 20 s mais as transições (medido da última à primeira repetição)
  for (const s of pc.sets.slice(0, 2)) assert.ok(s.restActual > 19 && s.restActual < 27, `descanso ${s.restActual}`);
  assert.equal(events.filter((e) => e.type === 'restDone').length, 2); // o último descanso (8 s) não chega aos 15
  assert.equal(events.filter((e) => e.type === 'setEnd').length, 3);
});

test('mesmo exercício na série seguinte: a primeira repetição já abre a série', () => {
  const { pc, events } = run(new Script().hold(1).set('rosca', 5).hold(10).set('rosca', 5).hold(6));
  assert.deepEqual(summary(pc), ['rosca:5', 'rosca:5']);
  const starts = events.filter((e) => e.type === 'setStart');
  assert.equal(events.filter((e) => e.type === 'rep' && e.t === starts[1].t).length, 1);
});

test('fim de série: descanso conta a partir da última repetição', () => {
  const { events } = run(new Script().hold(1).set('lateral', 5).hold(40), { options: { restTarget: 20, restDetect: 4 } });
  const lastRep = events.filter((e) => e.type === 'rep').at(-1);
  const end = events.find((e) => e.type === 'setEnd');
  const done = events.find((e) => e.type === 'restDone');
  assert.ok(end.t - lastRep.t > 3.5 && end.t - lastRep.t < 6, `fim ${end.t - lastRep.t}`);
  assert.ok(Math.abs(done.t - lastRep.t - 20) < 0.5, `aviso ${done.t - lastRep.t}`);
});

test('negativo: andar não conta repetição', () => {
  const { pc, events } = run(new Script().hold(1).walk(15).hold(6));
  assert.equal(pc.sets.length, 0);
  assert.equal(events.length, 0);
});

test('negativo: pegar os halteres do chão não conta, e a rosca depois conta certo', () => {
  const { pc } = run(new Script().hold(1).pickUp().hold(1).set('rosca', 8).hold(1).pickUp().hold(6));
  assert.deepEqual(summary(pc), ['rosca:8']);
});

test('negativo: ajeitar o celular (um braço se move, corpo sai do quadro) não conta', () => {
  const reach = { ...NEUTRAL, armR: { elev: 80, plane: 'sag', ef: 90, toward: 'forward' } };
  const script = new Script().hold(1).move(reach, 0.8).hold(0.5).move(NEUTRAL, 0.8).hold(6);
  const { pc, events } = run(script);
  assert.equal(pc.sets.length, 0);
  assert.equal(events.length, 0);
  // com o corpo fora do quadro nada é contado, mesmo com movimento de exercício
  const out = run(new Script().hold(1).set('rosca', 6).hold(6), { sim: { shiftX: 0.6 } });
  assert.equal(out.pc.sets.length, 0);
});

test('mais de uma pessoa no quadro: não conta', () => {
  const { pc } = run(new Script().hold(1).set('agachamento', 6).hold(6), { ctx: { poses: 2 } });
  assert.equal(pc.sets.length, 0);
});

test('não troca de exercício por um quadro ruim no meio da série', () => {
  // esconde os pulsos por alguns quadros no meio de uma série de rosca
  let n = 0;
  const visibility = (name) => {
    if (name === 'nose') n++;
    return name.startsWith('wrist') && n > 200 && n < 206 ? 0.1 : 1;
  };
  const { pc } = run(new Script().hold(1).set('rosca', 8).hold(6), { sim: { visibility } });
  assert.deepEqual(summary(pc), ['rosca:8']);
});

test('troca no meio da série só com evidência sustentada (3 repetições)', () => {
  // rosca emendada com agachamento, sem pausa entre os dois
  const script = new Script().hold(1).set('rosca', 6, { setup: 0.6 }).set('agachamento', 5, { setup: 0.6 }).hold(14);
  const { pc } = run(script, { options: { restDetect: 12 } });
  assert.deepEqual(summary(pc), ['rosca:6', 'agachamento:5']);
});

test('modo manual: exercício escolhido à mão conta desde a primeira repetição', () => {
  const { pc, events } = run(new Script().hold(1).set('triceps', 6).hold(6), {
    prepare: (c) => c.setExercise('triceps', { lock: true }),
  });
  assert.deepEqual(summary(pc), ['triceps:6']);
  assert.equal(events.filter((e) => e.type === 'rep')[0].rep.n, 1);
  // travado em rosca, um agachamento não vira repetição
  const other = run(new Script().hold(1).set('agachamento', 5).hold(6), { prepare: (c) => c.setExercise('rosca', { lock: true }) });
  assert.equal(other.pc.sets.length, 0);
});

test('corrigir o exercício mantém a contagem; no descanso renomeia a série', () => {
  const smoother = new FeatureSmoother();
  const pc = new PoseRepCounter();
  const script = new Script().hold(1).set('rosca', 6).hold(6);
  let fixed = false;
  for (const fr of script.frames()) {
    pc.update(smoother.update(extractFeatures(fr.world, fr.image), fr.dt), fr.dt);
    if (!fixed && pc.state === 'set' && pc.reps === 3) {
      pc.setExercise('triceps');
      fixed = true;
    }
  }
  assert.deepEqual(summary(pc), ['triceps:6']);
  pc.setExercise('rosca');
  assert.deepEqual(summary(pc), ['rosca:6']);
});

test('finishSet e funcionamento a 15 quadros por segundo', () => {
  const { pc } = run(new Script().hold(1).set('agachamento', 7).hold(6), { sim: { fps: 15 } });
  assert.deepEqual(summary(pc), ['agachamento:7']);
  const smoother = new FeatureSmoother();
  const c = new PoseRepCounter();
  for (const fr of new Script().hold(1).set('rosca', 4, { setup: 0.5 }).frames()) {
    c.update(smoother.update(extractFeatures(fr.world, fr.image), fr.dt), fr.dt);
    if (c.reps === 4) break;
  }
  assert.equal(c.finishSet().reps, 4);
  assert.equal(c.state, 'rest');
});

test('gravação: um quadro compactado e reaberto dá os mesmos ângulos', () => {
  const { world, image } = poseToFrame(SIM_EXERCISES.rosca.b);
  const back = unpackFrame(JSON.parse(JSON.stringify(packFrame(world, image, 1 / 30))));
  const a = extractFeatures(world, image);
  const b = extractFeatures(back.world, back.image);
  for (const k of ['elbowL', 'shoulderR', 'kneeL', 'trunk']) assert.ok(Math.abs(a[k] - b[k]) < 0.1, k);
  assert.deepEqual(unpackFrame(packFrame(null, null, 0.033)), { dt: 0.033, world: null, image: null });
});

test('ajuste manual de repetições', () => {
  const { pc } = run(new Script().hold(1).set('rosca', 5).hold(6));
  pc.adjust(1);
  assert.deepEqual(summary(pc), ['rosca:6']);
  pc.adjust(-2);
  assert.deepEqual(summary(pc), ['rosca:4']);
});
