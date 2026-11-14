// Gerador de dados sintéticos de uma pilha de pesos, para testes e para o
// modo "Simulador" da tela (permite ver tudo funcionando sem o sensor).

const G = 9.80665;

// Gerador pseudoaleatório determinístico (mulberry32) + ruído gaussiano.
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

/**
 * Monta um roteiro de treino como lista de segmentos.
 * @param {{reps:number, up:number, down:number, pauseTop?:number, pauseBottom?:number, range?:number, rest?:number}[]} sets
 */
export function workoutScript(sets, lead = 2) {
  const segs = [{ kind: 'hold', dur: lead }];
  for (const s of sets) {
    for (let i = 0; i < s.reps; i++) {
      segs.push({ kind: 'move', dur: s.up, dist: s.range ?? 0.3 });
      if (s.pauseTop) segs.push({ kind: 'hold', dur: s.pauseTop });
      segs.push({ kind: 'move', dur: s.down, dist: -(s.range ?? 0.3) });
      if (s.pauseBottom) segs.push({ kind: 'hold', dur: s.pauseBottom });
    }
    segs.push({ kind: 'hold', dur: s.rest ?? 0 });
  }
  return segs;
}

/**
 * Gera amostras {ax, ay, az, wx, wy, wz, roll, pitch, yaw} a partir do roteiro.
 * Cada movimento segue um perfil em meio-cosseno (parte e chega com velocidade zero).
 */
export function* simulate(segs, { rate = 50, noise = 0.003, seed = 1, up = [0.1, -0.2, 0.97] } = {}) {
  const gauss = rng(seed);
  const n = Math.hypot(...up);
  const u = up.map((x) => x / n);
  const dt = 1 / rate;
  for (const seg of segs) {
    const steps = Math.round(seg.dur * rate);
    for (let i = 0; i < steps; i++) {
      let acc = 0;
      if (seg.kind === 'move') {
        // posição = dist/2 * (1 - cos(pi t/T))  ->  acc = dist/2 * (pi/T)^2 * cos(pi t/T)
        const w = Math.PI / seg.dur;
        acc = (seg.dist / 2) * w * w * Math.cos(w * (i + 0.5) * dt);
      }
      const f = 1 + acc / G; // força específica ao longo da vertical, em g
      yield {
        ax: u[0] * f + gauss() * noise,
        ay: u[1] * f + gauss() * noise,
        az: u[2] * f + gauss() * noise,
        wx: gauss() * 0.05,
        wy: gauss() * 0.05,
        wz: gauss() * 0.05,
        roll: -11.7 + gauss() * 0.02,
        pitch: -5.7 + gauss() * 0.02,
        yaw: 30 + gauss() * 0.02,
      };
    }
  }
}
