// Contador de repetições por pose (treino livre, sem máquina).
//
//   sinais suavizados (src/pose.js)
//     -> um detector de ciclo por articulação e lado (ida e volta com histerese)
//     -> cada ciclo é descrito (amplitudes, postura) e classificado por regras
//     -> máquina de série/descanso com a mesma semântica do RepCounter do sensor:
//        estados waiting | set | rest e eventos rep, setStart, setEnd, restDone
//        (mais o evento `exercise`, quando o exercício é identificado ou trocado).
//
// Módulo puro (sem DOM).

import { postureOf } from './pose.js';

/**
 * Exercícios reconhecidos. `group` é a articulação cujo ciclo conta a repetição
 * e `dir` o sentido da ida: -1 quando o ângulo diminui (flexiona) e +1 quando
 * aumenta (estende ou eleva). O sentido evita contar o movimento de pegar ou
 * largar os halteres como repetição.
 */
export const POSE_EXERCISES = [
  { id: 'rosca', name: 'Rosca direta', muscle: 'Bíceps', group: 'elbow', minAmp: 60, dir: -1 },
  { id: 'desenvolvimento', name: 'Desenvolvimento', muscle: 'Ombros', group: 'elbow', minAmp: 45, dir: 1 },
  { id: 'lateral', name: 'Elevação lateral', muscle: 'Ombros', group: 'shoulder', minAmp: 40, dir: 1 },
  { id: 'triceps', name: 'Tríceps acima da cabeça', muscle: 'Tríceps', group: 'elbow', minAmp: 45, dir: -1 },
  { id: 'remada', name: 'Remada curvada', muscle: 'Costas', group: 'elbow', minAmp: 40, dir: -1 },
  { id: 'agachamento', name: 'Agachamento', muscle: 'Quadríceps', group: 'knee', minAmp: 45, dir: -1 },
  { id: 'afundo', name: 'Afundo', muscle: 'Quadríceps', group: 'knee', minAmp: 40, dir: -1 },
  { id: 'flexao', name: 'Flexão de braço', muscle: 'Peito', group: 'elbow', minAmp: 40, dir: -1 },
];
export const POSE_EXERCISE = Object.fromEntries(POSE_EXERCISES.map((x) => [x.id, x]));

export const POSE_DEFAULTS = {
  restDetect: 4, // s sem movimento para encerrar a série
  restTarget: 90, // s de descanso predefinido
  confirmReps: 2, // repetições iguais para identificar um exercício novo
  switchReps: 3, // repetições seguidas de outro exercício para trocar no meio da série
  pendingGap: 8, // s máximos entre as repetições usadas na identificação
};

const GROUPS = ['elbow', 'shoulder', 'knee'];
const DETECTOR_OPTS = {
  elbow: { minAmp: 40 },
  shoulder: { minAmp: 35 },
  knee: { minAmp: 40 },
};

/**
 * Detecta ciclos de ida e volta de um ângulo a partir dos pontos de virada.
 * Cada trecho entre duas viradas é um "lance"; dois lances seguidos (ida e
 * volta) formam um ciclo, emitido quando a volta alcança 70% da ida. Todo par
 * de lances vizinhos é emitido, nos dois sentidos: quem recebe escolhe o
 * sentido que vale para o exercício.
 */
export class CycleDetector {
  constructor({ hyst = 15, minAmp = 35, minDur = 0.4, maxDur = 8, back = 0.7 } = {}) {
    Object.assign(this, { hyst, minAmp, minDur, maxDur, back });
    this.reset();
  }

  reset() {
    this.turn = null; // último ponto de virada
    this.dir = 0; // sentido do lance atual (0 = parado)
    this.extreme = null; // ponto mais distante do lance atual
    this.leaveT = 0; // quando o lance atual saiu de perto da virada
    this.prev = null; // lance anterior completo: { tStart, amp, dir, used }
    this.last = null;
    this.speed = 0; // graus/s, velocidade média recente
    this.lostFor = 0;
  }

  /** Abandona o que estava em andamento (quadro ruim, corpo fora da câmera). */
  cancel() {
    const { last } = this;
    this.reset();
    this.last = last;
  }

  get moving() {
    return this.dir !== 0 && Math.abs(this.speed) > 8;
  }

  /** @returns {object|null} o ciclo, quando ele se completa */
  update(v, t, dt) {
    if (v === null || v === undefined) {
      this.lostFor += dt;
      if (this.lostFor > 1) this.cancel();
      return null;
    }
    this.lostFor = 0;
    if (this.last !== null && dt > 0) {
      // velocidade com sinal: o tremor dos pontos se cancela, o movimento real não
      this.speed += (1 - Math.exp(-dt / 0.3)) * ((v - this.last) / dt - this.speed);
    }
    this.last = v;
    if (!this.turn) this.turn = { v, t };

    if (this.dir === 0) {
      if (Math.abs(v - this.turn.v) < this.hyst) {
        // parado: o nível de repouso acompanha devagar
        this.turn.v += (1 - Math.exp(-dt / 0.5)) * (v - this.turn.v);
        this.turn.t = t;
        this.leaveT = t;
      } else {
        this.dir = Math.sign(v - this.turn.v);
        this.extreme = { v, t };
      }
      return null;
    }

    const progress = this.dir * (v - this.turn.v);
    if (progress < this.hyst) this.leaveT = t;
    if (this.dir * (v - this.extreme.v) > 0) {
      this.extreme = { v, t };
    } else if (this.dir * (this.extreme.v - v) >= this.hyst) {
      // virou: o lance atual terminou no extremo
      this.prev = { tStart: this.leaveT, amp: Math.abs(this.extreme.v - this.turn.v), dir: this.dir, from: this.turn.v, to: this.extreme.v, used: false };
      this.turn = this.extreme;
      this.dir = -this.dir;
      this.extreme = { v, t };
      this.leaveT = t;
      return this.#check(t);
    }
    return this.#check(t);
  }

  #check(t) {
    const out = this.prev;
    if (!out || out.used || out.amp < this.minAmp) return null;
    const backAmp = Math.abs(this.extreme.v - this.turn.v);
    if (backAmp < this.back * out.amp) return null;
    out.used = true;
    const dur = t - out.tStart;
    if (dur < this.minDur || dur > this.maxDur) return null;
    return { tStart: out.tStart, tPeak: this.turn.t, tEnd: t, dur, amp: out.amp, dir: out.dir, base: out.from, peak: out.to };
  }
}

function stats(frames, key) {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let n = 0;
  for (const fr of frames) {
    const v = fr.f[key];
    if (v === null || v === undefined) continue;
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    n++;
  }
  return n < 3 ? null : { min, max, range: max - min, mean: sum / n };
}

/** Resume o que o corpo fez durante um ciclo, do ponto de vista de um lado. */
export function describeCycle(frames, side) {
  const other = side === 'L' ? 'R' : 'L';
  const hipY = stats(frames, 'hipY');
  const ref = frames.length ? frames[frames.length - 1].f.torsoRef : null;
  return {
    elbow: stats(frames, `elbow${side}`),
    shoulder: stats(frames, `shoulder${side}`),
    knee: stats(frames, `knee${side}`),
    kneeOther: stats(frames, `knee${other}`),
    hipL: stats(frames, 'hipL'),
    hipR: stats(frames, 'hipR'),
    trunk: stats(frames, 'trunk'),
    legs: stats(frames, 'legs'),
    hipDrop: hipY && ref ? hipY.range / ref : null,
  };
}

/**
 * Regras de identificação. Devolve o id do exercício mais provável para um
 * ciclo da articulação `group`, ou null se o movimento não é um exercício.
 */
export function classifyCycle(d, group) {
  if (!d.trunk) return null;
  const posture = postureOf(d.trunk.mean, d.legs ? d.legs.mean : null);

  if (group === 'elbow') {
    if (!d.elbow || d.elbow.range < 40) return null;
    if (posture === 'deitado') return 'flexao';
    if (posture === 'inclinado') return 'remada';
    if (!d.shoulder) return null;
    if (d.shoulder.min >= 115) return 'triceps'; // braço acima da cabeça o tempo todo
    if (d.shoulder.max >= 125 && d.shoulder.range >= 40) return 'desenvolvimento'; // braço sobe junto
    if (d.shoulder.max <= 60 && d.elbow.range >= 60) return 'rosca'; // braço colado ao tronco
    return null;
  }

  if (group === 'shoulder') {
    if (posture !== 'em_pe' || !d.shoulder || d.shoulder.range < 40) return null;
    const armStraight = d.elbow && d.elbow.min >= 125 && d.elbow.range < 40;
    if (armStraight && d.shoulder.max >= 55 && d.shoulder.max <= 125) return 'lateral';
    return null;
  }

  if (group === 'knee') {
    if (posture === 'deitado' || !d.knee || d.knee.range < 40) return null;
    if (!d.kneeOther || d.kneeOther.range < 25) return null; // um joelho só: é passo, não agachamento
    if (d.hipDrop !== null && d.hipDrop < 0.2) return null; // o quadril não desceu
    if (!d.hipL || !d.hipR) return null;
    // No afundo uma coxa vai à frente e a outra fica para trás.
    return Math.abs(d.hipL.min - d.hipR.min) >= 35 ? 'afundo' : 'agachamento';
  }
  return null;
}

export class PoseRepCounter {
  constructor(options = {}) {
    this.cfg = { ...POSE_DEFAULTS, ...options };
    this.reset();
  }

  reset() {
    this.t = 0;
    this.state = 'waiting'; // waiting | set | rest
    this.exercise = null; // id do exercício atual (ou do último)
    this.locked = false; // true = exercício escolhido à mão, sem classificador
    this.reps = 0;
    this.setIndex = 0;
    this.sets = [];
    this.curSetReps = [];
    this.setStartT = 0;
    this.lastRepT = 0;
    this.lastActiveT = 0;
    this.restStartT = 0;
    this.restAlerted = false;
    this.pending = null; // repetições candidatas antes de abrir a série
    this.alt = null; // repetições de outro exercício durante a série
    this.override = {}; // correções do usuário: exercício detectado -> exercício escolhido
    this.lastCandidate = {}; // por articulação, para não contar os dois braços em dobro
    this.badFor = 0;
    this.buffer = [];
    this.detectors = {};
    for (const g of GROUPS) {
      for (const side of ['L', 'R']) this.detectors[g + side] = new CycleDetector(DETECTOR_OPTS[g]);
    }
  }

  get restRemaining() {
    return this.state === 'rest' ? this.cfg.restTarget - (this.t - this.restStartT) : null;
  }

  /**
   * Fixa o exercício (correção por toque ou modo manual). Mantém a contagem.
   * No descanso, renomeia a série que acabou de fechar.
   */
  setExercise(id, { lock = false } = {}) {
    if (!POSE_EXERCISE[id]) throw new Error(`Exercício desconhecido: ${id}`);
    // Guarda a correção: da próxima vez que detectar o mesmo movimento, já usa a escolha.
    if (!lock && this.exercise && this.exercise !== id) {
      const detected = Object.keys(this.override).find((k) => this.override[k] === this.exercise) || this.exercise;
      if (detected === id) delete this.override[detected];
      else this.override[detected] = id;
    }
    this.locked = lock;
    this.exercise = id;
    this.alt = null;
    this.pending = null;
    if (this.state === 'rest' && this.sets.length) this.sets[this.sets.length - 1].exercise = id;
  }

  /** Corrige a contagem à mão: na série em andamento, ou na última série durante o descanso. */
  adjust(delta) {
    if (this.state === 'set') {
      this.reps = Math.max(0, this.reps + delta);
      this.curSetReps.length = Math.min(this.curSetReps.length, this.reps);
    } else if (this.state === 'rest' && this.sets.length) {
      const last = this.sets[this.sets.length - 1];
      last.reps = Math.max(0, last.reps + delta);
    }
  }

  /** Volta à identificação automática. */
  unlock() {
    this.locked = false;
  }

  /**
   * @param {object} f sinais suavizados (FeatureSmoother.update)
   * @param {number} dt segundos desde o quadro anterior
   * @returns {object[]} eventos
   */
  update(f, dt) {
    const c = this.cfg;
    const events = [];
    this.t += dt;
    const t = this.t;

    if (f.quality !== 'ok') {
      // Quadro ruim: não conta nem classifica. Se durar, descarta o que estava em curso.
      this.badFor += dt;
      if (this.badFor > 1) for (const d of Object.values(this.detectors)) d.cancel();
    } else {
      this.badFor = 0;
      this.buffer.push({ t, f });
      while (this.buffer.length && this.buffer[0].t < t - 12) this.buffer.shift();
      for (const g of GROUPS) {
        for (const side of ['L', 'R']) {
          const cycle = this.detectors[g + side].update(f[g + side], t, dt);
          if (cycle) this.#onCycle(cycle, g, side, events);
        }
      }
    }

    if (this.state === 'set') {
      const g = POSE_EXERCISE[this.exercise].group;
      if (this.detectors[`${g}L`].moving || this.detectors[`${g}R`].moving) this.lastActiveT = t;
      if (t - this.lastActiveT >= c.restDetect) events.push({ type: 'setEnd', set: this.#closeSet(this.lastRepT) });
    }
    if (this.state === 'rest' && !this.restAlerted && this.restRemaining <= 0) {
      this.restAlerted = true;
      events.push({ type: 'restDone' });
    }
    if (this.pending && t - this.pending.cycles[this.pending.cycles.length - 1].tEnd > c.pendingGap) this.pending = null;
    return events;
  }

  /** Encerra a série em andamento sem esperar a detecção de parada. */
  finishSet() {
    return this.state === 'set' ? this.#closeSet(this.t) : null;
  }

  #onCycle(cycle, group, side, events) {
    // Os dois braços (ou pernas) fazem o mesmo movimento ao mesmo tempo: conta uma vez só.
    const prev = this.lastCandidate[group];
    if (prev) {
      const overlap = Math.min(prev.tEnd, cycle.tEnd) - Math.max(prev.tStart, cycle.tStart);
      if (overlap >= 0.5 * Math.min(prev.dur, cycle.dur)) return;
    }

    let label;
    if (this.locked) {
      const ex = POSE_EXERCISE[this.exercise];
      label = ex.group === group && cycle.dir === ex.dir && cycle.amp >= ex.minAmp * 0.8 ? ex.id : null;
    } else {
      const frames = this.buffer.filter((fr) => fr.t >= cycle.tStart && fr.t <= cycle.tEnd);
      label = classifyCycle(describeCycle(frames, side), group);
      if (label && cycle.amp < POSE_EXERCISE[label].minAmp) label = null;
      if (label && (POSE_EXERCISE[label].group !== group || POSE_EXERCISE[label].dir !== cycle.dir)) label = null;
      // correção feita pelo usuário para este movimento (só entre exercícios da mesma articulação e sentido)
      const fix = label && POSE_EXERCISE[this.override[label]];
      if (fix && fix.group === group && fix.dir === cycle.dir) label = fix.id;
    }
    if (!label) return;
    this.lastCandidate[group] = cycle;

    if (this.state === 'set') {
      if (label === this.exercise) {
        this.alt = null;
        this.#countRep(cycle, events);
        return;
      }
      // Outro exercício no meio da série: só troca com evidência sustentada.
      const sameSignal = POSE_EXERCISE[label].group === POSE_EXERCISE[this.exercise].group;
      if (!this.alt || this.alt.label !== label) this.alt = { label, cycles: [], counted: 0 };
      this.alt.cycles.push(cycle);
      if (sameSignal) {
        // Mesmo movimento, só a classificação oscilou: segue contando.
        this.#countRep(cycle, events);
        this.alt.counted += 1;
      }
      if (this.alt.cycles.length >= this.cfg.switchReps) {
        const { cycles, counted } = this.alt;
        this.alt = null;
        // Devolve as repetições que tinham ido para o exercício antigo.
        this.reps = Math.max(0, this.reps - counted);
        this.curSetReps.length = Math.min(this.curSetReps.length, this.reps);
        const lastKept = this.curSetReps[this.curSetReps.length - 1];
        this.lastRepT = lastKept ? lastKept.tEnd : this.setStartT;
        if (this.reps > 0) events.push({ type: 'setEnd', set: this.#closeSet(this.lastRepT) });
        else this.#dropSet();
        this.#startSet(label, cycles, events);
      }
      return;
    }

    // Fora de série: junta repetições iguais até ter certeza do exercício.
    const p = this.pending;
    if (p && p.label === label) p.cycles.push(cycle);
    else this.pending = { label, cycles: [cycle] };
    const sameAsBefore = this.state === 'rest' && label === this.exercise;
    const need = this.locked || sameAsBefore ? 1 : this.cfg.confirmReps;
    if (this.pending.cycles.length >= need) {
      const { cycles } = this.pending;
      this.pending = null;
      this.#startSet(label, cycles, events);
    }
  }

  #startSet(label, cycles, events) {
    if (this.state === 'rest' && this.sets.length) {
      this.sets[this.sets.length - 1].restActual = Math.max(0, cycles[0].tStart - this.restStartT);
    }
    const changed = label !== this.exercise;
    this.state = 'set';
    this.exercise = label;
    this.setIndex += 1;
    this.reps = 0;
    this.curSetReps = [];
    this.setStartT = cycles[0].tStart;
    if (changed || this.setIndex === 1) events.push({ type: 'exercise', id: label });
    events.push({ type: 'setStart', index: this.setIndex, exercise: label });
    // As repetições usadas para identificar entram na contagem.
    for (const cy of cycles) this.#countRep(cy, events);
  }

  #countRep(cycle, events) {
    this.reps += 1;
    this.lastRepT = cycle.tEnd;
    this.lastActiveT = this.t;
    const rep = { n: this.reps, amp: cycle.amp, duration: cycle.dur, tEnd: cycle.tEnd };
    this.curSetReps.push(rep);
    events.push({ type: 'rep', rep });
  }

  #closeSet(restFrom) {
    const set = {
      index: this.setIndex,
      exercise: this.exercise,
      reps: this.reps,
      duration: Math.max(0, this.lastRepT - this.setStartT),
      repDetails: this.curSetReps,
      restTarget: this.cfg.restTarget,
      restActual: null,
    };
    this.sets.push(set);
    this.state = 'rest';
    this.restStartT = restFrom; // o descanso conta a partir da última repetição
    this.restAlerted = false;
    this.alt = null;
    return set;
  }

  /** Série aberta que ficou sem repetições (trocou de exercício antes de valer). */
  #dropSet() {
    this.setIndex -= 1;
    this.state = this.sets.length ? 'rest' : 'waiting';
  }
}
