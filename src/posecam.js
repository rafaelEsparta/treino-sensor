// Câmera + MediaPipe Pose Landmarker no navegador. Usado pelo Lab da câmera e
// pelo treino livre. O vídeo é processado no próprio aparelho; nada é enviado.
import { FilesetResolver, PoseLandmarker } from '../vendor/mediapipe/vision_bundle.mjs';
import { BONES, MIN_VISIBILITY, UP_DEFAULT, upFromGravity } from './pose.js';

const WASM_DIR = new URL('../vendor/mediapipe/wasm', import.meta.url).href;
const MODEL = new URL('../vendor/mediapipe/pose_landmarker_lite.task', import.meta.url).href;

let landmarkerPromise = null;

/** Carrega a biblioteca e o modelo uma única vez (tenta GPU, cai para CPU). */
export function loadLandmarker() {
  landmarkerPromise ??= (async () => {
    const fileset = await FilesetResolver.forVisionTasks(WASM_DIR);
    const make = (delegate) =>
      PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL, delegate },
        runningMode: 'VIDEO',
        numPoses: 2, // duas para poder avisar quando há mais de uma pessoa
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
    try {
      return await make('GPU');
    } catch {
      return make('CPU');
    }
  })();
  landmarkerPromise.catch(() => (landmarkerPromise = null));
  return landmarkerPromise;
}

const heightOf = (pose) => {
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of pose) {
    if (p.y < lo) lo = p.y;
    if (p.y > hi) hi = p.y;
  }
  return hi - lo;
};

export class PoseCamera {
  /**
   * @param {HTMLVideoElement} video
   * @param {(frame: {world, image, poses:number, dark:boolean, up:number[], dt:number}) => void} onFrame
   */
  constructor(video, onFrame) {
    this.video = video;
    this.onFrame = onFrame;
    this.running = false;
    this.up = UP_DEFAULT;
    this.dark = false;
    this.fps = 0;
    this.probe = document.createElement('canvas');
    this.probe.width = 16;
    this.probe.height = 12;
    this.onMotion = (e) => {
      const upright = !screen.orientation || screen.orientation.angle === 0;
      this.up = upright ? upFromGravity(e.accelerationIncludingGravity) : UP_DEFAULT;
    };
  }

  async start({ facingMode = 'user' } = {}) {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Este navegador não dá acesso à câmera.');
    const [landmarker, stream] = await Promise.all([
      loadLandmarker(),
      navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode, width: { ideal: 640 }, height: { ideal: 480 } } }),
    ]);
    this.landmarker = landmarker;
    this.stream = stream;
    this.video.srcObject = stream;
    await this.video.play();
    window.addEventListener('devicemotion', this.onMotion);
    this.running = true;
    this.lastT = 0;
    this.lastVideoT = -1;
    this.count = 0;
    this.#schedule();
  }

  stop() {
    this.running = false;
    window.removeEventListener('devicemotion', this.onMotion);
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    this.video.srcObject = null;
  }

  #schedule() {
    if (!this.running) return;
    const next = () => {
      this.#process();
      this.#schedule();
    };
    if (this.video.requestVideoFrameCallback) this.video.requestVideoFrameCallback(next);
    else requestAnimationFrame(next);
  }

  #process() {
    const { video } = this;
    if (!this.running || video.readyState < 2 || video.currentTime === this.lastVideoT) return;
    this.lastVideoT = video.currentTime;
    const now = performance.now();
    const dt = this.lastT ? Math.min(0.25, Math.max(0.005, (now - this.lastT) / 1000)) : 1 / 30;
    this.lastT = now;
    this.fps += 0.1 * (1 / dt - this.fps);

    if (this.count++ % 15 === 0) this.#measureLight();
    let result;
    try {
      result = this.landmarker.detectForVideo(video, now);
    } catch {
      return;
    }
    const all = result.landmarks ?? [];
    let best = -1;
    let bestH = 0;
    all.forEach((pose, i) => {
      const h = heightOf(pose);
      if (h > bestH) {
        bestH = h;
        best = i;
      }
    });
    // Só conta como "outra pessoa" quem aparece com tamanho parecido.
    const poses = all.filter((pose) => heightOf(pose) >= 0.5 * bestH).length;
    this.onFrame({
      world: best >= 0 ? result.worldLandmarks[best] : null,
      image: best >= 0 ? all[best] : null,
      poses,
      dark: this.dark,
      up: this.up,
      dt,
    });
  }

  #measureLight() {
    try {
      const ctx = this.probe.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(this.video, 0, 0, 16, 12);
      const { data } = ctx.getImageData(0, 0, 16, 12);
      let sum = 0;
      for (let i = 0; i < data.length; i += 4) sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      this.dark = sum / (data.length / 4) < 35;
    } catch {
      this.dark = false;
    }
  }
}

/** Desenha o esqueleto sobre um canvas do tamanho do vídeo. */
export function drawSkeleton(canvas, image, color = '#a3e635') {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!image) return;
  const w = canvas.width;
  const h = canvas.height;
  const seen = (i) => (image[i].visibility ?? 1) >= MIN_VISIBILITY;
  ctx.lineWidth = Math.max(2, w / 160);
  ctx.lineCap = 'round';
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  for (const [a, b] of BONES) {
    if (!seen(a) || !seen(b)) continue;
    ctx.beginPath();
    ctx.moveTo(image[a].x * w, image[a].y * h);
    ctx.lineTo(image[b].x * w, image[b].y * h);
    ctx.stroke();
  }
  for (const i of [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]) {
    if (!seen(i)) continue;
    ctx.beginPath();
    ctx.arc(image[i].x * w, image[i].y * h, Math.max(3, w / 110), 0, 2 * Math.PI);
    ctx.fill();
  }
}
