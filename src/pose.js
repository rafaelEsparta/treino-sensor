// Sinais de pose a partir dos 33 pontos do MediaPipe Pose Landmarker:
// ângulos das articulações, inclinação do tronco, postura e qualidade do quadro.
// Módulo puro (sem DOM, sem câmera), usado pelo Lab, pelo app e pelos testes.

/** Índices dos pontos usados. */
export const LM = {
  nose: 0,
  shoulderL: 11, shoulderR: 12,
  elbowL: 13, elbowR: 14,
  wristL: 15, wristR: 16,
  hipL: 23, hipR: 24,
  kneeL: 25, kneeR: 26,
  ankleL: 27, ankleR: 28,
};

/** Ligações do esqueleto, para desenhar. */
export const BONES = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24],
  [23, 24], [23, 25], [25, 27], [24, 26], [26, 28],
];

/** Sinais de ângulo (graus). Cada um tem lado esquerdo (L) e direito (R). */
export const ANGLE_KEYS = ['elbowL', 'elbowR', 'shoulderL', 'shoulderR', 'hipL', 'hipR', 'kneeL', 'kneeR'];

export const MIN_VISIBILITY = 0.5;

/** "Para cima" nas coordenadas do MediaPipe (y cresce para baixo) com a câmera na vertical. */
export const UP_DEFAULT = [0, -1, 0];

const sub = (a, b) => [a.x - b.x, a.y - b.y, a.z - b.z];
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 });
const DEG = 180 / Math.PI;

function angleBetween(u, v) {
  const nu = Math.hypot(u[0], u[1], u[2]);
  const nv = Math.hypot(v[0], v[1], v[2]);
  if (!nu || !nv) return 0;
  const c = (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (nu * nv);
  return Math.acos(Math.max(-1, Math.min(1, c))) * DEG;
}

/** Ângulo interno em `b` formado por a-b-c, em graus (180 = reto). */
export function jointAngle(a, b, c) {
  return angleBetween(sub(a, b), sub(c, b));
}

/**
 * "Para cima" visto pela câmera a partir da leitura de gravidade do aparelho
 * (DeviceMotionEvent.accelerationIncludingGravity, celular em pé, câmera frontal).
 * Corrige a inclinação do celular apoiado. Sem leitura válida, usa a vertical.
 */
export function upFromGravity(g) {
  if (!g || ![g.x, g.y, g.z].every(Number.isFinite)) return UP_DEFAULT;
  const n = Math.hypot(g.x, g.y, g.z);
  if (n < 5 || n > 15) return UP_DEFAULT;
  const up = [g.x / n, -g.y / n, g.z / n];
  // Só confia se o celular estiver razoavelmente em pé (retrato).
  return up[1] < -0.5 ? up : UP_DEFAULT;
}

const QUALITY_TEXT = {
  ok: '',
  sem_corpo: 'Não estou vendo você. Fique de frente para a câmera.',
  fora_do_quadro: 'Parte do corpo está fora do quadro. Afaste-se um pouco.',
  varias_pessoas: 'Há mais de uma pessoa no quadro. Só consigo acompanhar uma.',
  pouca_luz: 'Pouca luz. Acenda a luz ou vire-se para a claridade.',
};
export const qualityText = (q) => QUALITY_TEXT[q] ?? '';

/**
 * Extrai os sinais brutos de um quadro.
 * @param {{x:number,y:number,z:number,visibility?:number}[]|null} world pontos em metros (origem no quadril)
 * @param {{x:number,y:number,visibility?:number}[]|null} image pontos normalizados da imagem (0..1)
 * @param {{up?: number[], poses?: number, dark?: boolean}} [ctx]
 */
export function extractFeatures(world, image, ctx = {}) {
  const f = { quality: 'ok', valid: {} };
  for (const k of ANGLE_KEYS) f[k] = null;
  f.trunk = null; // inclinação do tronco em relação à vertical (0 = em pé, 90 = horizontal)
  f.legs = null; // inclinação da linha quadril-tornozelo (0 = em pé, 90 = deitado)
  f.hipY = null; // altura do quadril na imagem (cresce para baixo)
  f.torsoLen = null; // comprimento do tronco na imagem, para normalizar deslocamentos

  if (ctx.dark) f.quality = 'pouca_luz';
  if (!world || !image || world.length < 29 || image.length < 29) {
    if (f.quality === 'ok') f.quality = 'sem_corpo';
    return f;
  }
  if ((ctx.poses ?? 1) > 1) f.quality = 'varias_pessoas';

  const vis = (i) => (image[i].visibility ?? world[i].visibility ?? 1) >= MIN_VISIBILITY;
  const inFrame = (i) => image[i].x > 0.01 && image[i].x < 0.99 && image[i].y > 0.01 && image[i].y < 0.99;
  const ok = (...idx) => idx.every((i) => vis(i));

  // Ombros e quadris são o mínimo para qualquer exercício.
  const core = [LM.shoulderL, LM.shoulderR, LM.hipL, LM.hipR];
  if (!core.every((i) => vis(i) && inFrame(i))) {
    if (f.quality === 'ok') f.quality = 'fora_do_quadro';
    return f;
  }

  const up = ctx.up || UP_DEFAULT;
  const W = (i) => world[i];
  const set = (key, a, b, c) => {
    if (ok(a, b, c)) {
      f[key] = jointAngle(W(a), W(b), W(c));
      f.valid[key] = true;
    }
  };
  set('elbowL', LM.shoulderL, LM.elbowL, LM.wristL);
  set('elbowR', LM.shoulderR, LM.elbowR, LM.wristR);
  set('shoulderL', LM.hipL, LM.shoulderL, LM.elbowL);
  set('shoulderR', LM.hipR, LM.shoulderR, LM.elbowR);
  set('hipL', LM.shoulderL, LM.hipL, LM.kneeL);
  set('hipR', LM.shoulderR, LM.hipR, LM.kneeR);
  set('kneeL', LM.hipL, LM.kneeL, LM.ankleL);
  set('kneeR', LM.hipR, LM.kneeR, LM.ankleR);

  const midShoulder = mid(W(LM.shoulderL), W(LM.shoulderR));
  const midHip = mid(W(LM.hipL), W(LM.hipR));
  f.trunk = angleBetween(sub(midShoulder, midHip), up);
  f.valid.trunk = true;
  if (ok(LM.ankleL, LM.ankleR)) {
    f.legs = angleBetween(sub(midHip, mid(W(LM.ankleL), W(LM.ankleR))), up);
    f.valid.legs = true;
  }
  const iShoulder = { x: (image[11].x + image[12].x) / 2, y: (image[11].y + image[12].y) / 2 };
  const iHip = { x: (image[23].x + image[24].x) / 2, y: (image[23].y + image[24].y) / 2 };
  f.hipY = iHip.y;
  f.torsoLen = Math.hypot(iShoulder.x - iHip.x, iShoulder.y - iHip.y);
  return f;
}

/** Postura a partir da inclinação do tronco e das pernas. */
export function postureOf(trunk, legs) {
  if (trunk === null || trunk === undefined) return 'indefinida';
  const lying = legs === null || legs === undefined ? trunk > 70 : legs > 50 && trunk > 50;
  if (lying) return 'deitado';
  if (trunk >= 35) return 'inclinado';
  return 'em_pe';
}
export const POSTURE_TEXT = { em_pe: 'Em pé', inclinado: 'Inclinado', deitado: 'Deitado / prancha', indefinida: '—' };

/**
 * Suaviza os sinais ao longo do tempo (média exponencial) e segura o último
 * valor quando o ponto some por pouco tempo. Um sinal que fica sem leitura
 * por mais de `hold` segundos deixa de ser válido.
 */
export class FeatureSmoother {
  constructor({ tau = 0.12, hold = 0.4 } = {}) {
    this.tau = tau;
    this.hold = hold;
    this.reset();
  }

  reset() {
    this.value = {};
    this.age = {};
    this.torsoRef = 0;
  }

  /** @returns sinais suavizados, no mesmo formato de extractFeatures, mais `posture` e `hipRel` */
  update(raw, dt) {
    const k = 1 - Math.exp(-dt / this.tau);
    const out = { quality: raw.quality, valid: {} };
    for (const key of [...ANGLE_KEYS, 'trunk', 'legs', 'hipY']) {
      const v = raw[key];
      if (v !== null && v !== undefined) {
        this.value[key] = this.value[key] === undefined ? v : this.value[key] + k * (v - this.value[key]);
        this.age[key] = 0;
      } else if (this.age[key] !== undefined) {
        this.age[key] += dt;
      }
      const fresh = this.age[key] !== undefined && this.age[key] <= this.hold;
      out[key] = fresh ? this.value[key] : null;
      if (fresh) out.valid[key] = true;
      else delete this.value[key];
    }
    // Referência de tamanho: o maior tronco visto, esquecendo devagar
    // (o tronco "encurta" na imagem quando a pessoa se inclina para a câmera).
    if (raw.torsoLen) this.torsoRef = Math.max(this.torsoRef * Math.exp(-dt / 30), raw.torsoLen);
    out.torsoRef = this.torsoRef || null;
    out.posture = postureOf(out.trunk, out.legs);
    return out;
  }
}

/** Compacta um quadro para gravação: [[x, y, z, visibilidade], ...] com 4 casas. */
export function packFrame(world, image, dt) {
  const r = (v) => Math.round(v * 1e4) / 1e4;
  return {
    dt: r(dt),
    w: world ? world.map((p) => [r(p.x), r(p.y), r(p.z), r(p.visibility ?? 1)]) : null,
    i: image ? image.map((p) => [r(p.x), r(p.y), r(p.visibility ?? 1)]) : null,
  };
}

/** Inverso de packFrame. */
export function unpackFrame(fr) {
  return {
    dt: fr.dt,
    world: fr.w ? fr.w.map(([x, y, z, visibility]) => ({ x, y, z, visibility })) : null,
    image: fr.i ? fr.i.map(([x, y, visibility]) => ({ x, y, z: 0, visibility })) : null,
  };
}
