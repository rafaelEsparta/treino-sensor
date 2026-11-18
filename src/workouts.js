// Treinos montados (ficha A/B/C): sequência, importação por texto, link de
// compartilhamento e resumo do dia. Módulo puro (sem DOM).

import { DEFAULT_EXERCISES, DEFAULT_REST, DEFAULT_STEP } from './defaults.js';
import { dayKey, e1rm } from './stats.js';

/** [nome do treino, nomes dos exercícios padrão] */
export const DEFAULT_WORKOUTS = [
  ['A · Pernas', ['Agachamento livre', 'Leg press 45', 'Cadeira extensora', 'Mesa flexora', 'Panturrilha sentado']],
  ['B · Peito, ombros e tríceps', ['Supino máquina', 'Crucifixo máquina', 'Desenvolvimento máquina', 'Elevação lateral máquina', 'Tríceps na polia']],
  ['C · Costas e bíceps', ['Puxada alta', 'Remada baixa', 'Remada máquina', 'Rosca na polia', 'Abdominal máquina']],
];

/** Nome sem acento, caixa nem espaços sobrando: para comparar exercícios. */
export const normName = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Nome de treino para comparar: "Treino A - Pernas" e "A · Pernas" são o mesmo. */
export const workoutKey = (s) => normName(s).replace(/^(treino|ficha)\s+(?=\S)/, '');

/** Monta os treinos padrão com os exercícios que existirem na lista. */
export function defaultWorkouts(exercises, uid) {
  const byName = new Map(exercises.map((x) => [normName(x.name), x]));
  return DEFAULT_WORKOUTS.map(([name, names]) => ({ id: uid(), name, items: names.map((n) => byName.get(normName(n))?.id).filter(Boolean) })).filter((w) => w.items.length >= 2);
}

/**
 * Próximo treino da sequência: o que vem depois do último feito (em roda).
 * Sem histórico de treinos, o primeiro.
 */
export function nextWorkout(workouts, history) {
  if (!workouts.length) return null;
  let last = null;
  for (const e of history) {
    if (!e.workoutId || !workouts.some((w) => w.id === e.workoutId)) continue;
    if (!last || new Date(e.date) >= new Date(last.date)) last = e;
  }
  if (!last) return workouts[0];
  return workouts[(workouts.findIndex((w) => w.id === last.workoutId) + 1) % workouts.length];
}

/** Data do último registro de um treino, ou null. */
export function lastDone(workout, history) {
  let last = null;
  for (const e of history) if (e.workoutId === workout.id && (!last || new Date(e.date) > new Date(last))) last = e.date;
  return last;
}

// ---------- importação por texto ----------
const SETS = /(\d{1,2})\s*[x×]\s*(\d{1,3})(?:\s*(?:-|–|a|até)\s*(\d{1,3}))?/i;
const LOAD = /(\d+(?:[.,]\d+)?)\s*kg/i;
const REST = /(?:descanso|desc\.?|intervalo|pausa)\s*:?\s*(?:de\s*)?(\d+(?:[.,]\d+)?)\s*(min|m\b|'|s|seg)?|(\d+)\s*(?:seg|s)(?![\p{L}\d])/iu;
const HEADER = /^(treino|ficha|dia|workout)\b/i;

/**
 * Lê uma ficha escrita em texto. Aceita o que um professor mandaria por
 * mensagem:
 *
 *   Treino A - Pernas
 *   Agachamento livre 3x12 50 kg
 *   Leg press 45 - 4 x 10, 90kg, descanso 60s
 *
 * Uma linha vira título de treino quando começa com "Treino", "Ficha" ou
 * "Dia", termina com ":" ou abre um bloco (primeira linha, ou depois de uma
 * linha em branco) sem ter séries × repetições. Faixa "8-12" usa o topo.
 * @returns {{name:string, items:{name:string,sets:number,reps:number,load:number|null,rest:number|null}[]}[]}
 */
export function parseWorkouts(text) {
  const out = [];
  let current = null;
  let blockStart = true;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/^[\s>#]*(?:[-*•–]\s+|\d{1,2}[.)]\s+)?/, '').replace(/\*\*/g, '').trim();
    if (!line) {
      blockStart = true;
      continue;
    }
    const m = SETS.exec(line);
    const isHeader = !m && (HEADER.test(line) || /:$/.test(line) || blockStart);
    blockStart = false;
    if (isHeader) {
      current = { name: line.replace(/:$/, '').trim().slice(0, 40), items: [] };
      out.push(current);
      continue;
    }
    // nome: o que vem antes da primeira especificação (séries, carga ou descanso)
    const cuts = [m?.index, LOAD.exec(line)?.index, REST.exec(line)?.index].filter((i) => i !== undefined);
    const name = (cuts.length ? line.slice(0, Math.min(...cuts)) : line).replace(/[\s\-–—:,;|(]+$/, '').trim().slice(0, 40);
    if (!name) continue;
    if (!current) {
      current = { name: 'Treino importado', items: [] };
      out.push(current);
    }
    const load = LOAD.exec(line);
    const rest = REST.exec(line);
    let restS = null;
    if (rest) {
      const v = Number(String(rest[1] ?? rest[3]).replace(',', '.'));
      restS = /^(min|m|')$/i.test(rest[2] || '') ? Math.round(v * 60) : Math.round(v);
    }
    current.items.push({
      name,
      sets: m ? Math.max(1, Number(m[1])) : 3,
      reps: m ? Math.max(1, Number(m[3] || m[2])) : 12,
      load: load ? Number(load[1].replace(',', '.')) : null,
      rest: restS && restS >= 5 ? Math.min(900, restS) : null,
    });
  }
  return out.filter((w) => w.items.length);
}

/** Texto de uma ou mais fichas, no mesmo formato que parseWorkouts lê. */
export function workoutsToText(workouts, exercises) {
  const byId = new Map(exercises.map((x) => [x.id, x]));
  const br = (v) => String(v).replace('.', ',');
  return workouts
    .map((w) => [w.name, ...w.items.map((id) => byId.get(id)).filter(Boolean).map((x) => `${x.name} ${x.sets}x${x.reps}${x.load ? ` ${br(x.load)} kg` : ''} descanso ${x.rest} s`)].join('\n'))
    .join('\n\n');
}

/**
 * Aplica fichas lidas por parseWorkouts. Exercício com o mesmo nome é
 * reaproveitado e recebe as séries, repetições e descanso da ficha (a carga
 * só entra se ele ainda não tinha uma própria). Treino com o mesmo nome é
 * substituído.
 * @returns {{workouts:number, created:number, updated:number}}
 */
export function applyWorkoutImport(store, parsed, uid) {
  const defaults = new Map(DEFAULT_EXERCISES.map((d) => [normName(d[0]), d]));
  const byName = new Map(store.exercises.filter((x) => !x.pose).map((x) => [normName(x.name), x]));
  let created = 0;
  const touched = new Set();
  for (const w of parsed) {
    const ids = [];
    for (const it of w.items) {
      const key = normName(it.name);
      let x = byName.get(key);
      if (!x) {
        const def = defaults.get(key);
        x = {
          id: uid(), name: def ? def[0] : it.name, rest: DEFAULT_REST, sets: 3, reps: 12, load: null, step: DEFAULT_STEP,
          muscle: def ? def[2] : 'Outro', downFirst: def ? Boolean(def[3]) : /agachamento/.test(key), suggested: false,
        };
        store.exercises.push(x);
        byName.set(key, x);
        created++;
      } else {
        touched.add(x.id);
      }
      x.sets = it.sets;
      x.reps = it.reps;
      if (it.rest) x.rest = it.rest;
      if (it.load && (x.load === null || x.load === undefined || x.suggested)) {
        x.load = it.load;
        x.suggested = false;
      }
      if (!ids.includes(x.id)) ids.push(x.id);
    }
    const same = store.workouts.find((y) => workoutKey(y.name) === workoutKey(w.name));
    if (same) same.items = ids;
    else store.workouts.push({ id: uid(), name: w.name, items: ids });
  }
  return { workouts: parsed.length, created, updated: touched.size };
}

// ---------- link de compartilhamento ----------
/** Texto → código seguro para URL (base64url de UTF-8). */
export function encodeShare(text) {
  let bin = '';
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
/** Código do link → texto, ou null se não for válido. */
export function decodeShare(code) {
  try {
    const bin = atob(String(code).replace(/-/g, '+').replace(/_/g, '/'));
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

// ---------- resumo do dia ----------
/**
 * Resumo de um dia de treino, pronto para mostrar e compartilhar.
 * @param {object[]} history
 * @param {string} key dia no formato de dayKey (AAAA-MM-DD, horário local)
 * @param {object[]} workouts
 */
export function daySummary(history, key, workouts = []) {
  const entries = history.filter((e) => dayKey(e.date) === key && e.sets.length).sort((a, b) => new Date(a.date) - new Date(b.date));
  const exercises = [];
  let sets = 0;
  let reps = 0;
  let volume = 0;
  let prs = 0;
  let start = Infinity;
  let end = -Infinity;
  for (const e of entries) {
    let row = exercises.find((r) => (e.exId ? r.exId === e.exId : r.name === e.name));
    if (!row) {
      row = { exId: e.exId, name: e.name, sets: [], topLoad: 0, bestE1rm: 0, volume: 0, pr: false };
      exercises.push(row);
    }
    const t0 = new Date(e.date).getTime();
    let t = t0;
    e.sets.forEach((s, i) => {
      const load = s.load ?? e.load ?? 0;
      row.sets.push(s.reps);
      row.topLoad = Math.max(row.topLoad, load);
      row.bestE1rm = Math.max(row.bestE1rm, e1rm(load, s.reps));
      row.volume += s.reps * load;
      if (s.pr) row.pr = true;
      if (s.pr) prs++;
      sets++;
      reps += s.reps;
      volume += s.reps * load;
      // a entrada é criada quando a 1ª série fecha; as outras vêm depois
      if (i > 0) t += ((e.sets[i - 1].rest || 0) + (s.duration || 0)) * 1000;
    });
    start = Math.min(start, t0 - (e.sets[0].duration || 0) * 1000);
    end = Math.max(end, t);
  }
  const names = [...new Set(entries.map((e) => workouts.find((w) => w.id === e.workoutId)?.name).filter(Boolean))];
  return {
    key,
    workout: names.join(' + ') || null,
    exercises,
    sets,
    reps,
    volume,
    prs,
    minutes: entries.length ? Math.max(1, Math.round((end - start) / 60000)) : 0,
  };
}

/**
 * Compara o volume do dia com a vez anterior em que o mesmo treino foi feito.
 * @returns {{previousKey:string, previous:number, delta:number}|null} delta em fração (0,08 = 8% a mais)
 */
export function compareWithPrevious(history, key, workoutId) {
  if (!workoutId) return null;
  const vol = (k) => history.filter((e) => e.workoutId === workoutId && dayKey(e.date) === k).reduce((sum, e) => sum + e.sets.reduce((a, s) => a + s.reps * (s.load ?? e.load ?? 0), 0), 0);
  const days = [...new Set(history.filter((e) => e.workoutId === workoutId).map((e) => dayKey(e.date)))].filter((k) => k < key).sort();
  const previousKey = days[days.length - 1];
  if (!previousKey) return null;
  const previous = vol(previousKey);
  const current = vol(key);
  if (!previous || !current) return null;
  return { previousKey, previous, delta: current / previous - 1 };
}

/** Resumo em texto, para mandar por mensagem. */
export function summaryText(sum, dateLabel) {
  const n = (v) => Math.round(v).toLocaleString('pt-BR');
  const kg = (v) => `${String(Math.round(v * 2) / 2).replace('.', ',')} kg`;
  const lines = [`🏋️ ${sum.workout || 'Treino'} · ${dateLabel}`, ''];
  for (const x of sum.exercises) {
    const same = x.sets.every((r) => r === x.sets[0]);
    const reps = same ? `${x.sets.length}×${x.sets[0]}` : x.sets.join('·');
    lines.push(`• ${x.name}: ${reps}${x.topLoad ? ` · ${kg(x.topLoad)}` : ''}${x.pr ? ' ⭐' : ''}`);
  }
  lines.push('', `${sum.sets} séries · ${n(sum.reps)} repetições · ${n(sum.volume)} kg de volume · ${sum.minutes} min`);
  if (sum.prs) lines.push(`⭐ ${sum.prs} ${sum.prs === 1 ? 'recorde' : 'recordes'}`);
  return lines.join('\n');
}
