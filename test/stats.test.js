import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  activityByDay, dayKey, e1rm, e1rmSeries, exerciseEntries, muscleVolume, recomputeRecords, records, suggestLoad, toCSV, totals, validateImport,
} from '../src/stats.js';

const ex = { id: 'a', name: 'Leg press 45', sets: 3, reps: 12, load: 80, step: 5, muscle: 'Quadríceps' };
const entry = (date, sets, extra = {}) => ({ id: date, date, name: ex.name, exId: 'a', load: null, sets, ...extra });
const s = (reps, load) => ({ reps, load, rest: 90, duration: 30 });

test('1RM estimado (Epley)', () => {
  assert.equal(e1rm(100, 30), 200);
  assert.equal(e1rm(0, 10), 0);
  assert.equal(Math.round(e1rm(80, 12)), 112);
});

test('entradas por id, e por nome nas antigas', () => {
  const history = [entry('2026-11-01T10:00:00', []), { name: 'Leg press 45', sets: [] }, { name: 'Stiff', sets: [] }, { exId: 'b', name: 'Leg press 45', sets: [] }];
  assert.equal(exerciseEntries(history, ex).length, 2);
});

test('recordes', () => {
  const r = records([entry('2026-11-01T10:00:00', [s(12, 80), s(8, 90)]), entry('2026-11-03T10:00:00', [s(15, 70)])]);
  assert.equal(r.maxLoad, 90);
  assert.equal(r.maxReps, 15);
  assert.equal(Math.round(r.bestE1rm), 114); // 90 × (1 + 8/30)
  assert.equal(r.maxVolume, 12 * 80 + 8 * 90);
});

test('dupla progressão: sobe a carga só se bateu todas as séries', () => {
  const hit = [entry('2026-11-01T10:00:00', [s(12, 80), s(12, 80), s(13, 80)])];
  assert.deepEqual(suggestLoad(ex, hit), { load: 85, from: 80, sets: 3, reps: 12 });
  assert.equal(suggestLoad(ex, [entry('d', [s(12, 80), s(12, 80), s(10, 80)])]), null); // faltou repetição
  assert.equal(suggestLoad(ex, [entry('d', [s(12, 80), s(12, 80)])]), null); // faltou série
  assert.equal(suggestLoad(ex, [entry('d', [s(12, 80), s(12, 85), s(12, 85)])]), null); // cargas diferentes
  assert.equal(suggestLoad({ ...ex, load: 90 }, hit), null); // já subiu
  assert.equal(suggestLoad(ex, []), null);
});

test('série de 1RM estimado: o melhor de cada sessão', () => {
  const series = e1rmSeries([entry('2026-11-01T10:00:00', [s(12, 80), s(6, 100)]), entry('2026-11-02T10:00:00', [s(10, null)])]);
  assert.equal(series.length, 1);
  assert.equal(series[0].load, 100);
});

test('atividade por dia, totais e grupos musculares', () => {
  const history = [
    entry('2026-11-01T10:00:00', [s(10, 50), s(10, 50)], { muscle: 'Quadríceps' }),
    entry('2026-11-01T11:00:00', [s(10, 20)], { name: 'Mesa flexora', exId: 'b' }),
    entry('2026-11-05T10:00:00', [s(10, 50)]),
  ];
  const act = activityByDay(history);
  assert.deepEqual(act.get(dayKey('2026-11-01T10:00:00')), { sets: 3, volume: 1200 });
  assert.deepEqual(totals(history), { days: 2, sets: 4, reps: 40, volume: 1700 });
  const mv = muscleVolume(history, new Date('2026-11-01T00:00:00').getTime(), [ex, { id: 'b', name: 'Mesa flexora', muscle: 'Posteriores' }]);
  assert.deepEqual(mv.map((m) => [m.muscle, m.sets]), [['Quadríceps', 3], ['Posteriores', 1]]);
});

test('CSV', () => {
  const csv = toCSV([entry('2026-11-01T10:05:00', [{ reps: 12, load: 82.5, rest: 90, duration: 31, pr: ['carga'] }], { muscle: 'Quadríceps', name: 'Leg; "press"' })]);
  const [head, row] = csv.split('\r\n');
  assert.ok(head.startsWith('data;hora;exercicio'));
  assert.equal(row, '2026-11-01;10:05;"Leg; ""press""";Quadríceps;1;12;82,5;90;31;carga');
});

test('importação valida e limpa', () => {
  assert.throws(() => validateImport({ foo: 1 }));
  assert.throws(() => validateImport(null));
  const out = validateImport({
    exercises: [{ name: ' Stiff ', rest: 'x', muscle: 'Inventado' }, { name: '' }, null],
    history: [{ name: 'Stiff', date: '2026-11-01T10:00:00Z', sets: [{ reps: 10, load: '30' }, { reps: 'abc' }] }, { name: 'X', date: 'lixo', sets: [] }],
    settings: { sound: false },
  });
  assert.equal(out.exercises.length, 1);
  assert.deepEqual([out.exercises[0].name, out.exercises[0].rest, out.exercises[0].muscle], ['Stiff', 90, 'Outro']);
  assert.equal(out.history.length, 1);
  assert.deepEqual(out.history[0].sets.map((x) => [x.reps, x.load]), [[10, 30]]);
  assert.equal(out.settings.sound, false);
});

test('recordes recalculados depois de corrigir o histórico', () => {
  const a = entry('2026-11-01T10:00:00', [s(12, 80), s(10, 80)]);
  const b = entry('2026-11-03T10:00:00', [s(12, 85), s(12, 85)]);
  const c = entry('2026-11-05T10:00:00', [s(8, 85)]);
  recomputeRecords([c, a, b]); // a ordem de entrada não importa
  assert.deepEqual(a.sets.map((x) => x.pr), [null, null]); // primeira sessão: referência
  assert.deepEqual(b.sets.map((x) => x.pr), [['carga', '1RM estimado'], null]);
  assert.deepEqual(c.sets.map((x) => x.pr), [null]);
  // corrigindo a carga da 2ª sessão para baixo, o recorde some dela e vai para a 3ª
  for (const x of b.sets) x.load = 80;
  recomputeRecords([a, b, c]);
  assert.deepEqual(b.sets.map((x) => x.pr), [null, null]);
  assert.deepEqual(c.sets.map((x) => x.pr), [['carga']]);
});
