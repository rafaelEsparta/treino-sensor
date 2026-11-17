import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RepCounter } from '../src/repcounter.js';
import { simulate, workoutScript } from '../src/simulator.js';

function run(sets, { rate = 50, options = {}, sim = {} } = {}) {
  const rc = new RepCounter(options);
  const events = [];
  for (const s of simulate(workoutScript(sets), { rate, ...sim })) {
    for (const e of rc.update(s, 1 / rate)) events.push({ ...e, t: rc.t });
  }
  return { rc, events };
}

test('duas séries com pausa no topo e descanso entre elas', () => {
  const { rc, events } = run([
    { reps: 10, up: 1, down: 1.5, pauseTop: 0.3, pauseBottom: 0.2, rest: 20 },
    { reps: 8, up: 1, down: 1.5, pauseTop: 0.3, pauseBottom: 0.2, rest: 8 },
  ]);
  assert.deepEqual(rc.sets.map((s) => s.reps), [10, 8]);
  // descanso real ~ 20 s (do fim da 1ª série ao início da 2ª)
  assert.ok(Math.abs(rc.sets[0].restActual - 20) < 1.5, `restActual=${rc.sets[0].restActual}`);
  // amplitude estimada próxima dos 30 cm simulados
  for (const rep of rc.sets[0].repDetails) {
    assert.ok(rep.range > 0.2 && rep.range < 0.4, `range=${rep.range}`);
  }
  assert.equal(events.filter((e) => e.type === 'setStart').length, 2);
});

test('repetições contínuas, sem pausa nenhuma', () => {
  const { rc } = run([{ reps: 12, up: 1.2, down: 1.2, rest: 6 }]);
  assert.deepEqual(rc.sets.map((s) => s.reps), [12]);
});

test('repetições lentas (2 s para subir, 3 s para descer)', () => {
  const { rc } = run([{ reps: 6, up: 2, down: 3, pauseTop: 0.5, rest: 6 }]);
  assert.deepEqual(rc.sets.map((s) => s.reps), [6]);
});

test('repetições rápidas e curtas (15 cm)', () => {
  const { rc } = run([{ reps: 15, up: 0.5, down: 0.6, range: 0.15, rest: 6 }]);
  assert.deepEqual(rc.sets.map((s) => s.reps), [15]);
});

test('sensor parado só com ruído não conta nada', () => {
  const { rc, events } = run([{ reps: 0, up: 1, down: 1, rest: 60 }]);
  assert.equal(rc.sets.length, 0);
  assert.equal(events.length, 0);
});

test('tranco curto (2 cm) não conta repetição', () => {
  const { rc } = run([{ reps: 3, up: 0.2, down: 0.2, range: 0.02, pauseBottom: 2, rest: 5 }]);
  assert.equal(rc.sets.length, 0);
  assert.equal(rc.reps, 0);
});

test('descanso: alerta dispara quando o tempo predefinido acaba', () => {
  const { events } = run(
    [{ reps: 5, up: 1, down: 1, rest: 40 }],
    { options: { restTarget: 30 } },
  );
  const end = events.find((e) => e.type === 'setEnd');
  const done = events.find((e) => e.type === 'restDone');
  assert.ok(end && done);
  // série termina em ~2 + 5*2 = 12 s; alerta ~30 s depois
  assert.ok(Math.abs(done.t - 42) < 1.5, `restDone em t=${done.t}`);
});

test('funciona também a 20 Hz', () => {
  const { rc } = run([{ reps: 10, up: 1, down: 1.5, pauseTop: 0.3, rest: 6 }], { rate: 20 });
  assert.deepEqual(rc.sets.map((s) => s.reps), [10]);
});

test('sensor montado em outra orientação', () => {
  const { rc } = run([{ reps: 7, up: 1, down: 1, rest: 6 }], { sim: { up: [-0.9, 0.3, 0.1], seed: 7 } });
  assert.deepEqual(rc.sets.map((s) => s.reps), [7]);
});

test('sensor trocado de máquina (nova orientação) volta a contar', () => {
  const rc = new RepCounter();
  const feed = (gen) => {
    for (const s of gen) rc.update(s, 0.02);
  };
  feed(simulate(workoutScript([{ reps: 5, up: 1, down: 1, rest: 5 }])));
  // manuseio: 2 s girando a 150 °/s com aceleração bagunçada
  for (let i = 0; i < 100; i++) {
    rc.update({ ax: Math.sin(i / 7), ay: Math.cos(i / 5), az: 0.3, wx: 150, wy: -80, wz: 40 }, 0.02);
  }
  feed(simulate(workoutScript([{ reps: 6, up: 1, down: 1, rest: 5 }]), { up: [0.95, 0.2, -0.1], seed: 3 }));
  assert.deepEqual(rc.sets.map((s) => s.reps), [5, 6]);
});

test('finishSet encerra a série na hora', () => {
  const rc = new RepCounter();
  let n = 0;
  for (const s of simulate(workoutScript([{ reps: 4, up: 1, down: 1, rest: 0.5 }]))) {
    rc.update(s, 0.02);
    n++;
  }
  assert.equal(rc.state, 'set');
  const set = rc.finishSet();
  assert.equal(set.reps, 4);
  assert.equal(rc.state, 'rest');
  assert.equal(rc.finishSet(), null);
});

test('desce e sobe (agachamento, leg press 45): conta com downFirst', () => {
  const sets = [{ reps: 10, up: 1.5, down: 1, pauseTop: 0.3, pauseBottom: 0.3, range: -0.3, rest: 8 }];
  const { rc } = run(sets, { options: { downFirst: true } });
  assert.deepEqual(rc.sets.map((s) => s.reps), [10]);
  for (const rep of rc.sets[0].repDetails) assert.ok(rep.range > 0.2 && rep.range < 0.4, `range=${rep.range}`);
});

test('desce e sobe: a repetição só conta na volta ao topo', () => {
  const sets = [{ reps: 3, up: 1.5, down: 1.5, pauseTop: 1, pauseBottom: 0.5, range: -0.3, rest: 6 }];
  const { events } = run(sets, { options: { downFirst: true } });
  const reps = events.filter((e) => e.type === 'rep');
  assert.equal(reps.length, 3);
  // roteiro: 2 s parado, 1,5 s descendo, 1 s no fundo, 1,5 s subindo -> a 1ª termina perto de 6 s
  assert.ok(reps[0].t > 5.3 && reps[0].t < 6.8, `1ª repetição em t=${reps[0].t}`);
});

test('pilha de pesos continua contando sobe e desce por padrão', () => {
  const { rc } = run([{ reps: 8, up: 1, down: 1.5, pauseTop: 0.3, rest: 6 }]);
  assert.equal(rc.cfg.downFirst, false);
  assert.deepEqual(rc.sets.map((s) => s.reps), [8]);
});
