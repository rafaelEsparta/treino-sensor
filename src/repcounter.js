// Contador de repetições e de descanso para o sensor preso na pilha de pesos.
//
// A pilha só se move na vertical e não gira, então os ângulos não servem.
// O que se usa é a aceleração ao longo da gravidade:
//   1. estima-se o vetor gravidade (média lenta da aceleração);
//   2. projeta-se a aceleração nesse vetor e subtrai-se 1 g -> aceleração vertical;
//   3. integra-se para obter velocidade vertical, zerando-a quando o sensor
//      está parado (ZUPT) e aplicando um vazamento lento contra a deriva;
//   4. uma máquina de estados segue subida -> topo -> descida = 1 repetição.
//
// Módulo puro (sem DOM), reaproveitável no React Native.

const G = 9.80665;

export const DEFAULTS = {
  velOn: 0.05, // m/s: velocidade que caracteriza movimento
  minRange: 0.08, // m: deslocamento mínimo de subida para valer como repetição
  minRepDur: 0.6, // s: duração mínima de uma repetição
  stillAcc: 0.08, // m/s²: abaixo disso (média) o sensor é considerado parado
  stillTime: 0.5, // s parado antes de zerar a velocidade
  velLeakTau: 3, // s: constante do vazamento da velocidade
  topTimeout: 10, // s: espera máxima no topo antes de descartar a subida
  restDetect: 3, // s sem movimento para encerrar a série
  restTarget: 90, // s: descanso predefinido
  handlingGyro: 60, // °/s: rotação acima disso = sensor sendo manuseado (0 desliga)
  // false: parte de baixo, sobe e desce (pilha de pesos).
  // true: parte de cima, desce e sobe (agachamento, leg press 45).
  downFirst: false,
};

export class RepCounter {
  constructor(options = {}) {
    this.cfg = { ...DEFAULTS, ...options };
    this.reset();
  }

  reset() {
    this.t = 0;
    this.g = null; // vetor gravidade estimado (em g)
    this.delay = [];
    this.gAge = 0; // s desde a última (re)inicialização da gravidade
    this.turningFor = 0;
    this.aVert = 0; // m/s², positivo para cima
    this.vVert = 0; // m/s
    this.absAcc = 0; // média móvel de |aVert|
    this.stillFor = 0;
    this.phase = 'idle'; // idle | up | top | down
    this.cur = null; // repetição em andamento
    this.state = 'waiting'; // waiting | set | rest
    this.reps = 0; // repetições da série atual
    this.setIndex = 0;
    this.sets = []; // séries concluídas
    this.setStartT = 0;
    this.lastActiveT = 0;
    this.restStartT = 0;
    this.restAlerted = false;
    this.curSetReps = [];
  }

  get isStill() {
    return this.stillFor >= this.cfg.stillTime;
  }

  /** Segundos de descanso restantes (negativo = passou do tempo). */
  get restRemaining() {
    if (this.state !== 'rest') return null;
    return this.cfg.restTarget - (this.t - this.restStartT);
  }

  get restElapsed() {
    return this.state === 'rest' ? this.t - this.restStartT : null;
  }

  /**
   * @param {{ax:number, ay:number, az:number}} s aceleração em g
   * @param {number} dt segundos desde a amostra anterior
   * @returns {object[]} eventos: rep, setStart, setEnd, restDone
   */
  update(s, dt) {
    const c = this.cfg;
    const events = [];
    this.t += dt;

    // 0. sensor sendo manuseado? A pilha de pesos nunca gira; rotação
    // sustentada significa que o sensor está sendo trocado de lugar. Descarta
    // o movimento em curso e reaprende a gravidade na nova orientação.
    const w = Math.hypot(s.wx || 0, s.wy || 0, s.wz || 0);
    this.turningFor = c.handlingGyro > 0 && w > c.handlingGyro ? this.turningFor + dt : 0;
    if (this.turningFor >= 0.3) {
      this.g = null;
      this.delay = [];
      this.gAge = 0;
      this.vVert = 0;
      this.absAcc = 0;
      this.stillFor = 0;
      this.phase = 'idle';
      this.cur = null;
    }
    this.gAge += dt;

    // 1. gravidade
    // A estimativa só acompanha amostras atrasadas ~0,3 s e de períodos em que
    // o sensor já estava parado; assim o começo de um movimento nunca é
    // absorvido como se fosse gravidade.
    const a = [s.ax, s.ay, s.az];
    if (!this.g) {
      this.g = [...a];
    }
    // No primeiro segundo após ligar ou reposicionar, aprende a gravidade
    // direto das amostras atuais e não conta nada (o sensor deve estar parado).
    const calibrating = this.gAge < 1;
    this.delay.push(a);
    const nDelay = Math.max(1, Math.round(0.3 / dt));
    while (this.delay.length > nDelay) {
      const old = this.delay.shift();
      if (calibrating) continue;
      const kg = 1 - Math.exp(-dt / (this.isStill ? 0.5 : 20));
      for (let i = 0; i < 3; i++) this.g[i] += kg * (old[i] - this.g[i]);
    }
    if (calibrating) {
      const kc = 1 - Math.exp(-dt / 0.2);
      for (let i = 0; i < 3; i++) this.g[i] += kc * (a[i] - this.g[i]);
    }
    const gn = Math.hypot(this.g[0], this.g[1], this.g[2]) || 1;

    // 2. aceleração vertical
    const proj = (s.ax * this.g[0] + s.ay * this.g[1] + s.az * this.g[2]) / gn;
    this.aVert = (proj - gn) * G;

    // 3. parado? velocidade
    const ka = 1 - Math.exp(-dt / 0.2);
    this.absAcc += ka * (Math.abs(this.aVert) - this.absAcc);
    this.vVert = (this.vVert + this.aVert * dt) * Math.exp(-dt / c.velLeakTau);
    // Aceleração nula também ocorre no meio do curso, em velocidade máxima.
    // Por isso "parado" exige aceleração baixa E velocidade baixa. Uma
    // velocidade falsa (deriva) cai sozinha pelo vazamento até entrar aqui.
    const calm = this.absAcc < c.stillAcc && Math.abs(this.vVert) < 2 * c.velOn;
    this.stillFor = calm ? this.stillFor + dt : 0;
    const zupt = this.isStill || calibrating;
    if (zupt) this.vVert = 0;
    const quiet = this.absAcc < c.stillAcc;

    // 4. fases da repetição
    this.#stepPhase(dt, events, quiet, zupt);

    // 5. série e descanso
    if (this.phase !== 'idle') this.lastActiveT = this.t;
    if (this.state === 'set' && this.t - this.lastActiveT >= c.restDetect) {
      const set = {
        index: this.setIndex,
        reps: this.reps,
        duration: this.lastActiveT - this.setStartT,
        repDetails: this.curSetReps,
        restTarget: c.restTarget,
        restActual: null,
      };
      this.sets.push(set);
      this.state = 'rest';
      this.restStartT = this.lastActiveT; // o descanso começou quando o peso parou
      this.restAlerted = false;
      events.push({ type: 'setEnd', set });
    }
    if (this.state === 'rest' && !this.restAlerted && this.restRemaining <= 0) {
      this.restAlerted = true;
      events.push({ type: 'restDone' });
    }
    return events;
  }

  /** Encerra a série em andamento sem esperar a detecção de parada. */
  finishSet() {
    if (this.state !== 'set') return null;
    const set = {
      index: this.setIndex,
      reps: this.reps,
      duration: this.lastActiveT - this.setStartT,
      repDetails: this.curSetReps,
      restTarget: this.cfg.restTarget,
      restActual: null,
    };
    this.sets.push(set);
    this.state = 'rest';
    this.restStartT = this.t;
    this.restAlerted = false;
    this.phase = 'idle';
    this.cur = null;
    return set;
  }

  #stepPhase(dt, events, quiet, zupt) {
    const c = this.cfg;
    // Com downFirst, a máquina de estados enxerga o movimento espelhado: as
    // fases "up/top/down" passam a significar descida, fundo e subida.
    const v = this.cfg.downFirst ? -this.vVert : this.vVert;
    const cur = this.cur;
    // Deslocamento medido com o sensor "quieto" fica pendente: se o trecho
    // terminar em parada confirmada era deriva e é descartado; se o movimento
    // retomar (meio do curso em velocidade constante), é contabilizado.
    if (cur && zupt) cur.pend = 0;
    const travel = (d) => {
      if (quiet) {
        cur.pend += d;
        return 0;
      }
      const total = cur.pend + d;
      cur.pend = 0;
      return total;
    };
    const flush = () => {
      const p = cur.pend;
      cur.pend = 0;
      return zupt ? 0 : p;
    };

    switch (this.phase) {
      case 'idle':
        if (v > c.velOn) {
          this.phase = 'up';
          this.cur = { startT: this.t - dt, up: 0, down: 0, upDur: 0, downDur: 0, peakVel: 0, topT: 0, pend: 0 };
        }
        break;

      case 'up':
        cur.up += travel(v * dt);
        cur.upDur += dt;
        cur.peakVel = Math.max(cur.peakVel, v);
        if (v < c.velOn / 2) {
          cur.up += flush();
          if (cur.up < c.minRange / 2) {
            this.phase = 'idle'; // foi só um tranco
            this.cur = null;
          } else {
            this.phase = 'top';
            cur.topT = this.t;
          }
        }
        break;

      case 'top':
        if (v > c.velOn) {
          this.phase = 'up'; // continuou subindo
        } else if (v < -c.velOn) {
          this.phase = 'down';
        } else if (this.t - cur.topT > c.topTimeout) {
          this.phase = 'idle';
          this.cur = null;
        }
        break;

      case 'down':
        cur.down += travel(-v * dt);
        cur.downDur += dt;
        if (v > -c.velOn / 2) {
          cur.down += flush();
          const enoughDown = cur.down >= Math.max(c.minRange / 2, 0.4 * cur.up);
          if (!enoughDown) {
            this.phase = 'top'; // descida falsa ou parcial: segue esperando
            cur.topT = this.t;
            break;
          }
          const duration = this.t - cur.startT;
          const valid = cur.up >= c.minRange && duration >= c.minRepDur;
          this.phase = 'idle';
          this.cur = null;
          if (valid) this.#countRep(cur, duration, events);
        }
        break;
    }
  }

  #countRep(cur, duration, events) {
    if (this.state !== 'set') {
      if (this.state === 'rest') {
        const last = this.sets[this.sets.length - 1];
        last.restActual = cur.startT - this.restStartT;
      }
      this.state = 'set';
      this.setIndex += 1;
      this.reps = 0;
      this.curSetReps = [];
      this.setStartT = cur.startT;
      events.push({ type: 'setStart', index: this.setIndex });
    }
    this.reps += 1;
    const rep = {
      n: this.reps,
      range: cur.up,
      upDur: cur.upDur,
      downDur: cur.downDur,
      duration,
      peakVel: cur.peakVel,
    };
    this.curSetReps.push(rep);
    events.push({ type: 'rep', rep });
  }
}
