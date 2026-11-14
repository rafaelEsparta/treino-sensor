// Estatísticas de treino: recordes, 1RM estimado, progressão de carga,
// atividade por dia, volume por grupo muscular, exportação e importação.
// Módulo puro (sem DOM).

export const MUSCLES = [
  'Quadríceps', 'Posteriores', 'Glúteos', 'Adutores', 'Panturrilhas',
  'Costas', 'Peito', 'Ombros', 'Bíceps', 'Tríceps', 'Abdômen', 'Outro',
];

/** 1RM estimado pela fórmula de Epley. */
export const e1rm = (load, reps) => (load > 0 && reps > 0 ? load * (1 + reps / 30) : 0);

const loadOf = (entry, set) => set.load ?? entry.load ?? null;

export function entryVolume(entry) {
  return entry.sets.reduce((sum, s) => sum + s.reps * (loadOf(entry, s) || 0), 0);
}

/** Entradas do histórico de um exercício (por id; pelo nome nas antigas). */
export function exerciseEntries(history, ex) {
  return history.filter((e) => (e.exId ? e.exId === ex.id : e.name === ex.name));
}

export function records(entries) {
  const r = { maxLoad: 0, bestE1rm: 0, bestE1rmSet: null, maxReps: 0, maxVolume: 0 };
  for (const e of entries) {
    for (const s of e.sets) {
      const load = loadOf(e, s) || 0;
      if (load > r.maxLoad) r.maxLoad = load;
      if (s.reps > r.maxReps) r.maxReps = s.reps;
      const est = e1rm(load, s.reps);
      if (est > r.bestE1rm) {
        r.bestE1rm = est;
        r.bestE1rmSet = { load, reps: s.reps, date: e.date };
      }
    }
    r.maxVolume = Math.max(r.maxVolume, entryVolume(e));
  }
  return r;
}

/**
 * Dupla progressão: se na última vez todas as séries planejadas bateram a
 * meta de repetições com a mesma carga, sugere subir a carga.
 */
export function suggestLoad(ex, entries) {
  const last = entries[entries.length - 1];
  if (!last || last.sets.length < ex.sets) return null;
  const loads = last.sets.map((s) => loadOf(last, s));
  const base = loads[0];
  if (!base || loads.some((l) => l !== base)) return null;
  if (last.sets.some((s) => s.reps < ex.reps)) return null;
  if ((ex.load || 0) > base) return null; // já subiu por conta própria
  return { load: base + (ex.step || 5), from: base, sets: last.sets.length, reps: ex.reps };
}

/** Melhor 1RM estimado de cada sessão, em ordem de data. */
export function e1rmSeries(entries) {
  return entries
    .map((e) => {
      let best = null;
      for (const s of e.sets) {
        const load = loadOf(e, s) || 0;
        const value = e1rm(load, s.reps);
        if (value > 0 && (!best || value > best.value)) best = { date: e.date, value, load, reps: s.reps };
      }
      return best;
    })
    .filter(Boolean);
}

/** Chave de dia no fuso local: AAAA-MM-DD. */
export function dayKey(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function activityByDay(history) {
  const map = new Map();
  for (const e of history) {
    const key = dayKey(e.date);
    const day = map.get(key) || { sets: 0, volume: 0 };
    day.sets += e.sets.length;
    day.volume += entryVolume(e);
    map.set(key, day);
  }
  return map;
}

export function totals(history) {
  const days = new Set();
  let sets = 0;
  let reps = 0;
  let volume = 0;
  for (const e of history) {
    days.add(dayKey(e.date));
    sets += e.sets.length;
    reps += e.sets.reduce((a, s) => a + s.reps, 0);
    volume += entryVolume(e);
  }
  return { days: days.size, sets, reps, volume };
}

/** Séries e volume por grupo muscular desde `since` (ms), do maior para o menor. */
export function muscleVolume(history, since, exercises) {
  const byId = new Map(exercises.map((x) => [x.id, x]));
  const byName = new Map(exercises.map((x) => [x.name, x]));
  const map = new Map();
  for (const e of history) {
    if (new Date(e.date).getTime() < since) continue;
    const muscle = e.muscle || byId.get(e.exId)?.muscle || byName.get(e.name)?.muscle || 'Outro';
    const m = map.get(muscle) || { muscle, sets: 0, volume: 0 };
    m.sets += e.sets.length;
    m.volume += entryVolume(e);
    map.set(muscle, m);
  }
  return [...map.values()].sort((a, b) => b.sets - a.sets);
}

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** CSV com ponto e vírgula e vírgula decimal (abre direto no Excel em pt-BR). */
export function toCSV(history) {
  const rows = [['data', 'hora', 'exercicio', 'grupo_muscular', 'serie', 'repeticoes', 'carga_kg', 'descanso_s', 'duracao_s', 'recorde']];
  for (const e of history) {
    const d = new Date(e.date);
    const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    e.sets.forEach((s, i) => {
      const load = loadOf(e, s);
      rows.push([
        dayKey(e.date), time, e.name, e.muscle || '', i + 1, s.reps,
        load === null ? '' : String(load).replace('.', ','),
        s.rest ?? '', s.duration ?? '', s.pr ? s.pr.join(' + ') : '',
      ]);
    });
  }
  return rows.map((r) => r.map(csvCell).join(';')).join('\r\n');
}

/** Valida um backup importado. Devolve os dados limpos ou lança um erro. */
export function validateImport(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.exercises) || !Array.isArray(data.history)) {
    throw new Error('Arquivo não é um backup deste app.');
  }
  const num = (v, fallback) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : fallback);
  const exercises = data.exercises
    .filter((x) => x && typeof x.name === 'string' && x.name.trim())
    .map((x) => ({
      id: String(x.id || Math.random().toString(36).slice(2, 10)),
      name: x.name.trim().slice(0, 40),
      rest: Math.max(5, num(x.rest, 90)),
      sets: Math.max(1, num(x.sets, 3)),
      reps: Math.max(1, num(x.reps, 12)),
      load: num(x.load, null),
      step: Math.max(0.5, num(x.step, 5)),
      muscle: MUSCLES.includes(x.muscle) ? x.muscle : 'Outro',
      suggested: Boolean(x.suggested),
    }));
  const history = data.history
    .filter((e) => e && typeof e.name === 'string' && Array.isArray(e.sets) && !Number.isNaN(new Date(e.date).getTime()))
    .map((e) => ({
      id: String(e.id || Math.random().toString(36).slice(2, 10)),
      date: new Date(e.date).toISOString(),
      name: e.name.slice(0, 40),
      exId: e.exId ? String(e.exId) : undefined,
      muscle: MUSCLES.includes(e.muscle) ? e.muscle : undefined,
      load: num(e.load, null),
      sets: e.sets
        .filter((s) => s && Number.isFinite(Number(s.reps)))
        .map((s) => ({
          reps: Math.max(0, Number(s.reps)),
          load: num(s.load, null),
          duration: num(s.duration, null),
          rest: num(s.rest, null),
          range: num(s.range, null),
          pr: Array.isArray(s.pr) ? s.pr.map(String).slice(0, 3) : null,
        })),
    }));
  const settings = data.settings && typeof data.settings === 'object' ? data.settings : {};
  return { exercises, history, settings };
}
