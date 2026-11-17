// Service worker: deixa o app abrir sem internet (academia com sinal ruim).
// Estratégia "rede primeiro": com internet pega sempre a versão nova e
// atualiza o cache; sem internet usa a última versão guardada.
const CACHE = 'treino-v6';
const SHELL = [
  './',
  'index.html',
  'gym.css',
  'gym.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'src/witmotion.js',
  'src/repcounter.js',
  'src/stats.js',
  'free.js',
  'demo/',
  'src/defaults.js',
  'src/demodata.js',
  'src/pose.js',
  'src/posecounter.js',
  'src/posesim.js',
  'src/posecam.js',
  'src/simulator.js',
];

// Biblioteca e modelo de pose (cerca de 20 MB): guardados já na instalação
// para o treino livre funcionar offline. Se a rede falhar aqui, o app ainda
// instala e esses arquivos entram no cache na primeira vez que forem usados.
const POSE = [
  'vendor/mediapipe/vision_bundle.mjs',
  'vendor/mediapipe/wasm/vision_wasm_internal.js',
  'vendor/mediapipe/wasm/vision_wasm_internal.wasm',
  'vendor/mediapipe/pose_landmarker_lite.task',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL).then(() => c.addAll(POSE).catch(() => {})))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || Response.error())),
  );
});
