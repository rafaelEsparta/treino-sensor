import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_EXERCISES, newDefault } from '../src/defaults.js';
import { buildDemoStore } from '../src/demodata.js';
import { dayKey, validateImport } from '../src/stats.js';
import {
  applyWorkoutImport, compareWithPrevious, daySummary, decodeShare, defaultWorkouts, encodeShare, nextWorkout, normName, parseWorkouts, summaryText, workoutsToText,
} from '../src/workouts.js';

let n = 0;
const uid = () => `id${++n}`;
const freshStore = () => {
  const exercises = DEFAULT_EXERCISES.map((d) => newDefault(d, uid()));
  return { exercises, history: [], workouts: defaultWorkouts(exercises, uid) };
};

test('treinos padrão: A, B e C com exercícios que existem', () => {
  const s = freshStore();
  assert.deepEqual(s.workouts.map((w) => w.name[0]), ['A', 'B', 'C']);
  for (const w of s.workouts) {
    assert.equal(w.items.length, 5);
    assert.ok(w.items.every((id) => s.exercises.some((x) => x.id === id)));
  }
  // sem os exercícios, não inventa treino vazio
  assert.deepEqual(defaultWorkouts([], uid), []);
});

test('próximo treino: segue a roda a partir do último feito', () => {
  const { workouts } = freshStore();
  const [a, b, c] = workouts;
  assert.equal(nextWorkout(workouts, []), a);
  assert.equal(nextWorkout(workouts, [{ date: '2026-11-10T10:00:00', workoutId: a.id }]), b);
  assert.equal(nextWorkout(workouts, [{ date: '2026-11-12T10:00:00', workoutId: c.id }, { date: '2026-11-10T10:00:00', workoutId: a.id }]), a);
  // registro de treino apagado ou avulso não conta
  assert.equal(nextWorkout(workouts, [{ date: '2026-11-12T10:00:00', workoutId: 'sumiu' }, { date: '2026-11-13T10:00:00' }]), a);
  assert.equal(nextWorkout([], []), null);
});

test('importação: lê ficha escrita como mensagem', () => {
  const parsed = parseWorkouts(`
    Treino A - Pernas
    1. Agachamento livre 3x12 50 kg
    - Leg press 45 - 4 x 10, 92,5kg, descanso 60s
    * Cadeira extensora: 3×8-12 (intervalo 1,5 min)
    Mesa flexora

    **Treino B:**
    Supino máquina 3 séries? não, 4x8 20kg 45 s
  `);
  assert.deepEqual(parsed.map((w) => w.name), ['Treino A - Pernas', 'Treino B']);
  assert.deepEqual(parsed[0].items, [
    { name: 'Agachamento livre', sets: 3, reps: 12, load: 50, rest: null },
    { name: 'Leg press 45', sets: 4, reps: 10, load: 92.5, rest: 60 },
    { name: 'Cadeira extensora', sets: 3, reps: 12, load: null, rest: 90 },
    { name: 'Mesa flexora', sets: 3, reps: 12, load: null, rest: null },
  ]);
  assert.deepEqual(parsed[1].items[0], { name: 'Supino máquina 3 séries? não', sets: 4, reps: 8, load: 20, rest: 45 });
});

test('importação: sem título vira "Treino importado"; texto sem exercício não vira nada', () => {
  const parsed = parseWorkouts('Puxada alta 3x10\nRemada baixa 3x10');
  assert.deepEqual(parsed.map((w) => [w.name, w.items.length]), [['Treino importado', 2]]);
  assert.deepEqual(parseWorkouts('só um título'), []);
  assert.deepEqual(parseWorkouts(''), []);
});

test('importação: reaproveita exercício pelo nome, cria o que falta e substitui treino de mesmo nome', () => {
  const s = freshStore();
  const before = s.exercises.length;
  const leg = s.exercises.find((x) => x.name === 'Leg press 45');
  leg.load = 120;
  leg.suggested = false; // carga já ajustada pelo usuário
  const r = applyWorkoutImport(s, parseWorkouts('Treino A - Pernas\nLEG PRESS 45 4x10 90 kg descanso 60 s\nagachamento búlgaro 3x10\nCadeira extensora 3x15 35 kg'), uid);
  assert.deepEqual(r, { workouts: 1, created: 1, updated: 2 });
  assert.equal(s.exercises.length, before + 1);
  assert.equal(s.workouts.length, 3); // "A · Pernas" foi substituído, não duplicado
  assert.deepEqual([leg.sets, leg.reps, leg.rest, leg.load], [4, 10, 60, 120]); // a carga do usuário fica
  const ext = s.exercises.find((x) => x.name === 'Cadeira extensora');
  assert.deepEqual([ext.reps, ext.load, ext.suggested], [15, 35, false]); // carga só sugerida é trocada
  const novo = s.exercises.find((x) => normName(x.name) === 'agachamento bulgaro');
  assert.deepEqual([novo.muscle, novo.downFirst, novo.load], ['Outro', true, null]);
  assert.deepEqual(s.workouts[0].items, [leg.id, novo.id, ext.id]);
});

test('ficha em texto vai e volta, inclusive pelo link', () => {
  const s = freshStore();
  const text = workoutsToText(s.workouts, s.exercises);
  assert.ok(text.startsWith('A · Pernas\nAgachamento livre 3x12 40 kg descanso 90 s'));
  const back = parseWorkouts(decodeShare(encodeShare(text)));
  assert.deepEqual(back.map((w) => [w.name, w.items.map((i) => i.name)]), s.workouts.map((w) => [w.name, w.items.map((id) => s.exercises.find((x) => x.id === id).name)]));
  assert.deepEqual(back[0].items[0], { name: 'Agachamento livre', sets: 3, reps: 12, load: 40, rest: 90 });
  assert.ok(/^[\w-]+$/.test(encodeShare(text)));
  assert.equal(decodeShare('%%%'), null);
});

test('resumo do dia: exercícios, totais, tempo e recordes', () => {
  const wk = [{ id: 'w1', name: 'A · Pernas', items: [] }];
  const history = [
    { date: '2026-11-17T18:00:00', name: 'Leg press 45', exId: 'a', workoutId: 'w1', load: 90, sets: [{ reps: 12, load: 90, duration: 30, rest: 90 }, { reps: 12, load: 95, duration: 30, rest: null, pr: ['carga'] }] },
    { date: '2026-11-17T18:10:00', name: 'Stiff', exId: 'b', workoutId: 'w1', load: 30, sets: [{ reps: 10, load: null, duration: 40, rest: null }] },
    { date: '2026-11-16T18:00:00', name: 'Stiff', exId: 'b', load: 30, sets: [{ reps: 10, load: 30 }] },
  ];
  const sum = daySummary(history, dayKey('2026-11-17T18:00:00'), wk);
  assert.equal(sum.workout, 'A · Pernas');
  assert.deepEqual(sum.exercises.map((x) => [x.name, x.sets, x.topLoad, x.pr]), [['Leg press 45', [12, 12], 95, true], ['Stiff', [10], 30, false]]);
  assert.deepEqual([sum.sets, sum.reps, sum.volume, sum.prs], [3, 34, 12 * 90 + 12 * 95 + 300, 1]);
  assert.equal(sum.minutes, 11); // das 17:59:30 (início da 1ª série) às 18:10:00
  const text = summaryText(sum, '17 de novembro');
  assert.ok(text.includes('A · Pernas · 17 de novembro'));
  assert.ok(text.includes('• Leg press 45: 2×12 · 95 kg ⭐'));
  assert.ok(text.includes('3 séries · 34 repetições'));
  assert.equal(daySummary(history, '2026-01-01').sets, 0);
});

test('comparação com a vez anterior do mesmo treino', () => {
  const e = (date, load) => ({ date, name: 'X', exId: 'a', workoutId: 'w1', load, sets: [{ reps: 10, load }] });
  const history = [e('2026-11-10T18:00:00', 100), e('2026-11-17T18:00:00', 110), { ...e('2026-11-14T18:00:00', 500), workoutId: 'w2' }];
  const c = compareWithPrevious(history, '2026-11-17', 'w1');
  assert.equal(c.previousKey, '2026-11-10');
  assert.ok(Math.abs(c.delta - 0.1) < 1e-9);
  assert.equal(compareWithPrevious(history, '2026-11-10', 'w1'), null);
  assert.equal(compareWithPrevious(history, '2026-11-17', null), null);
});

test('demo e backup: treinos montados sobrevivem à validação', () => {
  const demo = buildDemoStore(new Date('2026-11-16T15:00:00').getTime());
  assert.deepEqual(demo.workouts.map((w) => w.items.length), [4, 4, 4]);
  assert.ok(demo.history.some((e) => e.workoutId === demo.workouts[0].id));
  const clean = validateImport(JSON.parse(JSON.stringify({ ...demo, workouts: [...demo.workouts, { name: 'Quebrado', items: ['nao-existe'] }, { items: [] }] })));
  assert.deepEqual(clean.workouts.map((w) => w.items.length), [4, 4, 4, 0]);
  assert.equal(clean.history.filter((e) => e.workoutId).length, demo.history.filter((e) => e.workoutId).length);
  assert.ok(clean.history.some((e) => e.source === 'livre'));
  assert.deepEqual(validateImport({ exercises: [], history: [] }).workouts, []); // backup antigo
});
