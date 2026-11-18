import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectPlatform, installInstructions } from '../src/install.js';

test('reconhece iPhone, iPad moderno e Android', () => {
  assert.equal(detectPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'), 'ios');
  assert.equal(detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5), 'ios');
  assert.equal(detectPlatform('Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120'), 'android');
});

test('não confunde Mac de mesa nem Windows com celular', () => {
  assert.equal(detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0), 'outro');
  assert.equal(detectPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), 'outro');
});

test('cada plataforma tem instrução própria', () => {
  assert.match(installInstructions('ios'), /Tela de Início/);
  assert.match(installInstructions('android'), /Instalar app/);
  assert.match(installInstructions('outro'), /Instalar app/);
});
