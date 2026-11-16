// Gerador de sequências sintéticas de pose (33 pontos no formato do MediaPipe),
// para os testes e para o modo demonstração do treino livre. Faz o papel que o
// src/simulator.js faz para o sensor.
//
// O boneco é montado por cinemática direta a partir de poucos ângulos:
// inclinação do tronco, quadril e joelho de cada perna, e elevação e flexão
// de cada braço. Eixos da pessoa: X para o lado, Y para cima, Z para a frente.

const RAD = Math.PI / 180;
const SEG = { thigh: 0.42, shin: 0.42, trunk: 0.5, upper: 0.28, fore: 0.26, hipHalf: 0.1, shoulderHalf: 0.18, neck: 0.2 };

function rng(seed) {
  let a = seed >>> 0;
  const uniform = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return () => Math.sqrt(-2 * Math.log(uniform() || 1e-12)) * Math.cos(2 * Math.PI * uniform());
}

const add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => {
  const n = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / n, a[1] / n, a[2] / n];
};
const mix = (a, b, ca, cb) => [a[0] * ca + b[0] * cb, a[1] * ca + b[1] * cb, a[2] * ca + b[2] * cb];

/** Braço relaxado ao lado do corpo. */
const ARM_DOWN = { elev: 8, plane: 'sag', ef: 10, toward: 'forward' };

/** Em pé, parado. */
export const NEUTRAL = { tt: 3, hfL: 3, kfL: 3, hfR: 3, kfR: 3, armL: ARM_DOWN, armR: ARM_DOWN };

const arms = (a) => ({ armL: a, armR: a });
const legs = (hf, kf) => ({ hfL: hf, kfL: kf, hfR: hf, kfR: kf });

/** Para cada exercício: posição de partida (a) e de chegada (b) de uma repetição. */
export const SIM_EXERCISES = {
  rosca: {
    a: { ...NEUTRAL },
    b: { ...NEUTRAL, ...arms({ elev: 12, plane: 'sag', ef: 135, toward: 'forward' }) },
  },
  desenvolvimento: {
    a: { ...NEUTRAL, ...arms({ elev: 80, plane: 'front', ef: 95, toward: 'up' }) },
    b: { ...NEUTRAL, ...arms({ elev: 168, plane: 'front', ef: 10, toward: 'up' }) },
  },
  lateral: {
    a: { ...NEUTRAL, ...arms({ elev: 12, plane: 'front', ef: 12, toward: 'forward' }) },
    b: { ...NEUTRAL, ...arms({ elev: 88, plane: 'front', ef: 15, toward: 'forward' }) },
  },
  triceps: {
    a: { ...NEUTRAL, ...arms({ elev: 165, plane: 'sag', ef: 15, toward: 'back' }) },
    b: { ...NEUTRAL, ...arms({ elev: 160, plane: 'sag', ef: 120, toward: 'back' }) },
  },
  remada: {
    a: { tt: 55, ...legs(20, 25), ...arms({ elev: 55, plane: 'sag', ef: 10, toward: 'forward' }) },
    b: { tt: 55, ...legs(20, 25), ...arms({ elev: 8, plane: 'sag', ef: 100, toward: 'forward' }) },
  },
  agachamento: {
    a: { ...NEUTRAL },
    b: { tt: 35, ...legs(95, 105), ...arms({ elev: 35, plane: 'sag', ef: 10, toward: 'forward' }) },
  },
  afundo: {
    a: { ...NEUTRAL },
    b: { tt: 5, hfL: 80, kfL: 90, hfR: -15, kfR: 80, ...arms(ARM_DOWN) },
  },
  flexao: {
    a: { tt: 85, ...legs(-85, 0), ...arms({ elev: 85, plane: 'sag', ef: 5, toward: 'forward' }) },
    b: { tt: 85, ...legs(-85, 0), ...arms({ elev: 25, plane: 'sag', ef: 95, toward: 'forward' }) },
  },
};

function lerpPose(p, q, k) {
  const num = (key) => p[key] + (q[key] - p[key]) * k;
  const arm = (key) => ({
    elev: p[key].elev + (q[key].elev - p[key].elev) * k,
    ef: p[key].ef + (q[key].ef - p[key].ef) * k,
    plane: k < 0.5 ? p[key].plane : q[key].plane,
    toward: k < 0.5 ? p[key].toward : q[key].toward,
  });
  return { tt: num('tt'), hfL: num('hfL'), kfL: num('kfL'), hfR: num('hfR'), kfR: num('kfR'), armL: arm('armL'), armR: arm('armR') };
}

/** Monta os pontos (eixos da pessoa, metros, chão em Y = 0). */
function skeleton(pose) {
  const tt = pose.tt * RAD;
  const T = [0, Math.cos(tt), Math.sin(tt)]; // ao longo do tronco, para cima
  const F = [0, -Math.sin(tt), Math.cos(tt)]; // perpendicular ao tronco, para a frente
  const D = [-T[0], -T[1], -T[2]];
  const pts = {};
  const leg = (side, sx, hf, kf) => {
    const hip = [sx * SEG.hipHalf, 0, 0];
    const a = hf * RAD;
    const b = (hf - kf) * RAD;
    const knee = add(hip, [0, -Math.cos(a), Math.sin(a)], SEG.thigh);
    const ankle = add(knee, [0, -Math.cos(b), Math.sin(b)], SEG.shin);
    pts[`hip${side}`] = hip;
    pts[`knee${side}`] = knee;
    pts[`ankle${side}`] = ankle;
  };
  leg('L', 1, pose.hfL, pose.kfL);
  leg('R', -1, pose.hfR, pose.kfR);
  const neckBase = add([0, 0, 0], T, SEG.trunk);
  const arm = (side, sx, a) => {
    const shoulder = add(neckBase, [sx, 0, 0], SEG.shoulderHalf);
    const P = a.plane === 'front' ? [sx, 0, 0] : F;
    const e = a.elev * RAD;
    const upper = norm(mix(D, P, Math.cos(e), Math.sin(e)));
    let q0 = a.toward === 'up' ? T : a.toward === 'back' ? [-F[0], -F[1], -F[2]] : F;
    let q = add(q0, upper, -dot(q0, upper));
    if (Math.hypot(...q) < 0.2) {
      q0 = [sx, 0, 0];
      q = add(q0, upper, -dot(q0, upper));
    }
    q = norm(q);
    const f = a.ef * RAD;
    const fore = mix(upper, q, Math.cos(f), Math.sin(f));
    const elbow = add(shoulder, upper, SEG.upper);
    pts[`shoulder${side}`] = shoulder;
    pts[`elbow${side}`] = elbow;
    pts[`wrist${side}`] = add(elbow, fore, SEG.fore);
  };
  arm('L', 1, pose.armL);
  arm('R', -1, pose.armR);
  pts.nose = add(neckBase, T, SEG.neck);
  const floor = Math.min(pts.ankleL[1], pts.ankleR[1]);
  for (const k of Object.keys(pts)) pts[k] = [pts[k][0], pts[k][1] - floor, pts[k][2]];
  return { pts, pelvisY: -floor };
}

const INDEX = {
  nose: 0, shoulderL: 11, shoulderR: 12, elbowL: 13, elbowR: 14, wristL: 15, wristR: 16,
  hipL: 23, hipR: 24, kneeL: 25, kneeR: 26, ankleL: 27, ankleR: 28,
};
const FILL = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0, 9: 0, 10: 0, 17: 15, 18: 16, 19: 15, 20: 16, 21: 15, 22: 16, 29: 27, 30: 28, 31: 27, 32: 28 };

/**
 * Converte uma pose do boneco em um quadro no formato do MediaPipe.
 * @param {{yaw?:number, noise?:number, gauss?:Function, shiftX?:number, visibility?:Function}} [opt]
 */
export function poseToFrame(pose, opt = {}) {
  const { yaw = 20, noise = 0, gauss = () => 0, shiftX = 0 } = opt;
  const { pts, pelvisY } = skeleton(pose);
  const c = Math.cos(yaw * RAD);
  const s = Math.sin(yaw * RAD);
  const world = new Array(33);
  const image = new Array(33);
  for (const [name, i] of Object.entries(INDEX)) {
    const [X, Y, Z] = pts[name];
    const xr = X * c + Z * s;
    const zr = -X * s + Z * c;
    const visibility = opt.visibility ? opt.visibility(name) : 1;
    world[i] = { x: xr + gauss() * noise, y: -(Y - pelvisY) + gauss() * noise, z: -zr + gauss() * noise, visibility };
    image[i] = { x: 0.5 + shiftX + xr * 0.4 + gauss() * noise * 0.4, y: 0.92 - Y * 0.4 + gauss() * noise * 0.4, z: 0, visibility };
  }
  for (const [i, from] of Object.entries(FILL)) {
    world[i] = { ...world[from] };
    image[i] = { ...image[from] };
  }
  return { world, image };
}

const ease = (k) => (1 - Math.cos(Math.PI * k)) / 2;

/** Roteiro: lista de segmentos { from, to, dur } (parado quando from === to). */
export class Script {
  constructor(start = NEUTRAL) {
    this.segs = [];
    this.pose = start;
  }

  hold(dur) {
    this.segs.push({ from: this.pose, to: this.pose, dur });
    return this;
  }

  move(to, dur) {
    this.segs.push({ from: this.pose, to, dur });
    this.pose = to;
    return this;
  }

  /** Uma série: vai à posição inicial, faz as repetições e volta a ficar em pé. */
  set(id, reps, { out = 1, back = 1.2, pause = 0.15, setup = 1.2 } = {}) {
    const ex = SIM_EXERCISES[id];
    this.move(ex.a, setup).hold(0.4);
    for (let i = 0; i < reps; i++) this.move(ex.b, out).hold(pause).move(ex.a, back).hold(pause);
    this.hold(0.3).move(NEUTRAL, setup);
    return this;
  }

  /** Caminhar: joelhos alternados, quadril quase sem descer, braços balançando. */
  walk(dur, { fps = 30 } = {}) {
    const n = Math.round(dur * fps);
    for (let i = 0; i < n; i++) {
      const ph = (i / fps) * 2 * Math.PI * 0.9;
      const swing = (x) => Math.max(0, Math.sin(x));
      const pose = {
        tt: 5,
        hfL: 22 * Math.sin(ph), kfL: 8 + 55 * swing(ph + 0.6),
        hfR: -22 * Math.sin(ph), kfR: 8 + 55 * swing(ph + Math.PI + 0.6),
        armL: { elev: 8 - 18 * Math.sin(ph), plane: 'sag', ef: 20, toward: 'forward' },
        armR: { elev: 8 + 18 * Math.sin(ph), plane: 'sag', ef: 20, toward: 'forward' },
      };
      this.segs.push({ from: pose, to: pose, dur: 1 / fps });
    }
    this.pose = NEUTRAL;
    return this;
  }

  /** Pegar algo no chão: agacha uma vez com as mãos descendo. */
  pickUp() {
    const down = { tt: 55, ...legs(85, 95), ...arms({ elev: 60, plane: 'sag', ef: 10, toward: 'forward' }) };
    return this.move(down, 1.2).hold(0.6).move(NEUTRAL, 1.2);
  }

  get duration() {
    return this.segs.reduce((a, s) => a + s.dur, 0);
  }

  /** Gera os quadros { world, image, dt }. */
  *frames({ fps = 30, noise = 0.004, seed = 1, yaw = 20, visibility, shiftX } = {}) {
    const gauss = rng(seed);
    const dt = 1 / fps;
    let carry = 0;
    for (const seg of this.segs) {
      let t = carry;
      for (; t < seg.dur; t += dt) {
        const k = seg.from === seg.to ? 0 : ease(t / seg.dur);
        const pose = seg.from === seg.to ? seg.from : lerpPose(seg.from, seg.to, k);
        yield { ...poseToFrame(pose, { yaw, noise, gauss, visibility, shiftX }), dt };
      }
      carry = t - seg.dur;
    }
  }
}
