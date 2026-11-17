import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_EXERCISES, newDefault } from '../src/defaults.js';
import { buildDemoStore } from '../src/demodata.js';
import { MUSCLES, e1rmSeries, exerciseEntries, suggestLoad, totals, validateImport } from '../src/stats.js';

const NOW = new Date('2026-11-16T15:00:00').getTime(); // uma segunda-feira

test('exercícios padrão: nomes únicos, grupo muscular válido e carga sugerida', () => {
  const names = DEFAULT_EXERCISES.map((d) => d[0]);
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.length >= 20);
  for (const [name, load, muscle] of DEFAULT_EXERCISES) {
    assert.ok(MUSCLES.includes(muscle), `${name}: ${muscle}`);
    assert.ok(load > 0, name);
  }
  // os principais grupos estão cobertos
  for (const m of ['Quadríceps', 'Posteriores', 'Glúteos', 'Costas', 'Peito', 'Ombros', 'Bíceps', 'Tríceps']) {
    assert.ok(DEFAULT_EXERCISES.some((d) => d[2] === m), m);
  }
  assert.deepEqual(newDefault(['X', 10, 'Peito'], 'id1'), { id: 'id1', name: 'X', rest: 90, sets: 3, reps: 12, load: 10, step: 5, muscle: 'Peito', downFirst: false, suggested: true });
  // só agachamento livre e leg press 45 partem de cima
  assert.deepEqual(DEFAULT_EXERCISES.filter((d) => d[3]).map((d) => d[0]), ['Agachamento livre', 'Leg press 45']);
});

test('demo: cerca de 12 semanas, sem datas no futuro, determinístico', () => {
  const a = buildDemoStore(NOW);
  const b = buildDemoStore(NOW);
  assert.deepEqual(a, b);
  const times = a.history.map((e) => new Date(e.date).getTime());
  assert.ok(Math.max(...times) <= NOW);
  const spanWeeks = (NOW - Math.min(...times)) / (7 * 864e5);
  assert.ok(spanWeeks > 10.5 && spanWeeks < 12.5, `semanas: ${spanWeeks}`);
  const t = totals(a.history);
  assert.ok(t.days >= 28 && t.days <= 36, `dias: ${t.days}`);
  assert.ok(a.history.every((e) => a.exercises.some((x) => x.id === e.exId)));
});

test('demo: há progressão de carga e sugestões prontas', () => {
  const { exercises, history } = buildDemoStore(NOW);
  const ready = exercises.filter((x) => suggestLoad(x, exerciseEntries(history, x)));
  assert.deepEqual(ready.map((x) => x.name).sort(), ['Leg press 45', 'Puxada alta', 'Stiff']);
  const leg = exercises.find((x) => x.name === 'Leg press 45');
  const series = e1rmSeries(exerciseEntries(history, leg));
  assert.ok(series.length >= 10);
  assert.ok(series.at(-1).value > series[0].value * 1.15, 'o 1RM estimado deve subir ao longo das semanas');
  assert.ok(leg.load > 80);
  assert.equal(suggestLoad(leg, exerciseEntries(history, leg)).load, leg.load + 5);
  // recordes marcados, mas nunca na primeira sessão de um exercício
  assert.ok(history.some((e) => e.sets.some((s) => s.pr)));
  const first = history.find((e) => e.exId === leg.id);
  assert.ok(first.sets.every((s) => s.pr === null));
  // inclui treino livre
  assert.ok(history.some((e) => e.source === 'livre' && e.name === 'Rosca direta'));
});

test('demo: os dados passam pela validação de backup sem perder registros', () => {
  const demo = buildDemoStore(NOW);
  const clean = validateImport(JSON.parse(JSON.stringify(demo)));
  assert.equal(clean.history.length, demo.history.length);
  assert.equal(clean.exercises.length, demo.exercises.length);
});
