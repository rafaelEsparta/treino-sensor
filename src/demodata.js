// Histórico fictício para a página de demonstração (/demo): cerca de 12
// semanas de treino, três dias por semana, com progressão de carga.
// Nada aqui é dado real. Módulo puro (sem DOM) e determinístico.

import { DEFAULT_EXERCISES, DEFAULT_REST, newDefault } from './defaults.js';
import { POSE_EXERCISE } from './posecounter.js';
import { e1rm } from './stats.js';

const DAY = 864e5;
const WEEKS = 12;
const TARGET = 12; // repetições por série
const SETS = 3;

/** Treino de cada dia da semana (0 = segunda). `pose` marca exercício do treino livre. */
const PLAN = [
  { weekday: 0, items: ['Leg press 45', 'Cadeira extensora', 'Mesa flexora', 'Panturrilha sentado'] },
  { weekday: 2, items: ['Supino máquina', 'Puxada alta', 'Desenvolvimento máquina', 'Tríceps na polia', { pose: 'rosca', load: 8, step: 2 }] },
  { weekday: 4, items: ['Agachamento livre', 'Stiff', 'Cadeira abdutora', 'Remada baixa'] },
];

/** Exercícios que terminam batendo a meta, para a sugestão de carga aparecer. */
const READY = new Set(['Leg press 45', 'Puxada alta', 'Stiff']);

/** Faltas, para o histórico não ficar perfeito: [semana, dia da semana]. */
const MISSED = new Set(['3-4', '7-2', '9-0']);

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @param {number} now instante atual (ms). O histórico termina nesta semana.
 * @returns {{version:number, exercises:object[], history:object[]}}
 */
export function buildDemoStore(now = Date.now()) {
  const rand = rng(20261116);
  const exercises = DEFAULT_EXERCISES.map((def, i) => newDefault(def, `demo-ex-${i}`));
  const byName = new Map(exercises.map((x) => [x.name, x]));
  const poseRecords = new Map();
  const recordFor = (item) => {
    if (typeof item === 'string') return byName.get(item);
    if (!poseRecords.has(item.pose)) {
      const def = POSE_EXERCISE[item.pose];
      const x = { id: `demo-pose-${item.pose}`, name: def.name, muscle: def.muscle, pose: item.pose, rest: DEFAULT_REST, sets: SETS, reps: TARGET, load: item.load, step: item.step, suggested: false };
      poseRecords.set(item.pose, x);
      exercises.push(x);
    }
    return poseRecords.get(item.pose);
  };

  // segunda-feira desta semana, ao meio-dia (evita virar o dia com o fuso)
  const monday = new Date(now);
  monday.setHours(12, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));

  const state = new Map(); // por exercício: carga e "fôlego" (repetições que aguenta na 1ª série)
  const history = [];
  for (let w = 0; w < WEEKS; w++) {
    for (const day of PLAN) {
      if (MISSED.has(`${w}-${day.weekday}`)) continue;
      const date = new Date(monday.getTime() - (WEEKS - 1 - w) * 7 * DAY + day.weekday * DAY);
      date.setHours(18, 30, 0, 0);
      if (date.getTime() > now) continue;
      day.items.forEach((item, k) => {
        const x = recordFor(item);
        let s = state.get(x.id);
        if (!s) {
          s = { load: x.load, ability: 9.5 + rand() * 2 };
          state.set(x.id, s);
          x.suggested = false;
        }
        const reps = [0, 0.9, 1.9].map((drop) => Math.max(6, Math.min(TARGET, Math.round(s.ability - drop + (rand() - 0.5) * 0.6))));
        history.push({
          id: `demo-${history.length}`,
          date: new Date(date.getTime() + k * 12 * 60000).toISOString(),
          name: x.name,
          exId: x.id,
          muscle: x.muscle,
          load: s.load,
          ...(x.pose ? { source: 'livre' } : {}),
          sets: reps.map((r, i) => ({
            reps: r,
            load: s.load,
            duration: Math.round(r * 2.8 + rand() * 4),
            rest: i < SETS - 1 ? Math.round(84 + rand() * 18) : null,
            pr: null,
          })),
        });
        // dupla progressão: bateu todas as séries, sobe a carga e as repetições caem
        if (reps.every((r) => r >= TARGET)) {
          s.load += x.step;
          s.ability -= 2.4;
        } else {
          s.ability += 0.7 + rand() * 0.5;
        }
      });
    }
  }

  // Estado final de cada exercício: alguns prontos para subir a carga, os outros quase.
  for (const x of exercises) {
    const mine = history.filter((e) => e.exId === x.id);
    const last = mine[mine.length - 1];
    if (!last) continue;
    if (READY.has(x.name)) for (const s of last.sets) s.reps = TARGET;
    else if (last.sets.every((s) => s.reps >= TARGET)) last.sets[SETS - 1].reps = TARGET - 1;
    x.load = last.load;

    // recordes, na ordem em que aconteceram (a primeira sessão é só a referência)
    let maxLoad = 0;
    let best = 0;
    mine.forEach((e, n) => {
      for (const s of e.sets) {
        const est = e1rm(s.load, s.reps);
        const kinds = [];
        if (n > 0 && s.load > maxLoad) kinds.push('carga');
        if (n > 0 && est > best + 0.01) kinds.push('1RM estimado');
        s.pr = kinds.length ? kinds : null;
        maxLoad = Math.max(maxLoad, s.load);
        best = Math.max(best, est);
      }
    });
  }

  return { version: 4, exercises, history };
}
