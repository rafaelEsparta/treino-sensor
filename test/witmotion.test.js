import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Commands, FrameParser, REG, batteryPercent, decodeFrame, interpretRegister, parseHex, toHex,
} from '../src/witmotion.js';

const le = (v) => [v & 0xff, (v >> 8) & 0xff];

function dataFrame({ a = [0, 0, 2048], w = [0, 0, 0], ang = [0, 0, 0] } = {}) {
  return Uint8Array.from([0x55, 0x61, ...[...a, ...w, ...ang].flatMap(le)]);
}

test('decodifica quadro de dados 0x61', () => {
  const f = decodeFrame(dataFrame({ a: [0, -2048, 2048], w: [16384, 0, 0], ang: [8192, -8192, 16384] }));
  assert.equal(f.type, 'data');
  assert.equal(f.ax, 0);
  assert.equal(f.ay, -1);
  assert.equal(f.az, 1);
  assert.equal(f.wx, 1000);
  assert.equal(f.roll, 45);
  assert.equal(f.pitch, -45);
  assert.equal(f.yaw, 90);
});

test('decodifica resposta de registrador 0x71 (bateria)', () => {
  const raw = Uint8Array.from([0x55, 0x71, REG.BATTERY, 0x00, ...le(398), ...new Array(14).fill(0)]);
  const f = decodeFrame(raw);
  assert.equal(f.type, 'register');
  assert.equal(f.start, REG.BATTERY);
  assert.deepEqual(interpretRegister(f), { kind: 'battery', volts: 3.98, percent: 100 });
});

test('tabela de bateria', () => {
  assert.equal(batteryPercent(380), 50);
  assert.equal(batteryPercent(330), 0);
});

test('parser remonta quadros partidos, colados e com lixo no meio', () => {
  const a = dataFrame();
  const b = dataFrame({ a: [100, 200, 300] });
  const stream = Uint8Array.from([0x00, 0x13, ...a, ...b]);
  const p = new FrameParser();
  const out = [...p.push(stream.slice(0, 7)), ...p.push(stream.slice(7, 30)), ...p.push(stream.slice(30))];
  assert.equal(out.length, 2);
  assert.equal(p.discarded, 2);
  assert.deepEqual(out[1].raw, b);
  assert.equal(out[0].frame.az, 1);
});

test('comandos', () => {
  assert.equal(toHex(Commands.setRate(50)), 'FF AA 03 08 00');
  assert.equal(toHex(Commands.readRegister(REG.BATTERY)), 'FF AA 27 64 00');
  assert.equal(toHex(Commands.save()), 'FF AA 00 00 00');
  assert.throws(() => Commands.setRate(33));
});

test('parseHex', () => {
  assert.deepEqual(parseHex('ff aa 27 3A 00'), Uint8Array.of(0xff, 0xaa, 0x27, 0x3a, 0x00));
  assert.throws(() => parseHex('zz'));
});
