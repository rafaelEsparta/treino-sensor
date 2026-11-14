// Protocolo BLE do WitMotion WT901BLE67 (linha "BLE 5.0").
// Módulo puro: sem DOM e sem Bluetooth, para ser reaproveitado no React Native.

export const UUID = {
  service: '0000ffe5-0000-1000-8000-00805f9a34fb',
  notify: '0000ffe4-0000-1000-8000-00805f9a34fb',
  write: '0000ffe9-0000-1000-8000-00805f9a34fb',
};

export const FRAME_LEN = 20;
export const HEADER = 0x55;
export const FLAG_DATA = 0x61; // aceleração + giroscópio + ângulos (fluxo contínuo)
export const FLAG_REGISTER = 0x71; // resposta a uma leitura de registrador

// Registradores úteis (endereço do primeiro de um bloco de 8).
export const REG = {
  VERSION: 0x2e,
  MAG: 0x3a, // HX, HY, HZ
  TEMP: 0x40, // centésimos de °C
  QUATERNION: 0x51, // q0..q3, escala 1/32768
  BATTERY: 0x64, // centésimos de volt
};

// Códigos de taxa de saída para o comando FF AA 03 <código> 00.
export const RATE_CODES = {
  10: 0x06,
  20: 0x07,
  50: 0x08,
  100: 0x09,
  200: 0x0b,
};

const cmd = (a, b, c) => Uint8Array.of(0xff, 0xaa, a, b, c);

export const Commands = {
  unlock: () => cmd(0x69, 0x88, 0xb5),
  save: () => cmd(0x00, 0x00, 0x00),
  setRate: (hz) => {
    const code = RATE_CODES[hz];
    if (code === undefined) throw new Error(`Taxa não suportada: ${hz} Hz`);
    return cmd(0x03, code, 0x00);
  },
  readRegister: (reg) => cmd(0x27, reg & 0xff, 0x00),
  calibrateAccel: () => cmd(0x01, 0x01, 0x00),
  magCalibrationStart: () => cmd(0x01, 0x07, 0x00),
  magCalibrationEnd: () => cmd(0x01, 0x00, 0x00),
};

const i16 = (lo, hi) => {
  const v = (hi << 8) | lo;
  return v & 0x8000 ? v - 0x10000 : v;
};

/** Decodifica um quadro de 20 bytes. Retorna null se não for reconhecido. */
export function decodeFrame(b) {
  if (b.length < FRAME_LEN || b[0] !== HEADER) return null;
  if (b[1] === FLAG_DATA) {
    const v = (i) => i16(b[2 + i * 2], b[3 + i * 2]);
    return {
      type: 'data',
      ax: (v(0) / 32768) * 16, // g
      ay: (v(1) / 32768) * 16,
      az: (v(2) / 32768) * 16,
      wx: (v(3) / 32768) * 2000, // °/s
      wy: (v(4) / 32768) * 2000,
      wz: (v(5) / 32768) * 2000,
      roll: (v(6) / 32768) * 180, // °
      pitch: (v(7) / 32768) * 180,
      yaw: (v(8) / 32768) * 180,
    };
  }
  if (b[1] === FLAG_REGISTER) {
    const values = [];
    for (let i = 0; i < 8; i++) values.push(i16(b[4 + i * 2], b[5 + i * 2]));
    return { type: 'register', start: b[2] | (b[3] << 8), values };
  }
  return null;
}

/** Interpreta uma resposta de registrador conhecida em unidades físicas. */
export function interpretRegister(frame) {
  const v = frame.values;
  switch (frame.start) {
    case REG.BATTERY:
      return { kind: 'battery', volts: v[0] / 100, percent: batteryPercent(v[0]) };
    case REG.TEMP:
      return { kind: 'temperature', celsius: v[0] / 100 };
    case REG.MAG:
      return { kind: 'magnetometer', hx: v[0], hy: v[1], hz: v[2] };
    case REG.QUATERNION:
      return { kind: 'quaternion', q: v.slice(0, 4).map((x) => x / 32768) };
    case REG.VERSION:
      return { kind: 'version', raw: v[0] & 0xffff };
    default:
      return { kind: 'unknown', start: frame.start, values: v };
  }
}

/** Tabela tensão → carga usada pelo SDK da WitMotion (valor em centésimos de volt). */
export function batteryPercent(centivolts) {
  const table = [
    [396, 100], [393, 90], [387, 75], [382, 60], [379, 50], [377, 40],
    [373, 30], [370, 20], [368, 15], [350, 10], [340, 5],
  ];
  for (const [min, pct] of table) if (centivolts > min) return pct;
  return 0;
}

/**
 * Remonta quadros a partir das notificações BLE. Uma notificação pode trazer
 * vários quadros colados, ou um quadro pode vir partido em duas notificações.
 */
export class FrameParser {
  constructor() {
    this.buf = [];
    this.discarded = 0;
  }

  /** @param {Uint8Array} bytes @returns {{raw: Uint8Array, frame: object}[]} */
  push(bytes) {
    for (const x of bytes) this.buf.push(x);
    const out = [];
    while (this.buf.length >= 2) {
      const flag = this.buf[1];
      if (this.buf[0] !== HEADER || (flag !== FLAG_DATA && flag !== FLAG_REGISTER)) {
        this.buf.shift();
        this.discarded++;
        continue;
      }
      if (this.buf.length < FRAME_LEN) break;
      const raw = Uint8Array.from(this.buf.splice(0, FRAME_LEN));
      out.push({ raw, frame: decodeFrame(raw) });
    }
    return out;
  }
}

export const toHex = (bytes) =>
  Array.from(bytes, (x) => x.toString(16).padStart(2, '0').toUpperCase()).join(' ');

export function parseHex(text) {
  const parts = text.trim().split(/[\s,]+/).filter(Boolean);
  const bytes = parts.map((p) => Number.parseInt(p, 16));
  if (!bytes.length || bytes.some((x) => Number.isNaN(x) || x < 0 || x > 255)) {
    throw new Error('Hex inválido. Exemplo: FF AA 27 64 00');
  }
  return Uint8Array.from(bytes);
}
